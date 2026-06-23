#!/usr/bin/env python3
"""
키워드 추가 스크립트 — 시스템에어컨 관련 3개
크레딧 사용: POST 3회
"""
import hashlib, hmac, base64, time, requests, json

AL   = "0100000000e8a9e5c719ef2ea8318c370686c95f2e7a575fd22e8075980031db54654aa701"
SK   = "AQAAAADoqeXHGe8uqDGMNwaGyV8ub0ko3GK/zB5aWTFEsaWJMw=="
CID  = "4412351"
BASE = "https://api.naver.com"

QS_GROUP_ID = "grp-a001-01-000000068725999"   # 퀵스타트 그룹

# 추가할 키워드 목록 (keyword, 초기입찰가)
NEW_KEYWORDS = [
    ("시스템에어컨누설수리", 1500),
    ("시스템에어컨수리",     1500),
    ("시스템에어컨누수",     1000),
]

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
    r  = requests.get(BASE + uri, headers=_hdrs(ts, "GET", uri), params=params, timeout=15)
    return r.json() if r.status_code == 200 else None

def api_post(uri, body, params=None):
    ts = str(int(time.time() * 1000))
    r  = requests.post(BASE + uri, headers=_hdrs(ts, "POST", uri),
                       params=params, json=body, timeout=15)
    return r.status_code, r.json() if r.status_code in (200, 201) else r.text[:300]

# ── 1. 기존 키워드 목록 조회 (중복 방지)
print("📋 기존 키워드 조회 중...")
existing = api_get("/ncc/keywords", {"nccAdgroupId": QS_GROUP_ID})
existing_names = set()
if existing:
    existing_names = {k.get("keyword","") for k in existing}
    print(f"  현재 키워드 수: {len(existing_names)}개")
else:
    print("  ⚠️ 기존 키워드 조회 실패 (계속 진행)")

# ── 2. 키워드 추가
print()
for kw, bid in NEW_KEYWORDS:
    if kw in existing_names:
        print(f"  ⏭ [{kw}] 이미 등록됨 — 스킵")
        continue

    # body는 반드시 배열로 (네이버 API 규격)
    body = [{
        "keyword":        kw,
        "bidAmt":         bid,
        "useGroupBidAmt": False,
        "status":         "ELIGIBLE",
    }]
    # nccAdgroupId는 쿼리 파라미터로 전달
    status, resp = api_post("/ncc/keywords", body,
                            params={"nccAdgroupId": QS_GROUP_ID})
    if status in (200, 201):
        kid = resp.get("nccKeywordId", "?") if isinstance(resp, dict) else "?"
        print(f"  ✅ [{kw}] 등록 완료 — ID: {kid}, 입찰가: {bid:,}원")
    else:
        print(f"  ❌ [{kw}] 등록 실패 — {status}: {resp}")
    time.sleep(0.3)

print()
print("완료!")
