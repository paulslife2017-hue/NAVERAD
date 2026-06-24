#!/usr/bin/env python3
"""
네이버 광고 스케줄러 v5
[파워링크]
- 새벽 01:00 → 캠페인 OFF
- 아침 07:00 → 캠페인 ON
- 2시간마다(09~23시) → 키워드별 입찰가 조정 (CTR-aware)
  · CTR>=2%          → +10% 상향 (클릭 잘 되는 키워드 보호)
  · CTR 0.5%~2%      → -10% 하락
  · CTR < 0.5%       → -15% 공격적 하락 (노출만 먹음)
  · 노출 0           → +15% 상향 (KW_MAX_BID 상한)
  · 예산 90%+        → -15% 비상
- 점심 13:00 → 순위 점검 (Playwright + plAvgDepth) + 1페이지 강제 진입
  · 노출0 or 1페이지 밖 키워드 → KW_MAX_BID까지 한 번에 대폭 상향
  · Playwright로 네이버 실제 검색 확인 (크레딧 0)
[플레이스]
- 동일 스케줄 (OFF/ON/2h점검)
- 키워드 없음 → 광고그룹 bidAmt 단일 조정
  · 노출 있음 → -10% (PLACE_MIN_BID 하한)
  · 노출 없음 → +20% (PLACE_MAX_BID 상한)
  · 예산 90%+ → -15% 비상
"""
import hashlib, hmac, base64, time, requests, json, sqlite3, os, sys, urllib.parse
from datetime import datetime, timedelta

# ── 인증 ──────────────────────────────────────────────────────────────────
AL   = "0100000000e8a9e5c719ef2ea8318c370686c95f2e7a575fd22e8075980031db54654aa701"
SK   = "AQAAAADoqeXHGe8uqDGMNwaGyV8ub0ko3GK/zB5aWTFEsaWJMw=="
CID  = "4412351"
BASE = "https://api.naver.com"

# ── 광고 도착 도메인 (Playwright 순위 확인용) ─────────────────────────────
# 네이버 파워링크 광고에서 노출되는 우리 사이트 도메인
# 여러 도메인이 있을 경우 모두 추가 (하나라도 매칭되면 1페이지로 판단)
OUR_DOMAINS = [
    "airconhelper.co.kr",  # 메인 광고 도착 도메인
]

DB_PATH  = "/home/user/webapp/data/naver_ad.db"
LOG_PATH = "/home/user/webapp/data/scheduler.log"

# ── 파워링크 캠페인 ───────────────────────────────────────────────────────
PL_CAMPAIGN_IDS = ["cmp-a001-01-000000010736912"]   # 파워링크#1
CID_QS          = "cmp-a001-01-000000010739701"     # 퀵스타트 캠페인
TARGET_CAMPAIGNS = PL_CAMPAIGN_IDS  # 하위 호환 (파워링크#1 기준)

# ── 플레이스 캠페인/그룹 ──────────────────────────────────────────────────
PLACE_CAMPAIGN_ID = "cmp-a001-06-000000010731200"
PLACE_AG_ID       = "grp-a001-06-000000068627534"
PLACE_DAILY_BUDGET = 10_000   # 플레이스 일 예산
PLACE_MIN_BID      = 70       # 플레이스 하한
PLACE_MAX_BID      = 3_000    # 플레이스 상한
PLACE_INIT_BID     = 300      # 플레이스 기본 시작 입찰가

# ── 파워링크 예산/입찰 설정 ────────────────────────────────────────────────
# DAILY_BUDGET: 퀵스타트 광고그룹 dailyBudget과 동기화 (네이버 광고관리자 UI에서만 변경 가능)
# 현재 광고그룹 dailyBudget = 50,000원 (API grp-a001-01-000000068725999 기준)
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
    "시스템에어컨누설수리":  3000,   # 2026-06-23 추가
    "시스템에어컨수리":      3000,   # 2026-06-23 추가
    "시스템에어컨누수":      2000,   # 2026-06-23 추가
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
    "시스템에어컨누설수리": 1500,   # 2026-06-23 추가
    "시스템에어컨수리":     1500,   # 2026-06-23 추가
    "시스템에어컨누수":     1000,   # 2026-06-23 추가
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
# Vercel 배포 후 실제 URL로 변경 필요
# 예: DASHBOARD_URL = "https://your-project.vercel.app"
DASHBOARD_URL = os.environ.get("DASHBOARD_URL", "http://localhost:3000")

def push_history(keyword, old_bid, new_bid, reason):
    try:
        requests.post(
            f"{DASHBOARD_URL}/api/history-write",
            json={"keyword": keyword, "oldBid": old_bid, "newBid": new_bid,
                  "reason": reason,
                  "changedAt": datetime.now().strftime("%Y-%m-%dT%H:%M:%S+09:00")},
            timeout=3,
        )
    except Exception:
        pass

def clear_ncc_cache():
    """입찰가 변경 후 대시보드 NCC 캐시 삭제 → 다음 조회 시 최신값 반영"""
    try:
        r = requests.delete(f"{DASHBOARD_URL}/api/cache?type=ncc", timeout=3)
        log(f"  🗑 대시보드 캐시 클리어: {r.status_code}")
    except Exception as e:
        log(f"  ⚠ 캐시 클리어 실패 (무시): {e}")

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
# STEP C: 2시간 점검 — 키워드별 개별 stats 기반 CTR-aware 입찰가 조정
#
# 판단 우선순위:
#   ① 예산 90%+            → 전체 -15% 비상제동
#   ② 키워드별 CTR >= 2%   → 보호: 입찰가 유지 or +10% 상향 (클릭 잘 되는 키워드)
#   ③ 노출 있고 CTR < 0.5% → 공격적 -15% 하락 (노출만 먹고 클릭 없음)
#   ④ 노출 있고 CTR 0.5%~2%→ 천천히 -10% 하락 (보통 수준)
#   ⑤ 노출 0               → +15% 상향 (노출조차 안 됨, 상한까지)
#   · 변경된 것만 PUT (크레딧 최소화)
#   · 크레딧: 키워드 GET 1 + 캠페인 GET 1 + stats GET 1 + PUT N
# ══════════════════════════════════════════════════════════════════════════
def do_check():
    log("=" * 60)
    log(f"▶ 2시간 점검 ({datetime.now().strftime('%H:%M')} KST)")

    # ── 0. 클릭 테러 선제 감지 (매 2시간 점검 시 자동 체크) ─────────────
    # 테러 감지되면 비상 입찰가 하락 후 나머지 로직은 계속 실행
    do_terror_check()

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

    # ── 3. stats API: 키워드 ID별 오늘 실적 (키워드 단위로 정확히 조회) ──
    kw_ids = [k["nccKeywordId"] for k in all_kws]
    kw_stats = fetch_stats(kw_ids, today_str)  # { kw_id → {imp,clk,cost} }

    total_imp  = sum(v["imp"]  for v in kw_stats.values())
    total_clk  = sum(v["clk"]  for v in kw_stats.values())
    total_cost = sum(v["cost"] for v in kw_stats.values())
    total_ctr  = total_clk / total_imp * 100 if total_imp > 0 else 0
    log(f"  → 오늘 전체: 노출 {total_imp:,}회 / 클릭 {total_clk}회 / CTR {total_ctr:.2f}% / 비용 {total_cost:,}원")

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
    log(f"  → 오늘 상향 현황: 총 {up_total}건")

    # ── 5. 키워드별 판단 (CTR-aware) ────────────────────────────────────
    to_change = []
    for kw in all_kws:
        name    = kw.get("keyword", "")
        kw_id   = kw.get("nccKeywordId", "")
        ag_id   = kw.get("_agId", "")
        cur_bid = int(kw.get("bidAmt", MIN_BID))
        status  = kw.get("status", "")

        if status != "ELIGIBLE":
            continue

        init_bid = INIT_BIDS.get(name, MIN_BID)
        kw_max   = KW_MAX_BID.get(name, MAX_BID)
        up_today = up_counts.get(name, 0)

        st      = kw_stats.get(kw_id, {})
        kw_imp  = st.get("imp", 0)
        kw_clk  = st.get("clk", 0)
        kw_ctr  = kw_clk / kw_imp * 100 if kw_imp > 0 else 0

        new_bid = cur_bid
        reason  = ""
        action  = ""

        if budget_critical:
            # ① 예산 90% 초과 → -15% 비상제동
            raw     = int(cur_bid * 0.85)
            new_bid = max(MIN_BID, round(raw / 10) * 10)
            reason  = f"예산{today_pct:.0f}%초과→비상-15%"
            action  = "CHECK_DOWN"

        elif kw_imp > 0 and kw_ctr >= 2.0:
            # ② CTR 2% 이상 → 클릭 잘 되는 키워드: 보호 + 상향 탐색
            if cur_bid >= kw_max:
                log(f"  [{name}] ★CTR {kw_ctr:.1f}%(노출{kw_imp}/클릭{kw_clk}), 이미 상한({kw_max}원) → 유지")
                continue
            raw     = int(cur_bid * 1.10)
            new_bid = min(kw_max, max(init_bid, round(raw / 10) * 10))
            if new_bid <= cur_bid:
                new_bid = min(kw_max, cur_bid + 10)
            if new_bid <= cur_bid:
                log(f"  [{name}] ★CTR {kw_ctr:.1f}%, 상한({kw_max}원) → 유지")
                continue
            reason = f"★CTR{kw_ctr:.1f}%(노출{kw_imp}/클릭{kw_clk})→+10%상향"
            action = "CHECK_UP"

        elif kw_imp > 0 and kw_ctr >= 0.5:
            # ③ CTR 0.5%~2% → 보통: 천천히 -10% 하락 (하한 보호)
            if cur_bid <= init_bid:
                log(f"  [{name}] CTR {kw_ctr:.1f}%(노출{kw_imp}/클릭{kw_clk}), 하한({init_bid}원) → 유지")
                continue
            raw     = int(cur_bid * 0.90)
            new_bid = max(init_bid, round(raw / 10) * 10)
            if new_bid >= cur_bid:
                new_bid = max(init_bid, cur_bid - 10)
            if new_bid >= cur_bid:
                log(f"  [{name}] CTR {kw_ctr:.1f}%, 하한({init_bid}원) → 유지")
                continue
            reason = f"CTR{kw_ctr:.1f}%(노출{kw_imp}/클릭{kw_clk})→-10%(하한{init_bid}원)"
            action = "CHECK_DOWN"

        elif kw_imp > 0 and kw_ctr < 0.5:
            # ④ 노출 있지만 CTR 0.5% 미만 → 공격적 -15% (노출만 먹는 키워드)
            if cur_bid <= init_bid:
                log(f"  [{name}] CTR {kw_ctr:.1f}%(노출{kw_imp}/클릭0), 하한({init_bid}원) → 유지")
                continue
            raw     = int(cur_bid * 0.85)
            new_bid = max(init_bid, round(raw / 10) * 10)
            if new_bid >= cur_bid:
                new_bid = max(init_bid, cur_bid - 10)
            if new_bid >= cur_bid:
                log(f"  [{name}] CTR 저조, 하한({init_bid}원) → 유지")
                continue
            reason = f"CTR{kw_ctr:.1f}%(노출{kw_imp}/클릭{kw_clk})→-15%(하한{init_bid}원)"
            action = "CHECK_DOWN"

        elif kw_imp == 0 and up_today < MAX_UP_PER_DAY:
            # ⑤ 노출 0 → +15% 상향 탐색
            if cur_bid >= kw_max:
                log(f"  [{name}] 노출0, 이미 상한({kw_max}원) → 유지")
                continue
            raw     = int(cur_bid * 1.15)
            new_bid = min(kw_max, max(MIN_BID, round(raw / 10) * 10))
            if new_bid <= cur_bid:
                new_bid = min(kw_max, cur_bid + 10)
            reason = f"노출0→+15%({up_today+1}번째,상한{kw_max}원)"
            action = "CHECK_UP"

        elif kw_imp == 0 and up_today >= MAX_UP_PER_DAY:
            log(f"  [{name}] 노출0, 오늘 상향 {up_today}회 한도 → 유지")
            continue

        else:
            log(f"  [{name}] 노출{kw_imp}회 bid={cur_bid}원 → 유지")
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
    if ok > 0:
        clear_ncc_cache()  # 입찰가 변경 있을 때만 캐시 클리어
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
    if new_bid != cur_bid:
        clear_ncc_cache()  # 입찰가 변경 시 캐시 클리어
    return True


# ══════════════════════════════════════════════════════════════════════════
# STEP E: Playwright로 네이버 파워링크 1페이지 순위 확인 (크레딧 0)
# ══════════════════════════════════════════════════════════════════════════
def check_powerlink_rank_playwright(keyword, our_domains=None, timeout_ms=20000):
    """
    Playwright로 네이버에서 keyword 검색 → 파워링크 1페이지에 우리 광고 있는지 확인
    크레딧 소모 없음.
    반환: {"rank": int, "total_ads": int, "on_page1": bool, "ads": list, "error": str}
      rank=0  → 1페이지에 우리 광고 없음
      rank=N  → N번째 위치에 노출 중
    """
    if our_domains is None:
        our_domains = OUR_DOMAINS

    url = f"https://search.naver.com/search.naver?where=nexearch&query={keyword}"
    result = {"rank": 0, "total_ads": 0, "on_page1": False, "ads": [], "error": None}

    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
            )
            page = browser.new_page(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                )
            )
            page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
            time.sleep(2)

            # 파워링크 광고 아이템: #power_link_body > ul > li (검증된 셀렉터)
            ad_items = page.query_selector_all("#power_link_body > ul > li")

            rank = 0
            ads_info = []

            for i, item in enumerate(ad_items, 1):
                try:
                    full_text = item.inner_text()
                    # URL 표시 텍스트 추출
                    display_url = ""
                    for line in full_text.split("\n"):
                        l = line.strip()
                        if ("." in l and len(l) < 80 and
                                any(ext in l for ext in [".com", ".co.kr", ".net", ".kr", "naver.com"])):
                            display_url = l
                            break
                    lines = [l.strip() for l in full_text.split("\n") if l.strip()]
                    title = lines[0][:50] if lines else ""
                    ads_info.append({"rank": i, "title": title, "display_url": display_url})

                    # 우리 도메인 체크
                    for dom in our_domains:
                        if dom.lower() in full_text.lower():
                            rank = i
                            break
                except Exception:
                    pass

            result["rank"] = rank
            result["total_ads"] = len(ad_items)
            result["on_page1"] = rank > 0
            result["ads"] = ads_info
            browser.close()

    except ImportError:
        result["error"] = "playwright 미설치 (pip3 install playwright && python3 -m playwright install chromium)"
    except Exception as e:
        result["error"] = str(e)

    return result


# ══════════════════════════════════════════════════════════════════════════
# STEP F: 점심 13시 순위 점검 — 노출0/클릭0 키워드 → KW_MAX_BID 대폭 상향
#
# 로직:
#   1. 오늘 stats 조회 → 노출0 AND 클릭0 키워드 추출 (크레딧: GET 1)
#   2. /keywordstool plAvgDepth 조회 → 1페이지 밖(>5) 키워드 확인 (크레딧: GET N/5)
#   3. Playwright로 파워링크 실제 검색 → 1페이지 미노출 확인 (크레딧: 0)
#   4. 노출0 OR plAvgDepth>5 OR Playwright 미노출 → KW_MAX_BID까지 한 번에 상향
#   5. 변경된 것만 PUT (크레딧: PUT N)
#
# 크레딧 절약:
#   - Playwright는 크레딧 0: 가능하면 Playwright 우선
#   - plAvgDepth는 5개씩 배치: 키워드 30개 → 6회만 호출
#   - MAX_UP_PER_DAY 제한 없음 (점심 1번만 실행이므로 한 번에 올려버림)
# ══════════════════════════════════════════════════════════════════════════
def do_rank_check():
    log("=" * 60)
    log(f"▶ 점심 13시 순위 점검 + 1페이지 강제 진입 ({datetime.now().strftime('%H:%M')} KST)")

    today_str = datetime.now().strftime("%Y-%m-%d")

    # ── 1. 키워드 목록 조회 (GET 1) ─────────────────────────────────────
    all_kws = fetch_all_keywords()
    if not all_kws:
        log("  ❌ 키워드 조회 실패 → 중단")
        return False
    log(f"  → 키워드 {len(all_kws)}개 조회")

    # ── 2. 오늘 키워드별 stats (GET 1) ─────────────────────────────────
    kw_ids   = [k["nccKeywordId"] for k in all_kws]
    kw_stats = fetch_stats(kw_ids, today_str)  # { kw_id → {imp, clk, cost} }

    # ── 3. plAvgDepth 조회 (키워드당 1/5 크레딧) ─────────────────────────
    # 노출0 OR 클릭0 키워드만 plAvgDepth 조회 (크레딧 최소화)
    zero_kws = [k for k in all_kws
                if kw_stats.get(k["nccKeywordId"], {}).get("imp", 0) == 0
                or kw_stats.get(k["nccKeywordId"], {}).get("clk", 0) == 0]
    log(f"  → 노출0 또는 클릭0 키워드: {len(zero_kws)}개")

    avg_depth_map = {}  # keyword → plAvgDepth
    SEARCH_BASE = "https://api.searchad.naver.com"
    kw_names = list({k.get("keyword", "") for k in zero_kws if k.get("keyword")})

    for i in range(0, len(kw_names), 5):
        batch = kw_names[i:i+5]
        hint  = ",".join(batch)
        try:
            ts = str(int(time.time() * 1000))
            uri = "/keywordstool"
            r = requests.get(
                SEARCH_BASE + uri,
                headers=_hdrs(ts, "GET", uri),
                params={"hintKeywords": hint, "showDetail": "1"},
                timeout=15,
            )
            if r.status_code == 200:
                for item in (r.json().get("keywordList") or []):
                    kw_name = item.get("relKeyword", "")
                    depth   = item.get("plAvgDepth", 99)
                    if kw_name:
                        avg_depth_map[kw_name] = float(depth) if depth else 99
            else:
                log(f"  ⚠️ plAvgDepth API [{r.status_code}]: {r.text[:80]}")
        except Exception as e:
            log(f"  ⚠️ plAvgDepth 예외: {e}")
        time.sleep(0.3)

    log(f"  → plAvgDepth 조회 완료: {len(avg_depth_map)}개")

    # ── 4. Playwright로 대표 키워드 1페이지 확인 (크레딧 0) ──────────────
    # 검색량 많은 키워드 상위 5개만 Playwright로 확인 (시간 절약)
    # plAvgDepth가 없거나 5 초과인 키워드 중 선별
    playwright_results = {}  # keyword → on_page1 (bool)
    pw_candidates = [
        k for k in zero_kws
        if avg_depth_map.get(k.get("keyword", ""), 99) > 5
    ][:5]  # 최대 5개만 Playwright 확인

    if pw_candidates:
        log(f"  → Playwright 1페이지 확인 시작 ({len(pw_candidates)}개 키워드)")
        for kw in pw_candidates:
            name = kw.get("keyword", "")
            try:
                pr = check_powerlink_rank_playwright(name)
                playwright_results[name] = pr.get("on_page1", False)
                rank_txt = f"rank={pr['rank']}/{pr['total_ads']}" if pr["total_ads"] > 0 else "광고없음"
                on_p1 = "✅ 1페이지" if pr["on_page1"] else "❌ 밖"
                log(f"    [{name}] {on_p1} | {rank_txt}" +
                    (f" | err={pr['error']}" if pr.get("error") else ""))
            except Exception as e:
                playwright_results[name] = False
                log(f"    [{name}] Playwright 오류: {e}")
            time.sleep(1)  # 네이버 차단 방지
    else:
        log("  → Playwright 확인 대상 없음 (모두 1페이지 또는 plAvgDepth 정상)")

    # ── 5. 상향 대상 결정 ─────────────────────────────────────────────────
    to_change = []
    for kw in all_kws:
        name    = kw.get("keyword", "")
        kw_id   = kw.get("nccKeywordId", "")
        ag_id   = kw.get("_agId", "")
        cur_bid = int(kw.get("bidAmt", MIN_BID))
        status  = kw.get("status", "")

        if status != "ELIGIBLE":
            continue

        kw_max   = KW_MAX_BID.get(name, MAX_BID)
        st       = kw_stats.get(kw_id, {})
        kw_imp   = st.get("imp", 0)
        kw_clk   = st.get("clk", 0)
        depth    = avg_depth_map.get(name, None)  # None = 데이터 없음
        on_page1_pw = playwright_results.get(name, None)  # None = 미확인

        # 이미 최대 입찰가면 스킵
        if cur_bid >= kw_max:
            log(f"  [{name}] 이미 상한({kw_max}원) / 노출{kw_imp}/클릭{kw_clk} → 유지")
            continue

        # 1페이지 강제 진입 조건:
        #   A. 오늘 노출0 AND 클릭0  (stats 기반)
        #   B. plAvgDepth > 5        (평균 순위 1페이지 밖)
        #   C. Playwright에서 미노출  (실제 확인)
        reason_parts = []

        needs_boost = False
        if kw_imp == 0 and kw_clk == 0:
            needs_boost = True
            reason_parts.append(f"노출0/클릭0")
        if depth is not None and depth > 5:
            needs_boost = True
            reason_parts.append(f"plAvgDepth={depth:.1f}(1페이지밖)")
        if on_page1_pw is False:  # 명시적으로 False (None=미확인은 제외)
            needs_boost = True
            reason_parts.append("Playwright미노출")

        if not needs_boost:
            log(f"  [{name}] 노출{kw_imp}/클릭{kw_clk}/depth={depth or '?'} → 유지")
            continue

        # 상향 폭 결정:
        #   · 노출0 → KW_MAX_BID로 한 번에 올림 (가장 공격적)
        #   · plAvgDepth > 10 (2페이지 이하) → KW_MAX_BID의 80%로 점프
        #   · plAvgDepth 5~10 (1.5페이지) → +50% 대폭 상향
        if kw_imp == 0:
            # 노출조차 안 됨 → 상한까지 한 번에
            new_bid = kw_max
        elif depth is not None and depth > 10:
            # 2페이지 이하 → 상한 80%로 점프
            new_bid = min(kw_max, max(MIN_BID, round(kw_max * 0.80 / 10) * 10))
        elif depth is not None and depth > 5:
            # 1페이지 경계 → +50% 대폭 상향
            raw     = int(cur_bid * 1.50)
            new_bid = min(kw_max, max(MIN_BID, round(raw / 10) * 10))
        else:
            # Playwright만 감지 → +30% 상향
            raw     = int(cur_bid * 1.30)
            new_bid = min(kw_max, max(MIN_BID, round(raw / 10) * 10))

        if new_bid <= cur_bid:
            new_bid = min(kw_max, cur_bid + 10)
        if new_bid <= cur_bid:
            log(f"  [{name}] 상향불가 (이미 상한?) → 유지")
            continue

        reason = "점심순위점검→" + "+".join(reason_parts) + f"→{cur_bid}→{new_bid}원"
        to_change.append({
            "name": name, "kw_id": kw_id, "ag_id": ag_id,
            "cur_bid": cur_bid, "new_bid": new_bid,
            "reason": reason, "action": "RANK_UP",
        })

    log(f"  → 상향 {len(to_change)}개 / 유지 {len(all_kws)-len(to_change)}개")

    # ── 6. PUT (변경된 것만) ─────────────────────────────────────────────
    ok = fail = 0
    for r in to_change:
        uri = f"/ncc/keywords/{r['kw_id']}"
        sc, res = api_put(
            uri,
            {"nccAdgroupId": r["ag_id"], "useGroupBidAmt": False, "bidAmt": r["new_bid"]},
            "nccAdgroupId,useGroupBidAmt,bidAmt",
        )
        if sc == 200:
            log(f"  ✅ [{r['name']}] {r['cur_bid']}↑{r['new_bid']}원 | {r['reason']}")
            push_history(r["name"], r["cur_bid"], r["new_bid"], r["reason"])
            db_log(r["action"], r["name"], True, r["reason"])
            ok += 1
        else:
            log(f"  ❌ [{r['name']}] 실패[{sc}] {str(res)[:80]}")
            fail += 1
        time.sleep(0.2)

    log(f"▶ 순위 점검 완료: 상향{ok}개 / 실패{fail}개 / 유지{len(all_kws)-len(to_change)}개")
    if ok > 0:
        clear_ncc_cache()
    return True


# ══════════════════════════════════════════════════════════════════════════
# STEP G: 클릭 테러 감지 + 자동 비상 대응
#
# 네이버 NCC API 한계:
#   - invalidClkCnt (무효클릭수) API 미제공
#   - 실시간 IP별 클릭 조회 불가
#   → 네이버가 자체 무효클릭 필터링은 하지만 API로 확인 불가
#
# 우리가 할 수 있는 것:
#   ① 비정상 CTR 감지: 시간당 클릭이 평소의 N배 이상 → 비상 입찰가 하락
#   ② 예산 소진 속도 감지: 평소보다 빠른 소진 → 즉시 입찰가 -50% 비상
#   ③ 현재 시각 비용이 전날 같은 시각 대비 3배 이상 → 테러 의심
#   ④ 입찰가를 MIN_BID까지 내려서 추가 클릭 차단 (비용 최소화)
#
# 실행: do_check() 내부에서 매 2시간마다 자동 체크
#       또는 force_terror_check 인수로 즉시 실행
# ══════════════════════════════════════════════════════════════════════════

# 클릭 테러 감지 임계값
TERROR_CTR_THRESHOLD  = 15.0   # CTR이 15% 이상이면 클릭테러 의심 (정상 광고 CTR 1~3%)
TERROR_CLK_PER_HOUR   = 20     # 시간당 클릭 20회 이상이면 의심
TERROR_COST_MULTIPLIER = 3.0   # 전날 같은 시간 대비 비용이 3배 이상이면 의심
TERROR_EMERGENCY_BID  = 70     # 테러 감지 시 입찰가를 이 값으로 낮춤 (MIN_BID)

def fetch_hourly_stats(ids, date_str, hour):
    """특정 날짜 특정 시간의 stats 조회 (시간 단위)"""
    if not ids:
        return {}
    uri = "/stats"
    params = urllib.parse.urlencode({
        "ids":       ",".join(ids),
        "fields":    '["impCnt","clkCnt","salesAmt"]',
        "timeRange": json.dumps({"since": date_str, "until": date_str}),
        "timeUnit":  "HOUR",
    })
    ts = str(int(time.time() * 1000))
    try:
        r = requests.get(BASE + uri + "?" + params,
                         headers=_hdrs(ts, "GET", uri), timeout=20)
        if r.status_code == 200:
            result = {}
            for item in (r.json().get("data") or []):
                sid = item.get("id", "")
                # 시간별 데이터에서 특정 hour 추출
                hourly = item.get("statData") or item
                # HOUR 단위는 배열 형태일 수 있음
                if isinstance(hourly, list):
                    h_data = hourly[hour] if hour < len(hourly) else {}
                else:
                    h_data = hourly  # DAY 단위로 돌아온 경우
                result[sid] = {
                    "imp":  int(h_data.get("impCnt",   0) or 0),
                    "clk":  int(h_data.get("clkCnt",   0) or 0),
                    "cost": int(h_data.get("salesAmt", 0) or 0),
                }
            return result
    except Exception as e:
        log(f"  ⚠️ hourly stats 오류: {e}")
    return {}


def do_terror_check():
    """
    클릭 테러 감지 + 비상 대응
    비정상 클릭 감지 시 모든 키워드 입찰가를 MIN_BID로 즉시 하락
    반환: True=정상, False=테러 감지 (비상 조치 실행)
    """
    log("-" * 60)
    log(f"▶ [클릭테러 감지] 체크 시작 ({datetime.now().strftime('%H:%M')} KST)")

    today_str = datetime.now().strftime("%Y-%m-%d")
    now_h     = datetime.now().hour

    # ── 1. 오늘 현재까지 캠페인 전체 stats ─────────────────────────────
    camp = api_get(f"/ncc/campaigns/{TARGET_CAMPAIGNS[0]}")
    if not camp:
        log("  ⚠️ 캠페인 조회 실패 → 스킵")
        return True

    today_cost  = int((camp or {}).get("totalChargeCost", 0) or 0)
    today_pct   = today_cost / DAILY_BUDGET * 100 if DAILY_BUDGET > 0 else 0

    # ── 2. 오늘 키워드별 stats (클릭/노출 조회) ─────────────────────────
    all_kws = fetch_all_keywords()
    if not all_kws:
        return True

    kw_ids   = [k["nccKeywordId"] for k in all_kws]
    kw_stats = fetch_stats(kw_ids, today_str)

    total_imp  = sum(v["imp"]  for v in kw_stats.values())
    total_clk  = sum(v["clk"]  for v in kw_stats.values())
    total_cost = sum(v["cost"] for v in kw_stats.values())
    total_ctr  = total_clk / total_imp * 100 if total_imp > 0 else 0

    # 시간당 클릭 (운영 시간 기준)
    running_hours = max(1, now_h - 7)  # 7시 ON 기준
    clk_per_hour  = total_clk / running_hours

    log(f"  → 오늘 {now_h}시까지: 노출{total_imp:,} / 클릭{total_clk} / "
        f"CTR {total_ctr:.2f}% / 시간당{clk_per_hour:.1f}클릭 / "
        f"비용{total_cost:,}원({today_pct:.0f}%)")

    # ── 3. 이상 감지 판단 ─────────────────────────────────────────────
    terror_flags = []

    # A. CTR 이상
    if total_imp > 100 and total_ctr >= TERROR_CTR_THRESHOLD:
        terror_flags.append(f"비정상CTR {total_ctr:.1f}%(≥{TERROR_CTR_THRESHOLD}%)")

    # B. 시간당 클릭 이상
    if clk_per_hour >= TERROR_CLK_PER_HOUR:
        terror_flags.append(f"시간당클릭{clk_per_hour:.0f}회(≥{TERROR_CLK_PER_HOUR}회)")

    # C. 예산 50% 이상 소진인데 아직 오전 (11시 이전)
    if today_pct >= 50 and now_h < 11:
        terror_flags.append(f"오전{now_h}시에 예산{today_pct:.0f}%소진")

    # D. 예산 80% 이상 소진인데 13시 이전
    if today_pct >= 80 and now_h < 13:
        terror_flags.append(f"{now_h}시에 예산{today_pct:.0f}%소진(80%+)")

    if not terror_flags:
        log(f"  ✅ 클릭 테러 감지 없음 (CTR {total_ctr:.2f}% / 시간당{clk_per_hour:.1f}클릭)")
        return True

    # ── 4. 테러 감지! 비상 대응: 모든 키워드 입찰가를 MIN_BID로 ────────
    log(f"  🚨 클릭 테러 의심 감지!")
    for flag in terror_flags:
        log(f"    → {flag}")
    log(f"  🚨 비상 조치: 모든 키워드 입찰가를 {TERROR_EMERGENCY_BID}원으로 하락!")

    # DB에 테러 감지 기록
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT INTO schedule_log (run_at,action,campaign,success,detail) VALUES (?,?,?,?,?)",
        (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "TERROR_DETECTED",
         TARGET_CAMPAIGNS[0], 1,
         f"CTR={total_ctr:.2f}% clk/h={clk_per_hour:.1f} cost={today_cost:,}원 flags={','.join(terror_flags)}")
    )
    conn.commit()
    conn.close()

    # 모든 활성 키워드 입찰가를 TERROR_EMERGENCY_BID로 즉시 하락
    ok = fail = skip = 0
    for kw in all_kws:
        name    = kw.get("keyword", "")
        kw_id   = kw.get("nccKeywordId", "")
        ag_id   = kw.get("_agId", "")
        cur_bid = int(kw.get("bidAmt", MIN_BID))
        status  = kw.get("status", "")

        if status != "ELIGIBLE":
            skip += 1
            continue
        if cur_bid <= TERROR_EMERGENCY_BID:
            skip += 1
            continue

        uri = f"/ncc/keywords/{kw_id}"
        sc, res = api_put(
            uri,
            {"nccAdgroupId": ag_id, "useGroupBidAmt": False, "bidAmt": TERROR_EMERGENCY_BID},
            "nccAdgroupId,useGroupBidAmt,bidAmt",
        )
        if sc == 200:
            log(f"  🚨 [{name}] {cur_bid}↓{TERROR_EMERGENCY_BID}원 (테러비상)")
            push_history(name, cur_bid, TERROR_EMERGENCY_BID,
                         f"테러비상↓({','.join(terror_flags)})")
            db_log("TERROR_DOWN", name, True,
                   f"cur={cur_bid}→{TERROR_EMERGENCY_BID} flags={','.join(terror_flags)}")
            ok += 1
        else:
            log(f"  ❌ [{name}] 비상하락 실패[{sc}]: {str(res)[:60]}")
            fail += 1
        time.sleep(0.1)

    log(f"  🚨 비상 조치 완료: 하락{ok}개 / 실패{fail}개 / 스킵{skip}개")
    log(f"  ⚠️  네이버 고객센터 신고 권장: https://saedu.naver.com/help/qna/create.naver")
    clear_ncc_cache()
    return False  # 테러 감지됨


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

    elif arg == "rank_check":
        # 점심 13시 순위 점검 + 1페이지 강제 진입
        if now_h == 13:
            do_rank_check()
        else:
            log(f"[SKIP] rank_check: 현재 {now_h}시 (13시에만 실행)")

    elif arg == "force_rank_check":
        # 테스트용: 시간 무관 순위 점검 강제 실행
        do_rank_check()

    elif arg == "terror_check":
        # 클릭 테러 감지만 실행 (비상 조치 포함)
        do_terror_check()

    elif arg == "force_terror_check":
        # 테스트용: 시간 무관 테러 감지 강제 실행
        do_terror_check()

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
        elif now_h == 13:
            # 점심 13시: 순위 점검 + 1페이지 강제 진입
            do_rank_check()
        elif 9 <= now_h <= 23:
            do_check()
            do_check_place()
        else:
            log(f"현재 {now_h}시 → 스케줄 없음 (1시=OFF / 7시=ON / 13시=순위점검 / 9~23시=2h점검)")

if __name__ == "__main__":
    main()
