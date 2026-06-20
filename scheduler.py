#!/usr/bin/env python3
"""
네이버 광고 스케줄러 v4
[파워링크]
- 새벽 01:00 → 캠페인 OFF
- 아침 07:00 → 캠페인 ON
- 2시간마다(09~23시) → 키워드별 입찰가 조정
  · 그룹 노출 있음 → -10% (INIT_BID 하한)
  · 그룹 노출 없음 → +15% (KW_MAX_BID 상한, 하루 MAX_UP_PER_DAY회)
  · 예산 90%+       → -15% 비상
[플레이스]
- 동일 스케줄 (OFF/ON/2h점검)
- 키워드 없음 → 광고그룹 bidAmt 단일 조정
  · 노출 있음 → -10% (PLACE_MIN_BID 하한)
  · 노출 없음 → +20% (PLACE_MAX_BID 상한, 하루 MAX_UP_PER_DAY회)
  · 예산 90%+ → -15% 비상
"""
import hashlib, hmac, base64, time, requests, json, sqlite3, os, sys, urllib.parse
from datetime import datetime, timedelta

# ── 인증 ──────────────────────────────────────────────────────────────────
AL   = "0100000000e8a9e5c719ef2ea8318c370686c95f2e7a575fd22e8075980031db54654aa701"
SK   = "AQAAAADoqeXHGe8uqDGMNwaGyV8ub0ko3GK/zB5aWTFEsaWJMw=="
CID  = "4412351"
BASE = "https://api.naver.com"

DB_PATH  = "/home/user/webapp/data/naver_ad.db"
LOG_PATH = "/home/user/webapp/data/scheduler.log"

# ── 파워링크 캠페인 ───────────────────────────────────────────────────────
PL_CAMPAIGN_IDS = ["cmp-a001-01-000000010736912"]   # 파워링크#1
TARGET_CAMPAIGNS = PL_CAMPAIGN_IDS  # 하위 호환

# ── 플레이스 캠페인/그룹 ──────────────────────────────────────────────────
PLACE_CAMPAIGN_ID = "cmp-a001-06-000000010731200"
PLACE_AG_ID       = "grp-a001-06-000000068627534"
PLACE_DAILY_BUDGET = 10_000   # 플레이스 일 예산
PLACE_MIN_BID      = 70       # 플레이스 하한
PLACE_MAX_BID      = 3_000    # 플레이스 상한
PLACE_INIT_BID     = 300      # 플레이스 기본 시작 입찰가

# ── 파워링크 예산/입찰 설정 ────────────────────────────────────────────────
DAILY_BUDGET = 50_000
MIN_BID      = 70
MAX_BID      = 1_000   # 기본 상한 (키워드별 KW_MAX_BID 우선)

# 2시간 점검에서 하루 최대 상향 횟수
MAX_UP_PER_DAY = 3

# ── 제외 키워드 ────────────────────────────────────────────────────────────
EXCLUDE_KEYWORDS = {
    "에어컨청소", "삼성에어컨청소", "벽걸이에어컨셀프청소",
    "에어컨분해청소", "에바크리닝", "에어컨청소비용",
}

# ── 파워링크 광고그룹 ID (퀵스타트만 운영 / 수리_틈새키워드 2026-06-20 통합 후 PAUSED)
QS_GROUP_ID = "grp-a001-01-000000068725999"   # 퀵스타트
# SS_GROUP_ID = "grp-a001-01-000000068811884"  # 수리_틈새키워드 (PAUSED, 운영 제외)

# ── 키워드별 상한 입찰가 (2026-06-20 수리_틈새 통합 반영)
# ─ 수리_틈새의 높은 입찰가 기준으로 전면 재조정 ─────────────────────────────
KW_MAX_BID = {
    "에어컨수리":           5000,
    "에어컨가스충전":       5000,
    "에어컨냉매충전":       3000,
    "에어컨가스":           3000,
    "삼성에어컨수리":       2000,
    "LG에어컨수리":         2000,
    "에어컨점검":           2000,   # 수리_틈새 기준 (2000)
    "에어컨매립배관":       1500,
    "에어컨매립배관수리":   1500,
    "에어컨매립배관교체":   3000,   # 수리_틈새 기준 (3000)
    "에어컨물떨어짐":       2000,
    "에어컨냉매":           5000,
    "에어컨실외기소음":     5000,
    "에어컨전기세":         5000,
    "에어컨냉매가스":       3000,
    "에어컨얼음":           1000,
    "에어컨성에":            700,
    "대우에어컨수리":        700,
    "위니아에어컨수리":      700,
    "에어컨실외기안돌아감": 2000,
    "에어컨소음":           3000,
    "실외기소음":           3000,
    "에어컨안켜짐":         2000,
    "에어컨드레인":         2000,
    "에어컨고장":           5000,
    "에어컨가스충전비용":   5000,
    "에어컨바람안나옴":     1000,
    "에어컨물":             3000,
    "창문형에어컨수리":      500,
    "에어컨시원하지않음":    500,
    "에어컨전원안켜짐":      500,
    "실외기고장":           3000,
}

# ── 키워드별 하한 입찰가 (노출 없어도 이 이하로는 안 내림) ────────────────
# INIT_BIDS: "최소한 노출 시작되는 입찰가" 기준점
INIT_BIDS = {
    "에어컨수리":           700,
    "에어컨가스충전":       700,
    "에어컨냉매충전":      1000,
    "에어컨가스":           700,
    "삼성에어컨수리":      2000,
    "LG에어컨수리":        2000,
    "에어컨점검":          2000,
    "에어컨매립배관":       700,
    "에어컨매립배관수리":  1500,
    "에어컨매립배관교체":  3000,
    "에어컨물떨어짐":       700,
    "에어컨냉매":           700,
    "에어컨실외기소음":     700,
    "에어컨전기세":        1000,
    "에어컨냉매가스":      1500,
    "에어컨얼음":           500,
    "에어컨성에":           300,
    "대우에어컨수리":       300,
    "위니아에어컨수리":     300,
    "에어컨실외기안돌아감": 500,
    "에어컨소음":          1000,
    "실외기소음":           700,
    "에어컨안켜짐":         700,
    "에어컨드레인":         700,
    "에어컨고장":          1500,
    "에어컨가스충전비용":  1000,
    "에어컨바람안나옴":     500,
    "에어컨물":            1500,
    "창문형에어컨수리":     300,
    "에어컨시원하지않음":   300,
    "에어컨전원안켜짐":     300,
    "실외기고장":          2000,
}

# ── 로그 ──────────────────────────────────────────────────────────────────
def log(msg):
    ts   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
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
    r  = requests.get(BASE + uri, headers=_hdrs(ts, "GET", uri),
                      params=params, timeout=15)
    return r.json() if r.status_code == 200 else None

def api_put(uri, body, fields=""):
    ts  = str(int(time.time() * 1000))
    url = BASE + uri + (f"?fields={fields}" if fields else "")
    r   = requests.put(url, headers=_hdrs(ts, "PUT", uri),
                       json=body, timeout=15)
    return r.status_code, (r.json() if r.status_code == 200 else r.text[:200])

# ── 대시보드 이력 기록 ─────────────────────────────────────────────────────
DASHBOARD_URL = "http://localhost:3000"

def push_history(keyword, old_bid, new_bid, reason):
    try:
        requests.post(
            f"{DASHBOARD_URL}/api/history-write",
            json={"keyword": keyword, "oldBid": old_bid, "newBid": new_bid,
                  "reason": reason,
                  "changedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S")},
            timeout=3,
        )
    except Exception:
        pass

# ── DB 초기화 ─────────────────────────────────────────────────────────────
def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript("""
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
        CREATE TABLE IF NOT EXISTS run_log (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            run_at     TEXT NOT NULL,
            action     TEXT NOT NULL,
            detail     TEXT,
            created_at TEXT DEFAULT (datetime('now','localtime'))
        );
        CREATE INDEX IF NOT EXISTS idx_cost_log_date ON cost_log(log_date);
        CREATE INDEX IF NOT EXISTS idx_cost_log_kw   ON cost_log(keyword);
    """)
    conn.commit()
    conn.close()

def db_log(action, campaign, success, detail=""):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT INTO schedule_log (run_at,action,campaign,success,detail) VALUES (?,?,?,?,?)",
        (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), action, campaign, int(success), detail)
    )
    conn.commit()
    conn.close()

# ── 키워드 목록 조회 (광고그룹별) ─────────────────────────────────────────
def fetch_all_keywords():
    adgroups = api_get("/ncc/adgroups")
    if not adgroups:
        log("  ❌ 광고그룹 조회 실패")
        return []
    all_kws = []
    for ag in adgroups:
        # PAUSED 그룹(수리_틈새 포함)은 건너뜀 — 퀵스타트만 운영
        if ag.get("userLock") or ag.get("status") == "PAUSED":
            log(f"  ⏭ [{ag.get('name')}] PAUSED 그룹 스킵")
            continue
        # 파워링크 그룹만 (플레이스는 별도 do_check_place로 처리)
        if ag.get("adgroupType") not in ("WEB_SITE", None):
            continue
        kws = api_get("/ncc/keywords", {"nccAdgroupId": ag["nccAdgroupId"]})
        if kws:
            for kw in kws:
                kw["_agId"] = ag["nccAdgroupId"]
            all_kws.extend(kws)
        time.sleep(0.2)
    # 제외 + 중복 제거 (같은 키워드 여러 그룹 있으면 bidAmt 높은 것 우선)
    kw_map = {}
    for k in all_kws:
        name = k.get("keyword", "")
        if name in EXCLUDE_KEYWORDS:
            continue
        if name not in kw_map or k.get("bidAmt", 0) > kw_map[name].get("bidAmt", 0):
            kw_map[name] = k
    return list(kw_map.values())

# ── stats API: ID 리스트 기준 실적 조회 (DAY, 배치 100개) ─────────────────
def fetch_stats(ids, target_date):
    """
    ID 리스트(광고그룹 또는 키워드)로 stats 조회
    반환: { id: { "imp": N, "clk": N, "cost": N } }
    크레딧: ceil(len(ids)/100)회
    """
    if not ids:
        return {}
    result = {}
    for i in range(0, len(ids), 100):
        batch = ids[i:i+100]
        uri   = "/stats"
        params = urllib.parse.urlencode({
            "ids":       ",".join(batch),
            "fields":    '["impCnt","clkCnt","salesAmt"]',
            "timeRange": json.dumps({"since": target_date, "until": target_date}),
            "timeUnit":  "DAY",
        })
        ts = str(int(time.time() * 1000))
        try:
            r = requests.get(BASE + uri + "?" + params,
                             headers=_hdrs(ts, "GET", uri), timeout=20)
            if r.status_code == 200:
                for item in (r.json().get("data") or []):
                    sid = item.get("id", "")
                    st  = item.get("statData") or item.get("stat") or item
                    result[sid] = {
                        "imp":  int(st.get("impCnt",   0) or 0),
                        "clk":  int(st.get("clkCnt",   0) or 0),
                        "cost": int(st.get("salesAmt", 0) or 0),
                    }
            else:
                log(f"  ⚠️ stats API [{r.status_code}]: {r.text[:100]}")
        except Exception as e:
            log(f"  ⚠️ stats 예외: {e}")
        time.sleep(0.3)
    return result

# ══════════════════════════════════════════════════════════════════════════
# STEP A: 광고 OFF (새벽 1시) — 파워링크 + 플레이스
# ══════════════════════════════════════════════════════════════════════════
def do_off():
    log("=" * 60)
    log("▶ 광고 OFF (새벽 1시) — 파워링크 + 플레이스")

    # [파워링크] 캠페인 OFF
    ok_pl = 0
    for cid in TARGET_CAMPAIGNS:
        sc, res = api_put(f"/ncc/campaigns/{cid}", {"userLock": True}, "userLock")
        if sc == 200:
            log(f"  ✅ [파워링크] OFF 성공: {cid}")
            db_log("OFF", cid, True, f"status={res.get('status','?')}")
            ok_pl += 1
        else:
            log(f"  ❌ [파워링크] OFF 실패: {cid} → {res}")
            db_log("OFF", cid, False, str(res))
        time.sleep(0.3)

    # [플레이스] 캠페인 OFF
    sc, res = api_put(f"/ncc/campaigns/{PLACE_CAMPAIGN_ID}", {"userLock": True}, "userLock")
    if sc == 200:
        log(f"  ✅ [플레이스] OFF 성공: {PLACE_CAMPAIGN_ID}")
        db_log("OFF", PLACE_CAMPAIGN_ID, True, f"status={res.get('status','?')}")
        ok_place = 1
    else:
        log(f"  ❌ [플레이스] OFF 실패: {PLACE_CAMPAIGN_ID} → {res}")
        db_log("OFF", PLACE_CAMPAIGN_ID, False, str(res))
        ok_place = 0
    time.sleep(0.3)

    log(f"▶ OFF 완료: 파워링크 {ok_pl}/{len(TARGET_CAMPAIGNS)} / 플레이스 {ok_place}/1")
    return ok_pl == len(TARGET_CAMPAIGNS) and ok_place == 1

# ══════════════════════════════════════════════════════════════════════════
# STEP B: 광고 ON (아침 7시) — 파워링크 + 플레이스, 입찰가 건드리지 않음
# ══════════════════════════════════════════════════════════════════════════
def do_on():
    log("=" * 60)
    log("▶ 광고 ON (아침 7시) — 파워링크 + 플레이스 | 입찰가는 2시간 점검에서 조정")

    # [파워링크] 캠페인 ON
    ok_pl = 0
    for cid in TARGET_CAMPAIGNS:
        sc, res = api_put(f"/ncc/campaigns/{cid}", {"userLock": False}, "userLock")
        if sc == 200:
            log(f"  ✅ [파워링크] ON 성공: {cid} → status={res.get('status','?')}")
            db_log("ON", cid, True, f"status={res.get('status','?')}")
            ok_pl += 1
        else:
            log(f"  ❌ [파워링크] ON 실패: {cid} → {res}")
            db_log("ON", cid, False, str(res))
        time.sleep(0.3)

    # [플레이스] 캠페인 ON
    sc, res = api_put(f"/ncc/campaigns/{PLACE_CAMPAIGN_ID}", {"userLock": False}, "userLock")
    if sc == 200:
        log(f"  ✅ [플레이스] ON 성공: {PLACE_CAMPAIGN_ID} → status={res.get('status','?')}")
        db_log("ON", PLACE_CAMPAIGN_ID, True, f"status={res.get('status','?')}")
        ok_place = 1
    else:
        log(f"  ❌ [플레이스] ON 실패: {PLACE_CAMPAIGN_ID} → {res}")
        db_log("ON", PLACE_CAMPAIGN_ID, False, str(res))
        ok_place = 0
    time.sleep(0.3)

    log(f"▶ ON 완료: 파워링크 {ok_pl}/{len(TARGET_CAMPAIGNS)} / 플레이스 {ok_place}/1")
    return ok_pl == len(TARGET_CAMPAIGNS) and ok_place == 1

# ══════════════════════════════════════════════════════════════════════════
# STEP C: 2시간 점검 (09~23시) — 키워드별 개별 stats 기반 조정
# 규칙:
#   · 키워드별 오늘 노출 개별 확인 (광고그룹 합산 X)
#   · 노출 있음  → -10% (하한: INIT_BID)
#   · 노출 없음  → +15% (상한: KW_MAX_BID, 하루 MAX_UP_PER_DAY회)
#   · 예산 90%+  → 전체 -15% 비상제동
#   · 변경된 것만 PUT (크레딧 최소화)
# API 호출: 광고그룹 GET + 키워드 GET(그룹수만큼) + 캠페인 GET 1 + stats GET 1 + PUT N
# ══════════════════════════════════════════════════════════════════════════
def do_check():
    log("=" * 60)
    log(f"▶ 2시간 점검 ({datetime.now().strftime('%H:%M')} KST)")

    run_date  = datetime.now().strftime("%Y-%m-%d")
    today_str = run_date

    # ── 1. 키워드 목록 조회 ──────────────────────────────────────────────
    all_kws = fetch_all_keywords()
    if not all_kws:
        log("  ❌ 키워드 조회 실패 → 중단")
        return False
    log(f"  → 키워드 {len(all_kws)}개 조회")

    # ── 2. 오늘 예산 소진 확인 ──────────────────────────────────────────
    camp = api_get(f"/ncc/campaigns/{TARGET_CAMPAIGNS[0]}")
    today_used = int((camp or {}).get("totalChargeCost", 0) or 0)
    today_pct  = today_used / DAILY_BUDGET * 100 if DAILY_BUDGET > 0 else 0
    budget_critical = today_pct >= 90
    log(f"  → 오늘 소진: {today_used:,}원 ({today_pct:.0f}%) {'⚠️ 90% 초과!' if budget_critical else 'OK'}")

    # ── 3. stats API: 키워드 ID별 오늘 실적 (1~2회 호출) ────────────────
    # 키워드 ID + TOTAL은 clk=0 이슈 있으나, 노출(impCnt) 확인에는 문제없음
    # 더 정확하게: 광고그룹 ID + DAY로 조회해서 키워드와 매핑
    # 퀵스타트/틈새 각 그룹별로 따로 조회
    ag_ids = list({k["_agId"] for k in all_kws})
    ag_stats = fetch_stats(ag_ids, today_str)  # { ag_id → {imp,clk,cost} }

    total_imp  = sum(v["imp"]  for v in ag_stats.values())
    total_clk  = sum(v["clk"]  for v in ag_stats.values())
    total_cost = sum(v["cost"] for v in ag_stats.values())
    log(f"  → 오늘 전체: 노출 {total_imp:,}회 / 클릭 {total_clk}회 / 비용 {total_cost:,}원")
    for ag_id, st in ag_stats.items():
        ag_name = next((k.get("_agName", ag_id) for k in all_kws if k["_agId"] == ag_id), ag_id[-8:])
        log(f"     [{ag_id[-8:]}] 노출{st['imp']:,} 클릭{st['clk']} 비용{st['cost']:,}원")

    # ── 4. 오늘 키워드별 상향 횟수 (schedule_log) ───────────────────────
    conn_r = sqlite3.connect(DB_PATH)
    up_rows = conn_r.execute(
        "SELECT campaign, COUNT(*) FROM schedule_log "
        "WHERE action='CHECK_UP' AND run_at >= ? GROUP BY campaign",
        (run_date + " 00:00:00",)
    ).fetchall()
    conn_r.close()
    up_counts = {r[0]: r[1] for r in up_rows}

    up_total = sum(up_counts.values())
    log(f"  → 오늘 상향 현황: 총 {up_total}건 ({dict(list(up_counts.items())[:5])})")

    # ── 5. 키워드별 판단 ─────────────────────────────────────────────────
    # 핵심: 광고그룹 노출이 있어도 해당 키워드가 노출됐는지는 알 수 없음
    # → 노출 있는 그룹 키워드는 "일단 노출됨"으로 보고 조금 내리기
    # → 노출 없는 그룹 키워드는 "노출 안 됨"으로 보고 조금 올리기
    to_change = []
    for kw in all_kws:
        name    = kw.get("keyword", "")
        kw_id   = kw.get("nccKeywordId", "")
        ag_id   = kw.get("_agId", "")
        cur_bid = int(kw.get("bidAmt", MIN_BID))
        status  = kw.get("status", "")

        if status != "ELIGIBLE":
            continue

        init_bid  = INIT_BIDS.get(name, MIN_BID)
        kw_max    = KW_MAX_BID.get(name, MAX_BID)
        ag_imp    = ag_stats.get(ag_id, {}).get("imp", 0)   # 이 키워드가 속한 그룹 노출
        up_today  = up_counts.get(name, 0)

        new_bid = cur_bid
        reason  = ""
        action  = ""

        if budget_critical:
            # ① 예산 90% → -15% 비상
            raw     = int(cur_bid * 0.85)
            new_bid = max(MIN_BID, round(raw / 10) * 10)
            reason  = f"예산{today_pct:.0f}%초과→비상-15%"
            action  = "CHECK_DOWN"

        elif ag_imp > 0:
            # ② 이 그룹에 노출 있음 → 천천히 낮춰서 최저가 탐색
            # 이미 INIT_BID 하한에 닿아 있으면 유지
            if cur_bid <= init_bid:
                log(f"  [{name}] 그룹노출{ag_imp}회, 이미 하한({init_bid}원) → 유지")
                continue
            raw     = int(cur_bid * 0.90)
            new_bid = max(init_bid, round(raw / 10) * 10)
            if new_bid >= cur_bid:
                new_bid = max(init_bid, cur_bid - 10)
            if new_bid >= cur_bid:
                log(f"  [{name}] 그룹노출{ag_imp}회, 하한({init_bid}원) → 유지")
                continue
            reason = f"그룹노출{ag_imp}회→-10%(하한{init_bid}원)"
            action = "CHECK_DOWN"

        elif ag_imp == 0 and up_today < MAX_UP_PER_DAY:
            # ③ 이 그룹 노출 없음 → 올려서 탐색
            if cur_bid >= kw_max:
                log(f"  [{name}] 그룹노출0, 이미 상한({kw_max}원) → 유지")
                continue
            raw     = int(cur_bid * 1.15)
            new_bid = min(kw_max, max(MIN_BID, round(raw / 10) * 10))
            if new_bid <= cur_bid:
                new_bid = min(kw_max, cur_bid + 10)
            reason = f"그룹노출0→+15%({up_today+1}번째,상한{kw_max}원)"
            action = "CHECK_UP"

        elif ag_imp == 0 and up_today >= MAX_UP_PER_DAY:
            log(f"  [{name}] 그룹노출0, 오늘 상향 {up_today}회 한도 → 유지")
            continue

        else:
            log(f"  [{name}] 그룹노출{ag_imp}회 bid={cur_bid}원 → 유지")
            continue

        if new_bid != cur_bid:
            to_change.append({
                "name": name, "kw_id": kw_id, "ag_id": ag_id,
                "cur_bid": cur_bid, "new_bid": new_bid,
                "reason": reason, "action": action,
            })

    log(f"  → 변경 {len(to_change)}개 / 유지 {len(all_kws)-len(to_change)}개")

    # ── 6. 변경된 것만 PUT ───────────────────────────────────────────────
    ok = fail = 0
    for r in to_change:
        uri = f"/ncc/keywords/{r['kw_id']}"
        sc, res = api_put(
            uri,
            {"nccAdgroupId": r["ag_id"], "useGroupBidAmt": False, "bidAmt": r["new_bid"]},
            "nccAdgroupId,useGroupBidAmt,bidAmt",
        )
        tag = "↑" if r["new_bid"] > r["cur_bid"] else "↓"
        if sc == 200:
            log(f"  ✅ [{r['name']}] {r['cur_bid']}{tag}{r['new_bid']}원 | {r['reason']}")
            push_history(r["name"], r["cur_bid"], r["new_bid"], r["reason"])
            db_log(r["action"], r["name"], True, r["reason"])
            ok += 1
        else:
            log(f"  ❌ [{r['name']}] 실패[{sc}] {res[:80]}")
            fail += 1
        time.sleep(0.2)

    log(f"▶ 점검 완료: 변경{ok}개↑↓ / 실패{fail}개 / 유지{len(all_kws)-len(to_change)}개 | 오늘{today_used:,}원/{DAILY_BUDGET:,}원")
    return True

# ══════════════════════════════════════════════════════════════════════════
# STEP D: 플레이스 2시간 점검 — 광고그룹 bidAmt 단일 조정
# 규칙:
#   · 오늘 노출 있음  → -10% (하한: PLACE_MIN_BID)
#   · 오늘 노출 없음  → +20% (상한: PLACE_MAX_BID, 하루 MAX_UP_PER_DAY회)
#   · 예산 90%+       → -15% 비상제동
# API 호출: stats GET 1 + 캠페인 GET 1 + 광고그룹 GET 1 + PUT 0~1
# ══════════════════════════════════════════════════════════════════════════
def do_check_place():
    log("-" * 60)
    log(f"▶ [플레이스] 2시간 점검 ({datetime.now().strftime('%H:%M')} KST)")

    today_str = datetime.now().strftime("%Y-%m-%d")
    run_date  = today_str

    # ── 1. 오늘 플레이스 노출 조회 (stats API) ───────────────────────────
    place_stats = fetch_stats([PLACE_AG_ID], today_str)
    st = place_stats.get(PLACE_AG_ID, {"imp": 0, "clk": 0, "cost": 0})
    place_imp  = st["imp"]
    place_clk  = st["clk"]
    place_cost = st["cost"]
    log(f"  → 플레이스 오늘: 노출 {place_imp:,}회 / 클릭 {place_clk}회 / 비용 {place_cost:,}원")

    # ── 2. 플레이스 예산 소진 확인 ───────────────────────────────────────
    camp = api_get(f"/ncc/campaigns/{PLACE_CAMPAIGN_ID}")
    today_used = int((camp or {}).get("totalChargeCost", 0) or 0)
    today_pct  = today_used / PLACE_DAILY_BUDGET * 100 if PLACE_DAILY_BUDGET > 0 else 0
    budget_critical = today_pct >= 90
    log(f"  → 플레이스 예산: {today_used:,}원/{PLACE_DAILY_BUDGET:,}원 ({today_pct:.0f}%) "
        f"{'⚠️ 90% 초과!' if budget_critical else 'OK'}")

    # ── 3. 현재 광고그룹 입찰가 조회 ─────────────────────────────────────
    ag = api_get(f"/ncc/adgroups/{PLACE_AG_ID}")
    if not ag:
        log("  ❌ 플레이스 광고그룹 조회 실패 → 중단")
        return False
    cur_bid = int(ag.get("bidAmt", PLACE_INIT_BID))
    ag_status = ag.get("status", "")
    log(f"  → 플레이스 현재 입찰가: {cur_bid}원 / status={ag_status}")

    # ── 4. 오늘 플레이스 상향 횟수 (schedule_log) ────────────────────────
    conn_r = sqlite3.connect(DB_PATH)
    up_today = conn_r.execute(
        "SELECT COUNT(*) FROM schedule_log "
        "WHERE action='PLACE_CHECK_UP' AND run_at >= ?",
        (run_date + " 00:00:00",)
    ).fetchone()[0]
    conn_r.close()
    log(f"  → 플레이스 오늘 상향 횟수: {up_today}/{MAX_UP_PER_DAY}")

    # ── 5. 입찰가 판단 ───────────────────────────────────────────────────
    new_bid = cur_bid
    reason  = ""
    action  = ""

    if budget_critical:
        # ① 예산 90% 초과 → -15% 비상제동
        raw     = int(cur_bid * 0.85)
        new_bid = max(PLACE_MIN_BID, round(raw / 10) * 10)
        reason  = f"예산{today_pct:.0f}%초과→비상-15%"
        action  = "PLACE_CHECK_DOWN"
        log(f"  ⚠️ 예산 90% 초과 비상 → {cur_bid}→{new_bid}원")

    elif place_imp > 0:
        # ② 노출 있음 → -10% (하한: PLACE_MIN_BID)
        if cur_bid <= PLACE_MIN_BID:
            log(f"  [플레이스] 노출 {place_imp}회, 이미 하한({PLACE_MIN_BID}원) → 유지")
            return True
        raw     = int(cur_bid * 0.90)
        new_bid = max(PLACE_MIN_BID, round(raw / 10) * 10)
        if new_bid >= cur_bid:
            new_bid = max(PLACE_MIN_BID, cur_bid - 10)
        if new_bid >= cur_bid:
            log(f"  [플레이스] 노출 {place_imp}회, 하한({PLACE_MIN_BID}원) → 유지")
            return True
        reason = f"노출{place_imp}회→-10%(하한{PLACE_MIN_BID}원)"
        action = "PLACE_CHECK_DOWN"
        log(f"  → 노출 있음: {cur_bid}→{new_bid}원 ({reason})")

    elif place_imp == 0 and up_today < MAX_UP_PER_DAY:
        # ③ 노출 없음 → +20% (상한: PLACE_MAX_BID)
        if cur_bid >= PLACE_MAX_BID:
            log(f"  [플레이스] 노출 0, 이미 상한({PLACE_MAX_BID}원) → 유지")
            return True
        raw     = int(cur_bid * 1.20)
        new_bid = min(PLACE_MAX_BID, max(PLACE_MIN_BID, round(raw / 10) * 10))
        if new_bid <= cur_bid:
            new_bid = min(PLACE_MAX_BID, cur_bid + 10)
        reason = f"노출0→+20%({up_today+1}번째,상한{PLACE_MAX_BID}원)"
        action = "PLACE_CHECK_UP"
        log(f"  → 노출 없음: {cur_bid}→{new_bid}원 ({reason})")

    elif place_imp == 0 and up_today >= MAX_UP_PER_DAY:
        log(f"  [플레이스] 노출 0, 오늘 상향 {up_today}회 한도({MAX_UP_PER_DAY}회) → 유지")
        return True

    else:
        log(f"  [플레이스] 노출 {place_imp}회 bid={cur_bid}원 → 유지")
        return True

    # ── 6. 변경이 없으면 스킵 ────────────────────────────────────────────
    if new_bid == cur_bid:
        log(f"  [플레이스] 변경 없음 → 유지")
        return True

    # ── 7. PUT /ncc/adgroups/{id}?fields=bidAmt ───────────────────────────
    uri = f"/ncc/adgroups/{PLACE_AG_ID}"
    sc, res = api_put(uri, {"bidAmt": new_bid}, "bidAmt")
    tag = "↑" if new_bid > cur_bid else "↓"
    if sc == 200:
        log(f"  ✅ [플레이스] {cur_bid}{tag}{new_bid}원 | {reason}")
        push_history("[플레이스]", cur_bid, new_bid, reason)
        db_log(action, PLACE_AG_ID, True, reason)
    else:
        log(f"  ❌ [플레이스] PUT 실패[{sc}]: {res}")
        db_log(action, PLACE_AG_ID, False, str(res))
        return False

    log(f"▶ [플레이스] 점검 완료: {cur_bid}{tag}{new_bid}원 | 오늘 {today_used:,}원/{PLACE_DAILY_BUDGET:,}원")
    return True


# ══════════════════════════════════════════════════════════════════════════
# 메인
# ══════════════════════════════════════════════════════════════════════════
def main():
    init_db()
    now_h = datetime.now().hour
    arg   = sys.argv[1] if len(sys.argv) > 1 else None

    if arg == "off":
        if now_h == 1:
            do_off()
        else:
            log(f"[SKIP] off: 현재 {now_h}시 (1시에만 실행)")

    elif arg == "on":
        if now_h == 7:
            do_on()
        else:
            log(f"[SKIP] on: 현재 {now_h}시 (7시에만 실행)")

    elif arg == "check":
        if 9 <= now_h <= 23:
            do_check()
            do_check_place()
        else:
            log(f"[SKIP] check: 현재 {now_h}시 (9~23시에만 실행)")

    elif arg == "force_check":
        # 테스트용: 시간 무관 전체(파워링크+플레이스) 강제 실행
        do_check()
        do_check_place()

    elif arg == "force_place_check":
        # 테스트용: 플레이스만 강제 실행
        do_check_place()

    elif arg == "force_on":
        # 테스트용: 시간 무관 on 강제 실행
        do_on()

    elif arg == "force_off":
        # 테스트용: 시간 무관 off 강제 실행
        do_off()

    else:
        # 시간 자동 판단
        if now_h == 1:
            do_off()
        elif now_h == 7:
            do_on()
        elif 9 <= now_h <= 23:
            do_check()
            do_check_place()
        else:
            log(f"현재 {now_h}시 → 스케줄 없음 (1시=OFF / 7시=ON / 9~23시=2h점검)")

if __name__ == "__main__":
    main()
