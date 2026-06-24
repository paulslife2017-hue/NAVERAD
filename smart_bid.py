#!/usr/bin/env python3
"""
스마트 입찰 자동화 스크립트
- 매일 새벽 3시 PM2 cron으로 실행
- 키워드별 최신 검색량/경쟁도 조회
- 최소비용 최대노출 입찰가 자동 계산 & 적용
- 실행 이력 SQLite DB에 저장
"""

import hashlib, hmac, base64, time, requests, json, sqlite3, os, sys
from datetime import datetime

# ── 인증 정보 ───────────────────────────────────────────────────────────────
AL  = "0100000000e8a9e5c719ef2ea8318c370686c95f2e7a575fd22e8075980031db54654aa701"
SK  = "AQAAAADoqeXHGe8uqDGMNwaGyV8ub0ko3GK/zB5aWTFEsaWJMw=="
CID = "4412351"
BASE = "https://api.naver.com"

DB_PATH = "/home/user/webapp/data/naver_ad.db"
LOG_PATH = "/home/user/webapp/data/smart_bid.log"

# ── 월 예산 설정 ─────────────────────────────────────────────────────────────
MONTHLY_BUDGET = 3_000_000   # 월 300만원 (일 10만원 × 30일)
DAILY_BUDGET   = 100_000     # 일 10만원

# ── 입찰가 상·하한 ─────────────────────────────────────────────────────────
MIN_BID = 70     # 최소 입찰가 (네이버 정책)
MAX_BID = 5000   # 최대 입찰가 (1페이지 상단 경쟁 키워드 대응)

# ── 청소 계열 (비용 절약 타겟 - 최저가 유지) ─────────────────────────────────
CLEAN_KEYWORDS = {"에어컨청소", "삼성에어컨청소", "벽걸이에어컨셀프청소", "에어컨분해청소"}

# ── 로그 ──────────────────────────────────────────────────────────────────
def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")

# ── HMAC 서명 ──────────────────────────────────────────────────────────────
def sig(ts, method, uri):
    return base64.b64encode(
        hmac.new(SK.encode(), f"{ts}.{method}.{uri}".encode(), hashlib.sha256).digest()
    ).decode()

def headers(ts, method, uri):
    return {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Timestamp":  ts,
        "X-API-KEY":    AL,
        "X-Customer":   CID,
        "X-Signature":  sig(ts, method, uri),
    }

# ── API 함수 ──────────────────────────────────────────────────────────────
def api_get(uri, params=None, timeout=20):
    ts = str(int(time.time() * 1000))
    try:
        r = requests.get(BASE + uri, headers=headers(ts, "GET", uri), params=params, timeout=timeout)
        if r.status_code == 200:
            return r.json()
        log(f"  GET {uri} → {r.status_code}: {r.text[:200]}")
        return None
    except Exception as e:
        log(f"  GET {uri} 예외: {e}")
        return None

def api_put(uri, body, timeout=20):
    ts = str(int(time.time() * 1000))
    try:
        r = requests.put(BASE + uri, headers=headers(ts, "PUT", uri), json=body, timeout=timeout)
        if r.status_code == 200:
            return True, r.json()
        return False, r.text[:200]
    except Exception as e:
        return False, str(e)

# ── DB 초기화 ──────────────────────────────────────────────────────────────
def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    # 일별 키워드 스냅샷
    c.execute("""
        CREATE TABLE IF NOT EXISTS keyword_history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            run_date    TEXT NOT NULL,
            keyword     TEXT NOT NULL,
            monthly_search INTEGER,
            comp_idx    TEXT,
            avg_depth   REAL,
            old_bid     INTEGER,
            new_bid     INTEGER,
            changed     INTEGER DEFAULT 0,
            reason      TEXT,
            created_at  TEXT DEFAULT (datetime('now','localtime'))
        )
    """)
    # 실행 이력
    c.execute("""
        CREATE TABLE IF NOT EXISTS run_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            run_date    TEXT NOT NULL,
            total_kw    INTEGER,
            changed_kw  INTEGER,
            skipped_kw  INTEGER,
            total_daily_est INTEGER,
            status      TEXT,
            message     TEXT,
            created_at  TEXT DEFAULT (datetime('now','localtime'))
        )
    """)
    conn.commit()
    conn.close()

# ── 스마트 입찰가 계산 알고리즘 ─────────────────────────────────────────────
def calc_smart_bid(keyword, monthly_search, comp_idx, avg_depth, current_bid):
    """
    최소비용 최대노출 입찰가 계산
    
    핵심 로직:
    1. 청소 계열 → 최저가(70원) 유지
    2. 경쟁도 + 검색량 기반 타겟 입찰가 산출
    3. plAvgDepth(현재 평균 노출 순위)로 조정:
       - depth > 5 (6위 이하) → 입찰가 올려야 함
       - depth <= 3 (1~3위)   → 비용 낭비 가능, 소폭 낮춰도 됨
       - depth 4~5            → 유지
    4. 월 예산 초과 방지 캡 적용
    """
    # 청소 계열 → 최저가 고정
    if keyword in CLEAN_KEYWORDS:
        return 70, "청소계열 최저가 고정"

    # 기본 입찰가 테이블 (경쟁도 × 검색량) — 1페이지 상단 진입 목표
    if comp_idx == "높음":
        if monthly_search >= 50000:
            base = 2000
        elif monthly_search >= 20000:
            base = 1500
        elif monthly_search >= 10000:
            base = 1200
        elif monthly_search >= 5000:
            base = 900
        elif monthly_search >= 2000:
            base = 700
        elif monthly_search >= 500:
            base = 500
        else:
            base = 300
    elif comp_idx == "중간":
        if monthly_search >= 20000:
            base = 800
        elif monthly_search >= 5000:
            base = 500
        elif monthly_search >= 1000:
            base = 300
        else:
            base = 150
    else:  # 낮음
        base = 150

    # 순위 보정: plAvgDepth 기반 (1페이지 상단 3위 이내 목표)
    # avg_depth=10 → 하위권(노출 적음) → 입찰가 크게 올려야
    # avg_depth=3  → 상위권(이미 노출) → 유지 or 소폭 낮춰도 됨
    if avg_depth == 0:
        depth_mult = 1.5  # 미노출 → 대폭 올리기
    elif avg_depth <= 2:
        depth_mult = 1.0  # 1~2위: 유지 (이미 최상단)
    elif avg_depth <= 3:
        depth_mult = 1.1  # 3위: 소폭 상향 (목표는 1~2위)
    elif avg_depth <= 5:
        depth_mult = 1.3  # 4~5위: 1페이지 상단으로 올리기
    elif avg_depth <= 7:
        depth_mult = 1.5  # 6~7위: 큰 폭 상승 필요
    else:
        depth_mult = 1.8  # 8~10위: 적극 대폭 상승

    smart = int(base * depth_mult)

    # 상·하한 적용
    smart = max(MIN_BID, min(MAX_BID, smart))

    # 이미 최적 범위(±10%) → 변경 안함
    if abs(smart - current_bid) / max(current_bid, 1) < 0.10:
        return current_bid, f"이미 최적(목표:{smart}원, 변화율<10%)"

    reason = f"검색{monthly_search}건/{comp_idx}/평균{avg_depth}위 → base:{base}×{depth_mult:.1f}={smart}"
    return smart, reason

# ── 메인 실행 ─────────────────────────────────────────────────────────────
def run():
    run_date = datetime.now().strftime("%Y-%m-%d")
    log(f"=== 스마트 입찰 자동화 시작: {run_date} ===")
    init_db()

    # 1. 현재 광고그룹 + 키워드 전체 조회
    log("1단계: 캠페인/광고그룹/키워드 조회...")
    campaigns = api_get("/ncc/campaigns")
    if not campaigns:
        log("ERROR: 캠페인 조회 실패")
        return False

    adgroups = api_get("/ncc/adgroups")
    if not adgroups:
        log("ERROR: 광고그룹 조회 실패")
        return False

    all_keywords = []
    for ag in adgroups:
        kws = api_get("/ncc/keywords", {"nccAdgroupId": ag["nccAdgroupId"]})
        if kws:
            for kw in kws:
                kw["_agId"] = ag["nccAdgroupId"]
            all_keywords.extend(kws)
        time.sleep(0.2)  # API rate limit 방지

    log(f"  → 총 {len(all_keywords)}개 키워드 조회 완료")

    # 2. 키워드별 최신 검색량/경쟁도 조회 & 스마트 입찰가 계산
    log("2단계: 검색량/경쟁도 조회 & 스마트 입찰가 계산...")
    
    results = []
    total_daily_est = 0
    
    for kw in all_keywords:
        kw_name = kw.get("keyword", "")
        kw_id   = kw.get("nccKeywordId", "")
        ag_id   = kw.get("_agId", "")
        cur_bid = kw.get("bidAmt", 70)
        
        # 키워드 도구 조회
        tool_data = api_get("/keywordstool", {"hintKeywords": kw_name, "showDetail": "1"})
        match = None
        if tool_data and "keywordList" in tool_data:
            match = next((x for x in tool_data["keywordList"] if x["relKeyword"] == kw_name), None)
        
        if match:
            pc  = match["monthlyPcQcCnt"] if isinstance(match["monthlyPcQcCnt"], int) else 5
            mob = match["monthlyMobileQcCnt"] if isinstance(match["monthlyMobileQcCnt"], int) else 5
            monthly_search = pc + mob
            comp_idx = match.get("compIdx", "낮음")
            avg_depth = float(match.get("plAvgDepth", 8))
        else:
            monthly_search = 100
            comp_idx = "낮음"
            avg_depth = 8.0

        # 스마트 입찰가 계산
        new_bid, reason = calc_smart_bid(kw_name, monthly_search, comp_idx, avg_depth, cur_bid)
        
        # 예상 일 광고비 추산 (검색량 × CTR 3% × 입찰가 / 30일)
        daily_est = int(monthly_search * 0.03 * new_bid / 30)
        total_daily_est += daily_est

        results.append({
            "keyword":        kw_name,
            "kw_id":          kw_id,
            "ag_id":          ag_id,
            "monthly_search": monthly_search,
            "comp_idx":       comp_idx,
            "avg_depth":      avg_depth,
            "old_bid":        cur_bid,
            "new_bid":        new_bid,
            "changed":        new_bid != cur_bid,
            "reason":         reason,
            "daily_est":      daily_est,
        })
        
        log(f"  [{kw_name}] 검색:{monthly_search}건/{comp_idx}/深{avg_depth} | {cur_bid}→{new_bid}원 ({reason[:40]})")
        time.sleep(0.3)  # API rate limit 방지

    # 3. 일 예산 초과 방지 캡 조정
    log(f"3단계: 일 예산 검토 (예상:{total_daily_est:,}원 / 한도:{DAILY_BUDGET:,}원)...")
    
    if total_daily_est > DAILY_BUDGET:
        ratio = DAILY_BUDGET / total_daily_est
        log(f"  ⚠️ 예산 초과! 전체 입찰가 {ratio:.1%}로 축소 적용")
        for r in results:
            if r["keyword"] not in CLEAN_KEYWORDS:
                r["new_bid"] = max(MIN_BID, int(r["new_bid"] * ratio))
                r["reason"] += f" [예산캡×{ratio:.2f}]"
                r["changed"] = r["new_bid"] != r["old_bid"]
        total_daily_est = int(total_daily_est * ratio)

    # 4. 실제 입찰가 PUT 적용
    log("4단계: 네이버 API 입찰가 적용...")
    changed = [r for r in results if r["changed"]]
    skipped = [r for r in results if not r["changed"]]
    
    log(f"  변경 대상: {len(changed)}개 / 유지: {len(skipped)}개")
    
    apply_ok = 0
    apply_fail = 0
    for r in changed:
        uri = f"/ncc/keywords/{r['kw_id']}"
        url_with_fields = uri + "?fields=nccAdgroupId,useGroupBidAmt,bidAmt"
        # PUT은 uri path만 서명에 사용
        ts = str(int(time.time() * 1000))
        h = headers(ts, "PUT", uri)
        body = {"nccAdgroupId": r["ag_id"], "useGroupBidAmt": False, "bidAmt": r["new_bid"]}
        try:
            resp = requests.put(BASE + url_with_fields, headers=h, json=body, timeout=20)
            if resp.status_code == 200:
                apply_ok += 1
                log(f"  ✅ {r['keyword']}: {r['old_bid']}→{r['new_bid']}원 적용")
            else:
                apply_fail += 1
                log(f"  ❌ {r['keyword']}: PUT 실패 [{resp.status_code}] {resp.text[:100]}")
        except Exception as e:
            apply_fail += 1
            log(f"  ❌ {r['keyword']}: 예외 {e}")
        time.sleep(0.2)

    # 5. DB 저장
    log("5단계: 실행 이력 DB 저장...")
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    
    for r in results:
        c.execute("""
            INSERT INTO keyword_history
            (run_date, keyword, monthly_search, comp_idx, avg_depth,
             old_bid, new_bid, changed, reason)
            VALUES (?,?,?,?,?,?,?,?,?)
        """, (run_date, r["keyword"], r["monthly_search"], r["comp_idx"],
              r["avg_depth"], r["old_bid"], r["new_bid"], int(r["changed"]), r["reason"]))
    
    status = "SUCCESS" if apply_fail == 0 else f"PARTIAL({apply_fail}실패)"
    c.execute("""
        INSERT INTO run_log
        (run_date, total_kw, changed_kw, skipped_kw, total_daily_est, status, message)
        VALUES (?,?,?,?,?,?,?)
    """, (run_date, len(results), apply_ok, len(skipped), total_daily_est,
          status, f"적용:{apply_ok}성공/{apply_fail}실패, 예상일비용:{total_daily_est:,}원"))
    
    conn.commit()
    conn.close()

    log(f"=== 완료: 총{len(results)}개 중 {apply_ok}개 변경, 예상일비용 {total_daily_est:,}원 ===")
    return True

if __name__ == "__main__":
    try:
        success = run()
        sys.exit(0 if success else 1)
    except Exception as e:
        log(f"FATAL ERROR: {e}")
        import traceback
        log(traceback.format_exc())
        sys.exit(1)
