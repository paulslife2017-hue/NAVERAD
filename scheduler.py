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
DAILY_BUDGET   = 50000   # 2026-06-16 50,000원으로 상향 (테스트 기간)
MIN_BID = 70
MAX_BID = 1000  # 전체 기본 상한

# 키워드별 개별 MAX_BID (검색량 낙은 키워드는 낙게 설정)
KW_MAX_BID = {
    # 2026-06-16 시세 기반 상한 재설정 (estimate API 확인)
    "에어컨수리":          5000,
    "에어컨가스충전":      5000,
    "에어컨냉매충전":      3000,
    "에어컨가스":          3000,
    "삼성에어컨수리":      2000,
    "LG에어컨수리":        2000,
    "에어컨점검":          1500,
    "에어컨매립배관":      1500,
    "에어컨매립배관수리":  1500,
    "에어컨매립배관교체":  1000,
    "에어컨물떨어짐":      2000,
    # 2026-06-16 신규 틈새 키워드 (estimate API 기반)
    "에어컨냉매":          2000,   # 500원→1,701회
    "에어컨실외기소음":    2000,   # 500원→1,865회
    "에어컨전기세":        2000,   # 700원→1,153회
    "에어컨냉매가스":      1000,   # 500원→187회
    "에어컨얼음":          1000,   # 500원→155회
    "에어컨성에":           700,   # 300원→80회
    "대우에어컨수리":       700,   # 300원→188회
    "위니아에어컨수리":     700,   # 300원→99회
}

# 하루 상향 횟수 제한 (2회 초과 시 그날 더 이상 안 올림)
CHECK_MAX_UP_PER_DAY = 2

# ── 제외 키워드 (청소 계열 완전 제거) ──────────────────────────────────────
EXCLUDE_KEYWORDS = {
    "에어컨청소", "삼성에어컨청소", "벽걸이에어컨셀프청소",
    "에어컨분해청소", "에바크리닝", "에어컨청소비용",
}
# ── 검색량 기반 초기 입찰가 (실적 DB 없을 시 폴백) ──────────────────────────────────────────
INIT_BIDS = {
    # 2026-06-16 estimate API 기반 재설정 — 노출 1,000회+ 기준 시작점
    # (스윗스팟 탐색 시 하한선 역할: 이 이하로는 내려가지 않음)
    # 에어컨수리: 700원→1,415회 ✅
    "에어컨수리":          {"ms": 12000, "comp": "높음", "bid": 700},
    # 에어컨가스충전: 700원→1,064회 ✅
    "에어컨가스충전":      {"ms": 8000,  "comp": "높음", "bid": 700},
    # 에어컨냉매충전: 700원→649회, 1000원→1,707회 → 1,000원
    "에어컨냉매충전":      {"ms": 5000,  "comp": "높음", "bid": 1000},
    # 에어컨가스: 700원→1,138회 ✅
    "에어컨가스":          {"ms": 4000,  "comp": "높음", "bid": 700},
    # 삼성에어컨수리: 2000원→671회, 3000원→1,072회 → 일단 2,000원으로 노출 확보
    "삼성에어컨수리":      {"ms": 3000,  "comp": "높음", "bid": 2000},
    # LG에어컨수리: 2000원→509회, 3000원→906회 → 2,000원으로 노출 확보
    "LG에어컨수리":        {"ms": 2500,  "comp": "높음", "bid": 2000},
    # 에어컨점검: 2000원→657회, 3000원→764회 → 2,000원으로 노출 확보
    "에어컨점검":          {"ms": 2000,  "comp": "중간", "bid": 2000},
    # 에어컨매립배관: 700원→1,259회 ✅
    "에어컨매립배관":      {"ms": 1500,  "comp": "중간", "bid": 700},
    # 에어컨매립배관수리: 1500원→670회, 2000원→826회 → 1,500원
    "에어컨매립배관수리":  {"ms": 1200,  "comp": "중간", "bid": 1500},
    # 에어컨매립배관교체: 3000원→582회 → 3,000원 (최대 노출)
    "에어컨매립배관교체":  {"ms": 900,   "comp": "중간", "bid": 3000},
    # 에어컨물떨어짐: 700원→1,727회 ✅
    "에어컨물떨어짐":      {"ms": 700,   "comp": "중간", "bid": 700},
    # 2026-06-16 신규 틈새 키워드
    "에어컨냉매":          {"ms": 5000,  "comp": "낮음", "bid": 500},   # 500원→1,701회
    "에어컨실외기소음":    {"ms": 3000,  "comp": "낮음", "bid": 500},   # 500원→1,865회
    "에어컨전기세":        {"ms": 2000,  "comp": "낮음", "bid": 700},   # 700원→1,153회
    "에어컨냉매가스":      {"ms": 1000,  "comp": "낮음", "bid": 500},   # 500원→187회
    "에어컨얼음":          {"ms": 800,   "comp": "낮음", "bid": 500},   # 500원→155회
    "에어컨성에":          {"ms": 600,   "comp": "낮음", "bid": 300},   # 300원→80회
    "대우에어컨수리":      {"ms": 500,   "comp": "낮음", "bid": 300},   # 300원→188회
    "위니아에어컨수리":    {"ms": 400,   "comp": "낮음", "bid": 300},   # 300원→99회
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

# ── 대시보드 이력 기록 (Workers in-memory에 POST) ─────────────────────────
DASHBOARD_URL = "http://localhost:3000"

def push_history(keyword, old_bid, new_bid, reason):
    """입찰가 변경 성공 시 대시보드 in-memory 이력에 기록 (실패해도 무시)"""
    try:
        requests.post(
            f"{DASHBOARD_URL}/api/history-write",
            json={
                "keyword":   keyword,
                "oldBid":    old_bid,
                "newBid":    new_bid,
                "reason":    reason,
                "changedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            },
            timeout=3,
        )
    except Exception:
        pass  # 대시보드가 꺼져있어도 스케줄러 동작에 영향 없음

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
            # 실적 없음(imp_7d < 10): INIT_BIDS의 bid 값으로 직접 설정
            # calc_smart_bid 호출 시 avg_depth=5.0 기준으로 지나치게 낮게 산출되는 문제 방지
            init     = INIT_BIDS.get(kw_name, {"ms": 500, "comp": "중간", "bid": 100})
            ms, comp = init["ms"], init["comp"]
            depth    = 5.0
            kw_max   = KW_MAX_BID.get(kw_name, MAX_BID)
            target   = min(kw_max, max(MIN_BID, init["bid"]))
            new_bid  = round(target / 10) * 10
            changed  = new_bid != cur_bid
            reason   = f"실적없음→INIT_BID={init['bid']}원"

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
            push_history(r["keyword"], r["old_bid"], r["new_bid"], r["reason"])
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
# ════════════════════════════════════════════════════════════════════════════
# STEP D: 2시간 점검 (노출 확인 + 입찰가 실시간 조정)
# ════════════════════════════════════════════════════════════════════════════
def do_check():
    """
    2시간마다 실행 (KST 09~23시)
    크레딧: 키워드 조회 API 2회 + 캐페인 1회 (오늘소진확인)
    로직:
      ① 오늘 소진액 실시간 확인 (totalChargeCost) → 90% 초과시 전체 10% 삭감
      ② CTR 저조 키워드 (전낡데이터 로드, 전낡 imp≥10 + CTR<1%) → 10% 삭감
      ③ 전낡 imp=0 이고 오늘 상향 횟수 < 한도 → 15% 상향 (KW_MAX_BID 상한)
      ④ 입찰가 < INIT_BID → INIT_BID 복원
    """
    log("=" * 60)
    log(f"▶ 2시간 점검 시작 ({datetime.now().strftime('%H:%M')})")
    run_date  = datetime.now().strftime("%Y-%m-%d")
    from datetime import timedelta
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

    # ── 1. 키워드 실시간 조회 ──────────────────────────────────────────────
    adgroups = api_get("/ncc/adgroups")
    if not adgroups:
        log("  ❌ 광고그룹 조회 실패 → 점검 중단")
        return False

    all_kws = []
    for ag in adgroups:
        kws = api_get("/ncc/keywords", {"nccAdgroupId": ag["nccAdgroupId"]})
        if kws:
            for kw in kws: kw["_agId"] = ag["nccAdgroupId"]
            all_kws.extend(kws)
        time.sleep(0.2)
    all_kws = [k for k in all_kws if k.get("keyword","") not in EXCLUDE_KEYWORDS]
    log(f"  → 운영 키워드 {len(all_kws)}개 조회")

    # ── 2. 오늘 소진액 실시간 확인 (campaignAPI 1회) ──────────────────────
    camp_data = api_get(f"/ncc/campaigns/{TARGET_CAMPAIGNS[0]}")
    today_used = int((camp_data or {}).get("totalChargeCost", 0) or 0)
    today_pct  = today_used / DAILY_BUDGET * 100 if DAILY_BUDGET > 0 else 0
    budget_critical = today_pct >= 90   # 90% 이상 → 전체 삭감
    log(f"  → 오늘소진={today_used:,}원 ({today_pct:.0f}%) {'[⚠️90%초과!전체삭감]' if budget_critical else '[OK]'}")

    # ── 3. 전낡 실적 DB 로드 ────────────────────────────────────────────────────
    conn_r = sqlite3.connect(DB_PATH)
    yest_rows = conn_r.execute(
        "SELECT keyword, impressions, clicks, actual_cost FROM cost_log WHERE log_date=?",
        (yesterday,)
    ).fetchall()
    # 오늘 상향 횟수 카운트 (schedule_log CHECK 중 실제 상향된 것만)
    up_counts = {}
    for row in conn_r.execute(
        "SELECT campaign, COUNT(*) FROM schedule_log "
        "WHERE action='CHECK' AND success=1 AND detail LIKE '%상향%' "
        "AND run_at >= ? GROUP BY campaign",
        (run_date + " 00:00:00",)
    ).fetchall():
        up_counts[row[0]] = row[1]
    conn_r.close()

    yest_db = {r[0]: {"imp":r[1],"clk":r[2],"cost":r[3]} for r in yest_rows}
    # has_yest = 전날 실제 노출이 1건이라도 있었는지 (imp=0만 있으면 False)
    has_yest = any(v["imp"] > 0 for v in yest_db.values())
    total_yest_imp = sum(v["imp"] for v in yest_db.values())
    log(f"  → 전날 DB: {len(yest_db)}건 (실노출키워드: {sum(1 for v in yest_db.values() if v['imp']>0)}개 | 총imp={total_yest_imp:,})")
    log(f"  → 오늘 상향횟수: {dict(list(up_counts.items())[:4])}")

    # ── 실적 없으면 자동 조정 스킵 (노출 0인 날 반복 상향 방지) ────────────
    if not has_yest and not budget_critical:
        log("  ℹ️  전날 실노출 없음 → 자동 조정 스킵 (현재 입찰가 유지, 데이터 축적 대기)")
        return True

    # ── 4. 키워드별 판단 ───────────────────────────────────────────────────────────
    to_change = []
    for kw in all_kws:
        name     = kw.get("keyword","")
        kw_id    = kw.get("nccKeywordId","")
        ag_id    = kw.get("_agId","")
        cur_bid  = kw.get("bidAmt", 70)
        status   = kw.get("status","")
        init_bid = INIT_BIDS.get(name, {}).get("bid", 100)
        kw_max   = KW_MAX_BID.get(name, MAX_BID)   # 키워드별 상한

        if status != "ELIGIBLE":
            log(f"  [{name}] {status} → 스킵")
            continue

        yest      = yest_db.get(name, {})
        yest_imp  = yest.get("imp", 0)
        yest_clk  = yest.get("clk", 0)
        yest_ctr  = yest_clk / yest_imp * 100 if yest_imp > 0 else None
        up_today  = up_counts.get(name, 0)   # 오늘 상향 횟수

        new_bid = cur_bid
        reason  = ""

        # ── 스윗스팟 탐색 로직 ─────────────────────────────────────────────
        # 목표: 노출은 되면서 비용은 최소인 입찰가 찾기
        #   노출 있음 + CTR 양호(≥1%) → -8% 낮춰보기 (스윗스팟 탐색 하강)
        #   노출 있음 + CTR 저조(<1%) → -10% (광고 품질 낮음, 비용 낭비)
        #   노출 없음                  → +15% 상향 (노출 시작점 탐색 상승)
        #   노출 없음 + 상향 한도      → 유지
        #   예산 90% 초과             → 전체 -10% (비상 제동)

        if budget_critical:
            # ① 예산 90% 초과 → 비상 제동 -10%
            raw     = max(MIN_BID, int(cur_bid * 0.90))
            new_bid = max(MIN_BID, round(raw / 10) * 10)
            reason  = f"예산{today_pct:.0f}%초과→비상제동-10%"

        elif has_yest and yest_imp >= 5 and yest_ctr is not None and yest_ctr >= 1.0:
            # ② 노출 있고 CTR 양호 → 스윗스팟 탐색: -8% 낮춰보기
            raw     = max(init_bid, int(cur_bid * 0.92))
            new_bid = max(init_bid, round(raw / 10) * 10)
            if new_bid == cur_bid:
                new_bid = max(init_bid, cur_bid - 10)
            if new_bid < cur_bid:
                reason = f"노출{yest_imp}CTR{yest_ctr:.1f}%양호→스윗스팟탐색-8%"
            else:
                log(f"  [{name}] 이미 INIT_BID 최저({init_bid}원) → 유지")
                continue

        elif has_yest and yest_imp >= 5 and yest_ctr is not None and yest_ctr < 1.0:
            # ③ 노출 있으나 CTR 저조(<1%) → 품질 낮음, -10%
            raw     = max(MIN_BID, int(cur_bid * 0.90))
            new_bid = max(MIN_BID, round(raw / 10) * 10)
            reason  = f"노출있음CTR{yest_ctr:.1f}%저조→-10%"

        elif yest_imp == 0 and up_today < CHECK_MAX_UP_PER_DAY:
            # ④ 노출 없음 → +15% 상향 탐색
            raw     = min(kw_max, int(cur_bid * 1.15))
            new_bid = min(kw_max, max(MIN_BID, round(raw / 10) * 10))
            if new_bid == cur_bid:
                new_bid = min(kw_max, cur_bid + 10)
            reason  = f"노출없음({('DB없음' if not has_yest else '전날0')})+{up_today}회→+15%"

        elif yest_imp == 0 and up_today >= CHECK_MAX_UP_PER_DAY:
            # 상향 한도 도달
            log(f"  [{name}] 노출없음+오늘{up_today}회상향한도→유지")
            continue

        elif cur_bid < init_bid:
            # ⑤ INIT_BID 아래로 내려가면 복원
            new_bid = min(kw_max, init_bid)
            reason  = f"입찰가({cur_bid})<INIT({init_bid})→복원"

        else:
            log(f"  [{name}] imp={yest_imp} CTR={f'{yest_ctr:.1f}%' if yest_ctr is not None else '-'} bid={cur_bid}원 → 유지")
            continue

        if new_bid != cur_bid:
            to_change.append({
                "name":name, "kw_id":kw_id, "ag_id":ag_id,
                "cur_bid":cur_bid, "new_bid":new_bid, "reason":reason
            })

    log(f"  → 변경 {len(to_change)}개 / 유지 {len(all_kws)-len(to_change)}개")

    # ── 5. PUT 적용 ────────────────────────────────────────────────────────────────
    ok = fail = 0
    for r in to_change:
        uri = f"/ncc/keywords/{r['kw_id']}"
        sc, res = api_put(uri, {"nccAdgroupId":r["ag_id"],"useGroupBidAmt":False,"bidAmt":r["new_bid"]},
                          "nccAdgroupId,useGroupBidAmt,bidAmt")
        tag = "↑" if r["new_bid"] > r["cur_bid"] else "↓"
        if sc == 200:
            log(f"  ✅ [{r['name']}] {r['cur_bid']}{tag}{r['new_bid']}원 | {r['reason']}")
            push_history(r["name"], r["cur_bid"], r["new_bid"], r["reason"])
            ok += 1
        else:
            log(f"  ❌ [{r['name']}] 실패[{sc}]")
            fail += 1
        db_log("CHECK", r["name"], sc==200, r["reason"])
        time.sleep(0.2)

    log(f"▶ 2시간 점검 완료: 변경 {ok}개 / 실패 {fail}개 / 유지 {len(all_kws)-len(to_change)}개")
    return True


# ════════════════════════════════════════════════════════════════════════════
# 메인: 현재 시각 보고 해당 작업 실행
# ════════════════════════════════════════════════════════════════════════════
def main():
    init_db()
    now_h = datetime.now().hour
    now_m = datetime.now().minute
    arg   = sys.argv[1] if len(sys.argv) > 1 else None

    if arg == "off":
        # PM2 cron_restart 오작동 방지: KST 01시(UTC 16시)에만 실행
        # PM2 재시작 시 즉시 실행되므로, 정해진 시각이 아니면 스킵
        if now_h == 1:
            do_off()
        else:
            log(f"[SKIP] off 명령이지만 현재 {now_h}시 (KST 01시에만 실행) → 스킵")
    elif arg == "on":
        # KST 07시에만 실행
        if now_h == 7:
            do_on_and_optimize()
        else:
            log(f"[SKIP] on 명령이지만 현재 {now_h}시 (KST 07시에만 실행) → 스킵")
    elif arg == "check":
        # KST 09~23시에만 실행 (07시 ON 이후, 01시 OFF 이전)
        if 9 <= now_h <= 23:
            do_check()
        else:
            log(f"[SKIP] check 명령이지만 현재 {now_h}시 (KST 09~23시에만 실행) → 스킵")
    elif arg == "test":
        log("=== 테스트 모드: OFF → 3초 → ON ===")
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
        elif 7 <= now_h < 24 or now_h == 0:
            # 07~24시: 2시간 점검 실행
            log(f"현재 {now_h}시 → 2시간 점검 실행")
            do_check()
        else:
            log(f"현재 {now_h}시 → 스케줄 없음 (1시=OFF / 7시=ON+최적화 / 8~24시=2h점검)")

if __name__ == "__main__":
    main()
