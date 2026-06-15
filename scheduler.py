#!/usr/bin/env python3
"""
네이버 광고 스케줄러
- 새벽 01:00 → 광고 OFF (캠페인 userLock=True)
- 아침 07:00 → 광고 ON + 스마트 입찰가 최적화
- PM2 cron으로 매시 실행, 1시/7시만 동작
"""
import hashlib, hmac, base64, time, requests, json, sqlite3, os, sys
from datetime import datetime

# ── 인증 ──────────────────────────────────────────────────────────────────
AL   = "0100000000e8a9e5c719ef2ea8318c370686c95f2e7a575fd22e8075980031db54654aa701"
SK   = "AQAAAADoqeXHGe8uqDGMNwaGyV8ub0ko3GK/zB5aWTFEsaWJMw=="
CID  = "4412351"
BASE = "https://api.naver.com"

DB_PATH  = "/home/user/webapp/data/naver_ad.db"
LOG_PATH = "/home/user/webapp/data/scheduler.log"

# ── 대상 캠페인 IDs (파워링크#1만) ─────────────────────────────────────────
TARGET_CAMPAIGNS = [
    "cmp-a001-01-000000010736912",  # 파워링크#1
]

# ── 월 예산 / 입찰 설정 ────────────────────────────────────────────────────
MONTHLY_BUDGET = 500_000
DAILY_BUDGET   = 20000   # 2024-06-15 API 직접 변경 완료 (20,000원 고정)
MIN_BID = 70
MAX_BID = 1000

# ── 제외 키워드 (청소 계열 완전 제거) ──────────────────────────────────────
EXCLUDE_KEYWORDS = {
    "에어컨청소", "삼성에어컨청소", "벽걸이에어컨셀프청소",
    "에어컨분해청소", "에바크리닝", "에어컨청소비용",
}
# ── 검색량 기반 초기 입찰가 (실적 DB 없을 시 폴백) ──────────────────────────────────────────
INIT_BIDS = {
    # 실제 운영 키워드: 월간검색량 추정, 경쟁도, 초기입찰가(원)
    "에어콘수리":          {"ms": 12000, "comp": "높음", "bid": 270},
    "에어콘가스충전":      {"ms": 8000,  "comp": "높음", "bid": 200},
    "에어콘냉매충전":      {"ms": 5000,  "comp": "높음", "bid": 180},
    "에어콘가스":          {"ms": 4000,  "comp": "높음", "bid": 160},
    "삼성에어콘수리":      {"ms": 3000,  "comp": "높음", "bid": 150},
    "LG에어콘수리":        {"ms": 2500,  "comp": "높음", "bid": 140},
    "에어콘점검":          {"ms": 2000,  "comp": "중간", "bid": 130},
    "에어콘매립배관":        {"ms": 1500,  "comp": "중간", "bid": 120},
    "에어콘매립배관수리":    {"ms": 1200,  "comp": "중간", "bid": 120},
    "에어콘매립배관교체":    {"ms": 900,   "comp": "중간", "bid": 110},
    "에어콘물떨어집":      {"ms": 700,   "comp": "중간", "bid": 100},
}


# ── 로그 ──────────────────────────────────────────────────────────────────
def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")

# ── API 헬퍼 ──────────────────────────────────────────────────────────────
def _sig(ts, method, uri):
    return base64.b64encode(
        hmac.new(SK.encode(), f"{ts}.{method}.{uri}".encode(), hashlib.sha256).digest()
    ).decode()

def _hdrs(ts, method, uri):
    return {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Timestamp":  ts,
        "X-API-KEY":    AL,
        "X-Customer":   CID,
        "X-Signature":  _sig(ts, method, uri),
    }

def api_get(uri, params=None):
    ts = str(int(time.time() * 1000))
    r = requests.get(BASE + uri, headers=_hdrs(ts, "GET", uri),
                     params=params, timeout=15)
    return r.json() if r.status_code == 200 else None

def api_put(uri, body, fields=""):
    ts  = str(int(time.time() * 1000))
    url = BASE + uri + (f"?fields={fields}" if fields else "")
    r   = requests.put(url, headers=_hdrs(ts, "PUT", uri),
                       json=body, timeout=15)
    return r.status_code, (r.json() if r.status_code == 200 else r.text[:200])

# ── DB 초기화 ─────────────────────────────────────────────────────────────
def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.executescript("""
        CREATE TABLE IF NOT EXISTS schedule_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            run_at     TEXT NOT NULL,
            action     TEXT NOT NULL,
            campaign   TEXT,
            success    INTEGER DEFAULT 0,
            detail     TEXT,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE IF NOT EXISTS bid_history (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            run_date       TEXT NOT NULL,
            keyword        TEXT NOT NULL,
            monthly_search INTEGER,
            comp_idx       TEXT,
            avg_depth      REAL,
            old_bid        INTEGER,
            new_bid        INTEGER,
            changed        INTEGER DEFAULT 0,
            reason         TEXT,
            created_at     TEXT DEFAULT (datetime('now','localtime'))
        );
        CREATE TABLE IF NOT EXISTS cost_log (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            log_date       TEXT NOT NULL,
            keyword        TEXT,
            ncc_keyword_id TEXT,
            impressions    INTEGER DEFAULT 0,
            clicks         INTEGER DEFAULT 0,
            actual_cost    INTEGER DEFAULT 0,
            ctr            REAL    DEFAULT 0,
            avg_cpc        INTEGER DEFAULT 0,
            action         TEXT,
            created_at     TEXT DEFAULT (datetime('now','localtime'))
        );
        CREATE INDEX IF NOT EXISTS idx_cost_log_date ON cost_log(log_date);
        CREATE INDEX IF NOT EXISTS idx_cost_log_kw   ON cost_log(keyword);
    """)
    conn.commit()
    conn.close()

def db_log(action, campaign, success, detail=""):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT INTO schedule_log (run_at, action, campaign, success, detail) VALUES (?,?,?,?,?)",
        (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), action, campaign, int(success), detail)
    )
    conn.commit()
    conn.close()

# ══════════════════════════════════════════════════════════════════════════
# STEP A: 광고 OFF (새벽 1시)
# ══════════════════════════════════════════════════════════════════════════
def do_off():
    log("=" * 60)
    log("▶ 광고 OFF 시작 (새벽 1시 → 수면시간 광고 중단)")
    ok_count = 0
    for cid in TARGET_CAMPAIGNS:
        sc, res = api_put(f"/ncc/campaigns/{cid}", {"userLock": True}, "userLock")
        if sc == 200:
            log(f"  ✅ OFF 성공: {cid} → status={res.get('status','?')}")
            db_log("OFF", cid, True, f"status={res.get('status','?')}")
            ok_count += 1
        else:
            log(f"  ❌ OFF 실패: {cid} → {res}")
            db_log("OFF", cid, False, str(res))
        time.sleep(0.3)
    log(f"▶ 광고 OFF 완료: {ok_count}/{len(TARGET_CAMPAIGNS)} 성공")
    return ok_count == len(TARGET_CAMPAIGNS)

# ══════════════════════════════════════════════════════════════════════════
# STEP B: 스마트 입찰가 계산 (청소 제외, 최소비용 최대노출)
# ══════════════════════════════════════════════════════════════════════════
def calc_smart_bid(keyword, monthly_search, comp_idx, avg_depth, cur_bid):
    """
    최소비용 최대노출 알고리즘
    - plAvgDepth(현재 평균순위)로 얼마나 입찰가를 올려야 3위 안에 드는지 계산
    - 경쟁도×검색량 기반 기준가 × 순위 보정 계수
    """
    # 기준 입찰가 (경쟁도 × 검색량)
    if comp_idx == "높음":
        if   monthly_search >= 50000: base = 380
        elif monthly_search >= 20000: base = 320
        elif monthly_search >= 10000: base = 260
        elif monthly_search >= 5000:  base = 200
        elif monthly_search >= 2000:  base = 160
        elif monthly_search >= 500:   base = 130
        else:                         base = 110
    elif comp_idx == "중간":
        if   monthly_search >= 20000: base = 190
        elif monthly_search >= 5000:  base = 140
        else:                         base = 100
    else:
        base = 80

    # 순위 보정 (plAvgDepth → 목표: 3위 이내)
    # depth=10 (하위권) → 많이 올려야 / depth=1~3 → 이미 상위, 소폭 절감
    if   avg_depth == 0:   mult = 1.30   # 미노출 → 적극 상승
    elif avg_depth <= 2:   mult = 0.90   # 1~2위: 과비용 방지
    elif avg_depth <= 3:   mult = 1.00   # 3위: 최적 유지
    elif avg_depth <= 5:   mult = 1.10   # 4~5위: 소폭 올리기
    elif avg_depth <= 7:   mult = 1.20   # 6~7위: 올려야
    else:                  mult = 1.35   # 8~10위: 적극 상승

    target = int(base * mult)
    # 10원 단위 반올림 (네이버 입찰가 정책)
    target = round(target / 10) * 10
    target = max(MIN_BID, min(MAX_BID, target))

    # ±10% 이내면 그냥 유지 (불필요한 API 호출 줄이기)
    if abs(target - cur_bid) / max(cur_bid, 1) < 0.10:
        return cur_bid, f"유지(목표:{target}원 ±10%이내)", False

    reason = f"{comp_idx}/검색{monthly_search}/깊이{avg_depth} → base:{base}×{mult:.2f}={target}"
    return target, reason, True

# ══════════════════════════════════════════════════════════════════════════
# STEP C: 광고 ON + 입찰 최적화 (아침 7시)
# ══════════════════════════════════════════════════════════════════════════
def do_on_and_optimize():
    log("=" * 60)
    log("▶ 광고 ON + 스마트 입찰 최적화 시작 (아침 7시)")
    run_date = datetime.now().strftime("%Y-%m-%d")

    # ── 1. 캠페인 ON ───────────────────────────────────────────────────
    log("── 1단계: 캠페인 ON ──")
    on_ok = 0
    for cid in TARGET_CAMPAIGNS:
        sc, res = api_put(f"/ncc/campaigns/{cid}", {"userLock": False}, "userLock")
        if sc == 200:
            log(f"  ✅ ON 성공: {cid} → status={res.get('status','?')}")
            db_log("ON", cid, True, f"status={res.get('status','?')}")
            on_ok += 1
        else:
            log(f"  ❌ ON 실패: {cid} → {res}")
            db_log("ON", cid, False, str(res))
        time.sleep(0.3)

    # ── 2. 키워드 조회 ─────────────────────────────────────────────────
    log("── 2단계: 키워드 조회 ──")
    adgroups = api_get("/ncc/adgroups")
    if not adgroups:
        log("  ❌ 광고그룹 조회 실패")
        return False

    all_kws = []
    for ag in adgroups:
        kws = api_get("/ncc/keywords", {"nccAdgroupId": ag["nccAdgroupId"]})
        if kws:
            for kw in kws:
                kw["_agId"] = ag["nccAdgroupId"]
            all_kws.extend(kws)
        time.sleep(0.2)

    # 청소 키워드 제외
    before = len(all_kws)
    all_kws = [k for k in all_kws if k.get("keyword", "") not in EXCLUDE_KEYWORDS]
    log(f"  → 총 {before}개 중 청소계열 제외 후 {len(all_kws)}개 최적화 대상")

    # ── 3. 입찰가 계산 (실적 DB 기반 재분석 + INIT_BIDS 폴백) ──
    log("── 3단계: 입찰가 계산 (실적 DB 기반 재분석) ──")

    # 실적 DB에서 7일 데이터 로드 (keyword → avg_cpc, impressions, clicks)
    conn_r = sqlite3.connect(DB_PATH)
    perf_rows = conn_r.execute(
        "SELECT keyword, AVG(avg_cpc), SUM(impressions), SUM(clicks) "
        "FROM cost_log WHERE log_date >= date('now','-7 days') GROUP BY keyword"
    ).fetchall()
    conn_r.close()
    perf_db = {}
    for row in perf_rows:
        kw_n, avg_cpc_7d, imp_7d, clk_7d = row
        perf_db[kw_n] = {
            "avg_cpc_7d": int(avg_cpc_7d or 0),
            "imp_7d":     int(imp_7d or 0),
            "clk_7d":     int(clk_7d or 0),
        }
    log(f"  → 실적 DB: {len(perf_db)}개 키워드 데이터 로드")

    results = []
    total_daily_est = 0

    for kw in all_kws:
        kw_name = kw.get("keyword", "")
        kw_id   = kw.get("nccKeywordId", "")
        ag_id   = kw.get("_agId", "")
        cur_bid = kw.get("bidAmt", 70)

        # 실적 DB 있으면 avg_cpc 기반으로 재최적화, 없으면 INIT_BIDS 폴백
        perf = perf_db.get(kw_name)
        if perf and perf["imp_7d"] >= 10:
            # 실적 있음: avg_cpc 7일 평균 기반으로 입찰가 재최적화
            base_cpc = perf["avg_cpc_7d"]
            ctr_7d   = perf["clk_7d"] / perf["imp_7d"] * 100 if perf["imp_7d"] > 0 else 0
            if base_cpc < MIN_BID:
                new_bid = MIN_BID
                reason  = f"실적CPC={base_cpc}원(저점)→MIN{MIN_BID}"
            elif base_cpc <= 200:
                if ctr_7d >= 3.0:
                    new_bid = max(MIN_BID, round(base_cpc / 10) * 10)
                    reason  = f"실적CPC={base_cpc},CTR={ctr_7d:.1f}%→유지"
                else:
                    raw     = max(MIN_BID, int(base_cpc * 0.90))
                    new_bid = max(MIN_BID, round(raw / 10) * 10)
                    reason  = f"실적CPC={base_cpc},CTR={ctr_7d:.1f}%→저CTR10%삭감"
            else:
                raw     = max(MIN_BID, int(base_cpc * 0.95))
                new_bid = max(MIN_BID, round(raw / 10) * 10)
                reason  = f"실적CPC={base_cpc}원→고CPC5%삭감"
            changed  = new_bid != cur_bid
            ms, comp, depth = 500, "중간", 5.0
        else:
            # 실적 없음: INIT_BIDS 폴백 → calc_smart_bid 호출
            init     = INIT_BIDS.get(kw_name, {"ms": 500, "comp": "중간", "bid": 100})
            ms, comp = init["ms"], init["comp"]
            depth    = 5.0
            new_bid, reason, changed = calc_smart_bid(kw_name, ms, comp, depth, cur_bid)
            # INIT_BID가 현재와 다르고 변경 안된 경우 INIT_BID로 강제
            if not changed and cur_bid != init["bid"]:
                raw     = init["bid"]
                new_bid = max(MIN_BID, min(MAX_BID, round(raw / 10) * 10))
                changed = new_bid != cur_bid
                reason  = f"INIT_BID={init['bid']}원(실적없음폴백)"

        daily_est = int(ms * 0.03 * new_bid / 30)
        total_daily_est += daily_est

        results.append({
            "keyword": kw_name, "kw_id": kw_id, "ag_id": ag_id,
            "ms": ms, "comp": comp, "depth": depth,
            "old_bid": cur_bid, "new_bid": new_bid,
            "changed": changed, "reason": reason,
            "daily_est": daily_est,
        })
        log(f"  [{kw_name}] {cur_bid}→{new_bid}원 | {reason[:60]}")

    # ── 4. 일 예산 초과 시 전체 축소 ──────────────────────────────────
    log(f"── 4단계: 예산 체크 (예상 {total_daily_est:,}원 / 한도 {DAILY_BUDGET:,}원) ──")
    if total_daily_est > DAILY_BUDGET:
        ratio = DAILY_BUDGET / total_daily_est
        log(f"  ⚠️ 예산 초과! {ratio:.0%}로 전체 축소")
        for r in results:
            # 10원 단위 반올림 (네이버 정책)
            raw = max(MIN_BID, int(r["new_bid"] * ratio))
            r["new_bid"]  = max(MIN_BID, round(raw / 10) * 10)
            r["changed"]  = r["new_bid"] != r["old_bid"]
            r["reason"]  += f" [예산캡×{ratio:.2f}]"
        total_daily_est = int(total_daily_est * ratio)
    else:
        log(f"  ✅ 예산 여유 있음")

    # ── 5. 변경된 것만 PUT (API 크레딧 최소화) ───────────────────────
    log("── 5단계: 변경 키워드만 입찰가 적용 ──")
    to_change = [r for r in results if r["changed"]]
    log(f"  변경 대상: {len(to_change)}개 / 유지: {len(results)-len(to_change)}개")

    apply_ok = apply_fail = 0
    for r in to_change:
        uri = f"/ncc/keywords/{r['kw_id']}"
        sc, res = api_put(
            uri,
            {"nccAdgroupId": r["ag_id"], "useGroupBidAmt": False, "bidAmt": r["new_bid"]},
            "nccAdgroupId,useGroupBidAmt,bidAmt"
        )
        if sc == 200:
            apply_ok += 1
            log(f"  ✅ {r['keyword']}: {r['old_bid']}→{r['new_bid']}원")
        else:
            apply_fail += 1
            log(f"  ❌ {r['keyword']}: 실패 [{sc}] {res}")
        time.sleep(0.2)

    # ── 6. 실제 비용 조회 (GET /stats — 올바른 엔드포인트, 크레딧 1회) ──
    log("── 6단계: 실제 비용 조회 (GET /stats 1회 호출) ──")
    stats_map = {}  # keyword_id → stats dict
    try:
        from datetime import timedelta
        yesterday  = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        kw_ids = [r["kw_id"] for r in results if r["kw_id"]]
        if kw_ids:
            # 올바른 엔드포인트: GET /stats (POST /ncc/stats 는 404)
            uri_s  = "/stats"
            import urllib.parse, json as _json
            params = urllib.parse.urlencode({
                "ids":       ",".join(kw_ids),
                "fields":    '["impCnt","clkCnt","salesAmt"]',
                "timeRange": _json.dumps({"since": yesterday, "until": yesterday}),
                "timeUnit":  "DAY",
            })
            ts_s = str(int(time.time() * 1000))
            r_s = requests.get(
                BASE + uri_s + "?" + params,
                headers=_hdrs(ts_s, "GET", uri_s),
                timeout=20,
            )
            if r_s.status_code == 200:
                sdata = r_s.json()
                for item in (sdata.get("data") or []):
                    kw_id_s = item.get("id", "")
                    st = item.get("statData") or item.get("stat") or {}
                    stats_map[kw_id_s] = {
                        "impressions": int(st.get("impCnt",   0) or 0),
                        "clicks":      int(st.get("clkCnt",   0) or 0),
                        "actual_cost": int(st.get("salesAmt", 0) or 0),
                    }
                log(f"  ✅ stats 조회 성공: {len(stats_map)}개 키워드")
            else:
                log(f"  ⚠️ stats API [{r_s.status_code}]: {r_s.text[:200]}")
        else:
            log("  → 조회 대상 키워드 없음")
    except Exception as e:
        log(f"  ⚠️ stats 조회 예외: {e}")

    # ── 7. DB 저장 (입찰이력 + 실제비용) ──────────────────────────────
    log("── 7단계: DB 저장 ──")
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    for r in results:
        c.execute(
            "INSERT INTO bid_history (run_date,keyword,monthly_search,comp_idx,avg_depth,old_bid,new_bid,changed,reason) VALUES (?,?,?,?,?,?,?,?,?)",
            (run_date, r["keyword"], r["ms"], r["comp"], r["depth"],
             r["old_bid"], r["new_bid"], int(r["changed"]), r["reason"])
        )
        # 실제 비용 저장 (stats 있으면 실제값, 없으면 0으로 저장해 날짜 기록 유지)
        st = stats_map.get(r["kw_id"], {})
        imp  = st.get("impressions", 0)
        clk  = st.get("clicks",      0)
        cost = st.get("actual_cost", 0)
        ctr  = round(clk / imp * 100, 2) if imp > 0 else 0.0
        acpc = round(cost / clk) if clk > 0 else 0
        c.execute(
            """INSERT OR REPLACE INTO cost_log
               (log_date,keyword,ncc_keyword_id,impressions,clicks,actual_cost,ctr,avg_cpc,action)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (run_date, r["keyword"], r["kw_id"],
             imp, clk, cost, ctr, acpc,
             "ACTUAL" if stats_map.get(r["kw_id"]) else "NO_DATA")
        )
        log(f"  [{r['keyword']}] 노출:{imp:,} 클릭:{clk} 비용:{cost:,}원 CTR:{ctr}%")
    conn.commit()
    conn.close()

    log(f"▶ 완료: ON={on_ok}개 | 입찰변경={apply_ok}성공/{apply_fail}실패 | 예상일비용={total_daily_est:,}원")
    return True

# ══════════════════════════════════════════════════════════════════════════
# 메인: 현재 시각 보고 해당 작업 실행
# ══════════════════════════════════════════════════════════════════════════
def main():
    init_db()
    now_h = datetime.now().hour
    arg   = sys.argv[1] if len(sys.argv) > 1 else None

    # 강제 실행 인자 우선
    if arg == "off":
        do_off()
    elif arg == "on":
        do_on_and_optimize()
    elif arg == "test":
        log("=== 테스트 모드: OFF → 3초 대기 → ON ===")
        do_off()
        time.sleep(3)
        do_on_and_optimize()
    else:
        # 시간 기반 자동 판단
        if now_h == 1:
            log(f"현재 {now_h}시 → 광고 OFF 실행")
            do_off()
        elif now_h == 7:
            log(f"현재 {now_h}시 → 광고 ON + 입찰 최적화 실행")
            do_on_and_optimize()
        else:
            log(f"현재 {now_h}시 → 스케줄 없음 (1시=OFF / 7시=ON+최적화)")

if __name__ == "__main__":
    main()
