#!/usr/bin/env python3
"""
퀵스타트 광고그룹 예산 상향 + scheduler.py 상수 업데이트
"""
import hashlib, hmac, base64, time, requests, json

AL   = '0100000000e8a9e5c719ef2ea8318c370686c95f2e7a575fd22e8075980031db54654aa701'
SK   = 'AQAAAADoqeXHGe8uqDGMNwaGyV8ub0ko3GK/zB5aWTFEsaWJMw=='
CID  = '4412351'
BASE = 'https://api.naver.com'

AG_QS = 'grp-a001-01-000000068725999'  # 퀵스타트 광고그룹
CID_QS = 'cmp-a001-01-000000010739701' # 퀵스타트 캠페인

def _sig(ts, method, uri):
    return base64.b64encode(
        hmac.new(SK.encode(), f'{ts}.{method}.{uri}'.encode(), hashlib.sha256).digest()
    ).decode()

def _hdrs(ts, method, uri):
    return {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Timestamp':  ts,
        'X-API-KEY':    AL,
        'X-Customer':   CID,
        'X-Signature':  _sig(ts, method, uri),
    }

def api_get(uri, params=None):
    ts = str(int(time.time() * 1000))
    r  = requests.get(BASE + uri, headers=_hdrs(ts, 'GET', uri), params=params, timeout=15)
    return r.status_code, r.json() if r.status_code == 200 else r.text

def api_put(uri, body, fields=''):
    ts  = str(int(time.time() * 1000))
    url = BASE + uri + (f'?fields={fields}' if fields else '')
    r   = requests.put(url, headers=_hdrs(ts, 'PUT', uri), json=body, timeout=15)
    return r.status_code, r.json() if r.status_code == 200 else r.text

print("=" * 60)
print("1. 광고그룹 현황 조회")
sc, ag = api_get(f'/ncc/adgroups/{AG_QS}')
print(f"   상태: {sc}")
if sc == 200:
    print(json.dumps(ag, ensure_ascii=False, indent=2))

print()
print("=" * 60)
print("2. 광고그룹 userLock/bidAmt 이외 수정 가능 필드 탐색")

# 시도 1: userLock (항상 가능한 필드)
sc2, res2 = api_put(f'/ncc/adgroups/{AG_QS}', {'userLock': False}, 'userLock')
print(f"   userLock PUT: {sc2}")

time.sleep(0.5)

# 시도 2: dailyBudget만 body에 넣기 (fields 파라미터 없이)
print()
print("3. dailyBudget fields=dailyBudget 재시도...")
sc3, res3 = api_put(f'/ncc/adgroups/{AG_QS}', {'dailyBudget': 100000}, 'dailyBudget')
print(f"   dailyBudget PUT: {sc3} → {str(res3)[:200]}")

time.sleep(0.5)

# 시도 3: budget (캠페인처럼)
print()
print("4. budget fields=budget 시도...")
sc4, res4 = api_put(f'/ncc/adgroups/{AG_QS}', {'budget': 100000}, 'budget')
print(f"   budget PUT: {sc4} → {str(res4)[:200]}")

time.sleep(0.5)

# 시도 4: adgroupBudget
print()
print("5. adgroupBudget 시도...")
sc5, res5 = api_put(f'/ncc/adgroups/{AG_QS}', {'adgroupBudget': 100000}, 'adgroupBudget')
print(f"   adgroupBudget PUT: {sc5} → {str(res5)[:200]}")
