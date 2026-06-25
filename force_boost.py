#!/usr/bin/env python3
"""
노출0 키워드 강제 부스트 + KW_MAX_BID 초과 키워드 정리
"""
import hashlib, hmac, base64, time, requests, json, urllib.parse
from datetime import datetime

AL   = '0100000000e8a9e5c719ef2ea8318c370686c95f2e7a575fd22e8075980031db54654aa701'
SK   = 'AQAAAADoqeXHGe8uqDGMNwaGyV8ub0ko3GK/zB5aWTFEsaWJMw=='
CID  = '4412351'
BASE = 'https://api.naver.com'

def _sig(ts, method, uri):
    return base64.b64encode(hmac.new(SK.encode(), f'{ts}.{method}.{uri}'.encode(), hashlib.sha256).digest()).decode()
def _hdrs(ts, method, uri):
    return {'Content-Type':'application/json; charset=UTF-8','X-Timestamp':ts,'X-API-KEY':AL,'X-Customer':CID,'X-Signature':_sig(ts,method,uri)}
def api_get(uri, params=None):
    ts = str(int(time.time()*1000))
    r = requests.get(BASE+uri, headers=_hdrs(ts,'GET',uri), params=params, timeout=15)
    return r.json() if r.status_code==200 else None
def api_put(uri, body, fields=''):
    ts = str(int(time.time()*1000))
    url = BASE + uri + (f'?fields={fields}' if fields else '')
    r = requests.put(url, headers=_hdrs(ts,'PUT',uri), json=body, timeout=15)
    return r.status_code, r.json() if r.status_code==200 else r.text

EXCLUDE_KEYWORDS = {"에어컨청소","삼성에어컨청소","벽걸이에어컨셀프청소","에어컨분해청소","에바크리닝","에어컨청소비용"}

# ── 현재 KW_MAX_BID (기존)
KW_MAX_BID_OLD = {
    "에어컨수리":5000,"에어컨가스충전":5000,"에어컨냉매충전":3000,"에어컨가스":3000,
    "삼성에어컨수리":2000,"LG에어컨수리":2000,"에어컨점검":2000,"에어컨매립배관":1500,
    "에어컨매립배관수리":1500,"에어컨매립배관교체":3000,"에어컨물떨어짐":2000,"에어컨냉매":5000,
    "에어컨실외기소음":5000,"에어컨전기세":5000,"에어컨냉매가스":3000,"에어컨얼음":1000,
    "에어컨성에":700,"대우에어컨수리":700,"위니아에어컨수리":700,"에어컨실외기안돌아감":2000,
    "에어컨소음":3000,"실외기소음":3000,"에어컨안켜짐":2000,"에어컨드레인":2000,"에어컨고장":5000,
    "에어컨가스충전비용":5000,"에어컨바람안나옴":1000,"에어컨물":3000,"창문형에어컨수리":500,
    "에어컨시원하지않음":500,"에어컨전원안켜짐":500,"실외기고장":3000,
    "시스템에어컨누설수리":3000,"시스템에어컨수리":3000,"시스템에어컨누수":2000,
}

# ── 노출0 키워드 상한 상향 조정 (현실적인 경쟁 입찰가로)
# 현재 입찰가가 이미 MAX인데도 노출0 → MAX 자체를 올려야 함
KW_MAX_BID_NEW = {
    **KW_MAX_BID_OLD,
    # 노출0인 키워드들 상한 대폭 상향
    "시스템에어컨수리":    15000,  # 현재 12000 이미 초과, 더 올림
    "시스템에어컨누수":    15000,  # 현재 12000 이미 초과, 더 올림
    "시스템에어컨누설수리": 15000,  # 현재 8000, 더 올림
    "에어컨매립배관수리":   10000,  # 현재 8000 초과, 더 올림
    "에어컨매립배관":       10000,  # 현재 8000 초과, 더 올림
    "창문형에어컨수리":      3000,  # 현재 500 → 3000으로 대폭 상향
    "에어컨전원안켜짐":      3000,  # 현재 500 → 3000으로 대폭 상향
    "대우에어컨수리":       3000,  # 현재 700 → 3000으로 상향
    "에어컨바람안나옴":      3000,  # 현재 1000 → 3000으로 상향
    "에어컨성에":           3000,  # 현재 700 → 3000으로 상향
    "에어컨시원하지않음":    3000,  # 현재 500 → 3000으로 상향
    "에어컨얼음":           3000,  # 현재 1000 → 3000으로 상향 (오늘 1회 노출뿐)
}

today_str = datetime.now().strftime("%Y-%m-%d")

print("=" * 65)
print(f"🚀 노출0 키워드 강제 부스트 ({datetime.now().strftime('%H:%M')} KST)")
print("=" * 65)

# ── 키워드 목록
adgroups = api_get('/ncc/adgroups') or []
all_kws = []
for ag in adgroups:
    if ag.get('userLock') or ag.get('status') == 'PAUSED':
        continue
    if ag.get('adgroupType') not in ('WEB_SITE', None):
        continue
    kws = api_get('/ncc/keywords', {'nccAdgroupId': ag['nccAdgroupId']})
    if kws:
        for kw in kws:
            kw['_agId'] = ag['nccAdgroupId']
        all_kws.extend(kws)
    time.sleep(0.2)

kw_map = {}
for k in all_kws:
    name = k.get('keyword','')
    if name in EXCLUDE_KEYWORDS:
        continue
    if name not in kw_map or k.get('bidAmt',0) > kw_map[name].get('bidAmt',0):
        kw_map[name] = k
all_kws = list(kw_map.values())

# ── stats (오늘)
kw_ids = [k['nccKeywordId'] for k in all_kws]
kw_stats = {}
params = urllib.parse.urlencode({
    'ids': ','.join(kw_ids),
    'fields': '["impCnt","clkCnt","salesAmt"]',
    'timeRange': json.dumps({'since': today_str, 'until': today_str}),
    'timeUnit': 'DAY',
})
ts = str(int(time.time()*1000))
r = requests.get(BASE+'/stats?'+params, headers=_hdrs(ts,'GET','/stats'), timeout=20)
if r.status_code == 200:
    for item in (r.json().get('data') or []):
        sid = item.get('id','')
        st = item.get('statData') or item
        kw_stats[sid] = {'imp': int(st.get('impCnt',0) or 0), 'clk': int(st.get('clkCnt',0) or 0)}

# ── 처리 대상 분류
to_change = []

for kw in all_kws:
    name    = kw.get('keyword','')
    kw_id   = kw.get('nccKeywordId','')
    ag_id   = kw.get('_agId','')
    cur_bid = int(kw.get('bidAmt', 70))
    status  = kw.get('status','')

    if status != 'ELIGIBLE':
        continue

    kw_max_old = KW_MAX_BID_OLD.get(name, 1000)
    kw_max_new = KW_MAX_BID_NEW.get(name, 1000)
    st   = kw_stats.get(kw_id, {})
    imp  = st.get('imp', 0)
    clk  = st.get('clk', 0)

    tag  = ""
    new_bid = cur_bid

    # Case 1: KW_MAX_BID 초과 → 새 MAX로 정리
    if cur_bid > kw_max_new:
        new_bid = kw_max_new
        tag = f"MAX초과({cur_bid}→{new_bid}) 조정"

    # Case 2: 노출0 이고 현재입찰 < 새 MAX → 새 MAX로 올림
    elif imp == 0 and cur_bid < kw_max_new:
        new_bid = kw_max_new
        tag = f"노출0→MAX={kw_max_new}원 강제부스트"

    # Case 3: MAX가 올랐고 현재입찰이 구 MAX에 머물러 있음 → 새 MAX로 올림
    elif kw_max_new > kw_max_old and cur_bid == kw_max_old and imp < 5:
        new_bid = kw_max_new
        tag = f"상한상향({kw_max_old}→{kw_max_new}) 부스트"

    if new_bid == cur_bid or not tag:
        continue

    to_change.append({
        'name': name, 'kw_id': kw_id, 'ag_id': ag_id,
        'cur_bid': cur_bid, 'new_bid': new_bid,
        'imp': imp, 'clk': clk, 'tag': tag,
        'kw_max_new': kw_max_new,
    })

print(f"\n처리 대상: {len(to_change)}개\n")

# ── PUT 실행
ok = fail = 0
for r in to_change:
    uri = f'/ncc/keywords/{r["kw_id"]}'
    sc, res = api_put(
        uri,
        {'nccAdgroupId': r['ag_id'], 'useGroupBidAmt': False, 'bidAmt': r['new_bid']},
        'nccAdgroupId,useGroupBidAmt,bidAmt',
    )
    arrow = "↑" if r['new_bid'] > r['cur_bid'] else "↓"
    if sc == 200:
        print(f"  ✅ [{r['name']:<20}] {r['cur_bid']:>6,}{arrow}{r['new_bid']:>6,}원 | {r['tag']}")
        ok += 1
    else:
        print(f"  ❌ [{r['name']:<20}] 실패[{sc}]: {str(res)[:60]}")
        fail += 1
    time.sleep(0.2)

print(f"\n▶ 완료: 성공 {ok}개 / 실패 {fail}개")

# ── 변경 후 최종 현황
print("\n" + "=" * 65)
print("📋 변경 후 전체 키워드 현황")
print("=" * 65)
time.sleep(1)

# 재조회
all_kws2 = []
for ag in (api_get('/ncc/adgroups') or []):
    if ag.get('userLock') or ag.get('status') == 'PAUSED':
        continue
    if ag.get('adgroupType') not in ('WEB_SITE', None):
        continue
    kws = api_get('/ncc/keywords', {'nccAdgroupId': ag['nccAdgroupId']})
    if kws:
        for kw in kws:
            kw['_agId'] = ag['nccAdgroupId']
        all_kws2.extend(kws)
    time.sleep(0.2)

kw_map2 = {}
for k in all_kws2:
    name = k.get('keyword','')
    if name in EXCLUDE_KEYWORDS:
        continue
    if name not in kw_map2 or k.get('bidAmt',0) > kw_map2[name].get('bidAmt',0):
        kw_map2[name] = k

print(f"\n  {'키워드':<22} {'입찰가':>7} {'새MAX':>7}  {'노출':>6} {'상태'}")
print(f"  {'-'*22} {'-'*7} {'-'*7}  {'-'*6} {'-'*10}")
zero_after = []
for kw in sorted(kw_map2.values(), key=lambda x: x.get('bidAmt',0), reverse=True):
    name    = kw.get('keyword','')
    cur_bid = int(kw.get('bidAmt',70))
    kw_max  = KW_MAX_BID_NEW.get(name, 1000)
    st      = kw_stats.get(kw.get('nccKeywordId',''), {})
    imp     = st.get('imp', 0)
    flag    = "✅ MAX" if cur_bid >= kw_max else f"▲{kw_max-cur_bid:,}원 여유"
    imp_flag = "❌노출없음" if imp == 0 else f"노출{imp}회"
    print(f"  {name:<22} {cur_bid:>7,} {kw_max:>7,}  {imp:>6,}  {flag}")
    if imp == 0:
        zero_after.append(name)

print(f"\n  ▶ 변경 후 노출 0인 키워드: {len(zero_after)}개")
if zero_after:
    print(f"  → {', '.join(zero_after)}")
    print(f"\n  ※ 위 키워드는 입찰가 MAX 올렸지만 검색량 자체가 극히 적거나")
    print(f"     네이버 품질지수/광고심사 대기 상태일 수 있습니다.")
    print(f"     시간이 지나면서 자연스럽게 노출될 예정입니다.")
