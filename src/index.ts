import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono()
app.use('*', cors())

// ── 인증 ──────────────────────────────────────────────────────────────────────
const AL  = '0100000000e8a9e5c719ef2ea8318c370686c95f2e7a575fd22e8075980031db54654aa701'
const SK  = 'AQAAAADoqeXHGe8uqDGMNwaGyV8ub0ko3GK/zB5aWTFEsaWJMw=='
const CID = '4412351'
const API = 'https://api.naver.com'

// ── 캐시 — 크레딧 절약 최우선 ──────────────────────────────────────────────
const cache: Record<string, { data: unknown; ts: number }> = {}
const TTL_1H    = 60 * 60 * 1000
const TTL_12H   = 12 * 60 * 60 * 1000  // 키워드 목록/캠페인 (잘 안바뀜)
const TTL_3H    =  3 * 60 * 60 * 1000  // 30일·이번달 stats (자주 볼 필요 없음)
const TTL_2H    =  2 * 60 * 60 * 1000  // 어제 실적 (집계 완료 후 고정)
const TTL_6H    =  6 * 60 * 60 * 1000  // 7일 트렌드 (어제까지 데이터, 거의 안바뀜)
const TTL_STATS = TTL_2H               // 어제 단건 기본값

// ── 입찰 변경 이력 (in-memory) ─────────────────────────────────────────
type BidHistoryEntry = {
  keyword:   string
  oldBid:    number
  newBid:    number
  reason:    string
  changedAt: string
}
let bidChangeHistory: BidHistoryEntry[] = []

const EXCLUDE = new Set(['에어컨청소','삼성에어컨청소','벽걸이에어컨셀프청소','에어컨분해청소','에바크리닝','에어컨청소비용'])

const REGIONS_NE = ['남양주','구리','강동','하남','중랑','동대문','노원','강북','성북']
const REGIONS_SW = ['금천','관악','구로','영등포','광명','안양']
const REGIONS    = [...REGIONS_NE, ...REGIONS_SW]

async function sign(ts: string, method: string, uri: string) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(SK), { name:'HMAC', hash:'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}.${method}.${uri}`))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

async function nGet(uri: string, params?: Record<string, string>, ttl = TTL_1H) {
  const ckey = uri + JSON.stringify(params || {})
  if (cache[ckey] && Date.now() - cache[ckey].ts < ttl) return cache[ckey].data
  const url = new URL(API + uri)
  if (params) Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v))
  const ts = String(Date.now())
  const res = await fetch(url.toString(), {
    headers: { 'Content-Type':'application/json; charset=UTF-8', 'X-Timestamp':ts, 'X-API-KEY':AL, 'X-Customer':CID, 'X-Signature': await sign(ts,'GET',uri) }
  })
  if (!res.ok) throw new Error(`GET ${uri} → ${res.status}`)
  const data = await res.json()
  cache[ckey] = { data, ts: Date.now() }
  return data
}

async function nPut(uri: string, body: unknown) {
  const ts = String(Date.now())
  const res = await fetch(API + uri, {
    method:'PUT', body: JSON.stringify(body),
    headers: { 'Content-Type':'application/json; charset=UTF-8', 'X-Timestamp':ts, 'X-API-KEY':AL, 'X-Customer':CID, 'X-Signature': await sign(ts,'PUT',uri) }
  })
  if (!res.ok) throw new Error(`PUT ${uri} → ${res.status} ${await res.text()}`)
  Object.keys(cache).forEach(k => { if (k.includes('/ncc/')) delete cache[k] })
  return res.json()
}

// nStatsKw: 키워드 ID 기준 집계 (timeUnit=TOTAL, 기간 합산용)
async function nStatsKw(ids: string[], since: string, until: string, ckey: string, ttl = TTL_STATS) {
  if (!ids.length) return []
  if (cache[ckey] && Date.now() - cache[ckey].ts < ttl) return cache[ckey].data
  const uri = '/stats'
  // TOTAL 단위로 조회 → date:"?" 문제 없음, 기간 합산값 반환
  const params = new URLSearchParams({
    ids: ids.join(','),
    fields: '["impCnt","clkCnt","salesAmt","ctr","cpc"]',
    timeRange: JSON.stringify({ since, until }),
    timeUnit: 'TOTAL',
  })
  const ts = String(Date.now())
  const res = await fetch(`${API}${uri}?${params}`, {
    headers: { 'Content-Type':'application/json; charset=UTF-8', 'X-Timestamp':ts, 'X-API-KEY':AL, 'X-Customer':CID, 'X-Signature': await sign(ts,'GET',uri) }
  })
  if (!res.ok) throw new Error(`stats → ${res.status}`)
  const d: any = await res.json()
  const data = d.data || []
  cache[ckey] = { data, ts: Date.now() }
  return data
}

// nStatsDay: 광고그룹 ID 기준 DAY 단위 조회 (날짜별 트렌드용)
async function nStatsDay(agIds: string[], since: string, until: string, ckey: string, ttl = TTL_STATS) {
  if (!agIds.length) return []
  if (cache[ckey] && Date.now() - cache[ckey].ts < ttl) return cache[ckey].data
  const uri = '/stats'
  const params = new URLSearchParams({
    ids: agIds.join(','),
    fields: '["impCnt","clkCnt","salesAmt"]',
    timeRange: JSON.stringify({ since, until }),
    timeUnit: 'DAY',
    // 광고그룹 ID로 조회 시 date가 정상 반환됨
  })
  const ts = String(Date.now())
  const res = await fetch(`${API}${uri}?${params}`, {
    headers: { 'Content-Type':'application/json; charset=UTF-8', 'X-Timestamp':ts, 'X-API-KEY':AL, 'X-Customer':CID, 'X-Signature': await sign(ts,'GET',uri) }
  })
  if (!res.ok) throw new Error(`statsDay → ${res.status}`)
  const d: any = await res.json()
  const data = d.data || []
  cache[ckey] = { data, ts: Date.now() }
  return data
}

app.get('/api/data', async (c) => {
  try {
    const lite = c.req.query('lite') === '1'  // lite=1: stats 스킵, 빠른 응답
    const now   = new Date()
    const today = now.toISOString().slice(0,10)

    const [camps, adgroups] = await Promise.all([
      nGet('/ncc/campaigns') as Promise<any[]>,
      nGet('/ncc/adgroups')  as Promise<any[]>,
    ])

    const kwBatch = await Promise.all(
      adgroups.map((ag: any) =>
        nGet('/ncc/keywords', { nccAdgroupId: ag.nccAdgroupId }).catch(() => []) as Promise<any[]>
      )
    )
    const allKw: any[] = (kwBatch as any[][]).flat()
    const kwMap: Record<string, any> = {}
    for (const k of allKw) {
      const existing = kwMap[k.keyword]
      if (!existing || k.bidAmt > existing.bidAmt) kwMap[k.keyword] = k
    }
    const activeKw = Object.values(kwMap).filter((k: any) => !EXCLUDE.has(k.keyword))
    const ids = activeKw.map((k: any) => k.nccKeywordId)

    function sumStats(rows: any[]) {
      const m: Record<string, { imp:number; clk:number; cost:number }> = {}
      for (const row of rows) {
        const id = row.id
        const s = (row.statData && typeof row.statData === 'object') ? row.statData
                : (row.stat    && typeof row.stat    === 'object') ? row.stat
                : row
        if (!m[id]) m[id] = { imp:0, clk:0, cost:0 }
        m[id].imp  += Number(s.impCnt  || 0)
        m[id].clk  += Number(s.clkCnt  || 0)
        m[id].cost += Number(s.salesAmt || 0)
      }
      return m
    }

    let map30: Record<string, any> = {}
    let mapMonth: Record<string, any> = {}

    if (!lite) {
      // 캐시 있으면 즉시, 없으면 API 호출 (TTL 3h)
      const since30    = new Date(Date.now() - 30 * 86400000).toISOString().slice(0,10)
      const monthStart = today.slice(0,7) + '-01'
      const statsHit30    = cache['__stats30__']    && Date.now() - cache['__stats30__'].ts    < TTL_3H
      const statsHitMonth = cache['__statsMonth__'] && Date.now() - cache['__statsMonth__'].ts < TTL_3H

      if (statsHit30 && statsHitMonth) {
        // 캐시 있음 — API 호출 없음
        map30    = sumStats(cache['__stats30__'].data    as any[])
        mapMonth = sumStats(cache['__statsMonth__'].data as any[])
      } else {
        // 캐시 없음 — 병렬로 한 번만 호출
        const [r30, rM] = await Promise.all([
          nStatsKw(ids, since30,    today, '__stats30__',    TTL_3H) as Promise<any[]>,
          nStatsKw(ids, monthStart, today, '__statsMonth__', TTL_3H) as Promise<any[]>,
        ])
        map30    = sumStats(r30)
        mapMonth = sumStats(rM)
      }
    }

    const keywords = activeKw.map((k: any) => {
      const s30 = map30[k.nccKeywordId]    || { imp:0, clk:0, cost:0 }
      const sm  = mapMonth[k.nccKeywordId] || { imp:0, clk:0, cost:0 }
      const ctr  = s30.imp > 0 ? +(s30.clk / s30.imp * 100).toFixed(1) : 0
      const acpc = s30.clk > 0 ? Math.round(s30.cost / s30.clk) : 0
      return {
        id:        k.nccKeywordId,
        agId:      k.nccAdgroupId,
        keyword:   k.keyword,
        bidAmt:    k.bidAmt,
        status:    k.status,
        imp:       s30.imp,
        clk:       s30.clk,
        cost:      s30.cost,
        costMonth: sm.cost,
        ctr,
        acpc,
      }
    })

    const mainCamp = camps.find((c: any) => c.nccCampaignId === 'cmp-a001-01-000000010736912') || camps[0]
    const isOn = mainCamp && !mainCamp.userLock && mainCamp.status === 'ELIGIBLE'

    const dailyBudget    = Number(mainCamp?.dailyBudget || 50000)
    const totalUsedMonth = keywords.reduce((s: number, k: any) => s + k.costMonth, 0)
    const totalUsed30    = keywords.reduce((s: number, k: any) => s + k.cost, 0)
    const todayUsed      = Number(mainCamp?.totalChargeCost || 0)
    const todayRemain    = Math.max(0, dailyBudget - todayUsed)
    const agIds = [...new Set(adgroups.map((ag: any) => ag.nccAdgroupId))]

    return c.json({
      ok: true, isOn, lite,
      camp: mainCamp ? {
        name: mainCamp.name, status: mainCamp.status,
        dailyBudget, totalChargeCost: mainCamp.totalChargeCost || 0,
      } : null,
      budget: {
        daily: dailyBudget, todayUsed, todayRemain,
        monthUsed: totalUsedMonth, total30Used: totalUsed30,
        monthLabel: today.slice(0,7),
      },
      keywords, agIds, regions: REGIONS,
      cachedAt: new Date().toISOString(),
      statsTtlMin: Math.round(TTL_3H / 60000),
    })
  } catch(e: any) { return c.json({ ok:false, error: e.message }, 500) }
})

// ── /api/yesterday: 어제 실적 (광고그룹 합산 + 키워드별 breakdown) ─────────
app.get('/api/yesterday', async (c) => {
  try {
    const [camps, adgroups] = await Promise.all([
      nGet('/ncc/campaigns') as Promise<any[]>,
      nGet('/ncc/adgroups')  as Promise<any[]>,
    ])
    const agIds = [...new Set(adgroups.map((ag: any) => ag.nccAdgroupId))] as string[]

    // 키워드 목록 (캐시 재활용 — ncc 캐시 12h, API 추가 없음)
    const kwBatch = await Promise.all(
      adgroups.map((ag: any) =>
        nGet('/ncc/keywords', { nccAdgroupId: ag.nccAdgroupId }).catch(() => []) as Promise<any[]>
      )
    )
    const allKw: any[] = (kwBatch as any[][]).flat()
    // 동일 키워드 중복 시 높은 입찰가 기준으로 dedup
    const kwMap: Record<string, any> = {}
    for (const k of allKw) {
      if (EXCLUDE.has(k.keyword)) continue
      if (!kwMap[k.keyword] || k.bidAmt > kwMap[k.keyword].bidAmt) kwMap[k.keyword] = k
    }
    const kwList = Object.values(kwMap)
    const kwIds  = kwList.map((k: any) => k.nccKeywordId)
    // id → keyword 이름 맵
    const idToKw: Record<string, any> = {}
    for (const k of kwList) idToKw[k.nccKeywordId] = k

    // 어제 날짜 (KST)
    const kstNow  = new Date(Date.now() + 9 * 3600 * 1000)
    const yestStr = new Date(kstNow.getTime() - 86400000).toISOString().slice(0,10)

    // stats 응답 파싱 (statData 있거나 직접 필드 두 형태 모두 지원)
    function parseStat(row: any) {
      const s = (row.statData && typeof row.statData === 'object') ? row.statData
              : (row.stat    && typeof row.stat    === 'object') ? row.stat
              : row
      return {
        imp:  Number(s.impCnt   || 0),
        clk:  Number(s.clkCnt   || 0),
        cost: Number(s.salesAmt || 0),
      }
    }
    function sumRows(rows: any[]) {
      let imp=0, clk=0, cost=0
      for (const r of rows) { const p=parseStat(r); imp+=p.imp; clk+=p.clk; cost+=p.cost }
      return { imp, clk, cost }
    }

    // ① 광고그룹 기준 합산 — TTL 2h (이미 캐시 있으면 API 0회)
    const rawYest = await nStatsDay(agIds, yestStr, yestStr, `__yest_${yestStr}__`, TTL_2H) as any[]
    const { imp: yImp, clk: yClk, cost: yCost } = sumRows(rawYest)
    const yCtr = yImp > 0 ? +(yClk / yImp * 100).toFixed(2) : 0
    const yCpc = yClk > 0 ? Math.round(yCost / yClk) : 0

    // ② 키워드별 어제 실적 — nStatsKw TOTAL, TTL 2h
    //    캐시 키 분리 → __kwyest_날짜__ (30일 캐시와 구분)
    //    API 1회로 전체 키워드 한꺼번에 조회 (클릭 있는 것만 필터)
    const rawKwYest = kwIds.length
      ? await nStatsKw(kwIds, yestStr, yestStr, `__kwyest_${yestStr}__`, TTL_2H) as any[]
      : []

    const kwYest = rawKwYest
      .map((row: any) => {
        const kw = idToKw[row.id]
        if (!kw) return null
        const { imp, clk, cost } = parseStat(row)
        return { keyword: kw.keyword, bidAmt: kw.bidAmt, imp, clk, cost,
                 ctr: imp > 0 ? +(clk/imp*100).toFixed(2) : 0,
                 cpc: clk > 0 ? Math.round(cost/clk) : 0 }
      })
      .filter((r: any) => r && (r.clk > 0 || r.imp > 0))  // 노출이라도 있는 것만
      .sort((a: any, b: any) => b.clk - a.clk || b.imp - a.imp)

    // ③ 7일 트렌드 — TTL 6h (어제까지 데이터)
    const trend7: { date:string; imp:number; clk:number; cost:number }[] = []
    const dayRaws = await Promise.all(
      Array.from({ length: 7 }, (_, i) => {
        const d = new Date(kstNow.getTime() - (7 - i) * 86400000).toISOString().slice(0,10)
        return nStatsDay(agIds, d, d, `__day_${d}__`, TTL_6H)
          .then((rows: any) => ({ date: d, ...sumRows(rows as any[]) }))
      })
    )
    trend7.push(...dayRaws)

    return c.json({
      ok: true,
      yest:   { date: yestStr, imp: yImp, clk: yClk, cost: yCost, ctr: yCtr, cpc: yCpc },
      kwYest,   // 키워드별 어제 실적 (클릭·노출 있는 것만)
      trend7,
      cachedAt: new Date().toISOString(),
    })
  } catch(e: any) { return c.json({ ok:false, error: e.message }, 500) }
})

app.post('/api/bid', async (c) => {
  try {
    const { nccKeywordId, nccAdgroupId, bidAmt, keyword, oldBid } = await c.req.json()
    const r = await nPut(
      `/ncc/keywords/${nccKeywordId}?fields=nccAdgroupId,useGroupBidAmt,bidAmt`,
      { nccAdgroupId, useGroupBidAmt: false, bidAmt }
    )
    // 입찰가 변경 이력 자동 저장
    if (keyword && oldBid !== undefined) {
      const entry: BidHistoryEntry = {
        keyword,
        oldBid: Number(oldBid),
        newBid: Number(bidAmt),
        reason: '수동 변경',
        changedAt: new Date().toISOString(),
      }
      const today = new Date().toISOString().slice(0, 10)
      bidChangeHistory = [
        ...bidChangeHistory.filter(h => h.changedAt.slice(0, 10) === today),
        entry,
      ].slice(-100)
    }
    return c.json({ ok:true, result: r })
  } catch(e: any) { return c.json({ ok:false, error: e.message }, 500) }
})

// /api/cache?type=ncc  → 입찰가·키워드·캠페인 캐시만 삭제 (새로고침용)
// /api/cache?type=stats → stats 캐시만 삭제 (실적 강제갱신용)
// /api/cache            → 전체 삭제
// 스케줄러가 입찰가 변경 후 클리어할 때 타임스탬프 갱신
let lastBidUpdate = Date.now()

app.delete('/api/cache', (c) => {
  const type = c.req.query('type')
  let cnt = 0
  if (type === 'ncc') {
    // 입찰가·키워드·캠페인만 — stats는 건드리지 않음 (크레딧 절약)
    Object.keys(cache).forEach(k => {
      if (k.includes('/ncc/') || k.includes('/campaigns') || k.includes('/adgroups')) {
        delete cache[k]; cnt++
      }
    })
    lastBidUpdate = Date.now()  // 스케줄러 입찰가 변경 시각 기록
  } else if (type === 'stats') {
    // stats만 — 입찰가는 그대로
    Object.keys(cache).forEach(k => {
      if (!k.includes('/ncc/') && !k.includes('/campaigns') && !k.includes('/adgroups')) {
        delete cache[k]; cnt++
      }
    })
  } else {
    cnt = Object.keys(cache).length
    Object.keys(cache).forEach(k => delete cache[k])
  }
  return c.json({ ok:true, cleared: cnt, type: type || 'all' })
})

// 프론트 폴링용: 마지막 입찰가 변경 시각 반환
app.get('/api/ping', (c) => {
  return c.json({ lastBidUpdate })
})

app.get('/api/history', async (c) => {
  try {
    return c.json({ ok: true, history: bidChangeHistory, updatedAt: new Date().toISOString() })
  } catch(e: any) { return c.json({ ok:false, error: e.message }, 500) }
})

// scheduler.py → POST /api/history-write (자동 입찰가 조정 이력)
app.post('/api/history-write', async (c) => {
  try {
    const body = await c.req.json() as {
      keyword: string; oldBid: number; newBid: number; reason: string; changedAt: string
    }
    const entry: BidHistoryEntry = {
      keyword:   body.keyword,
      oldBid:    Number(body.oldBid),
      newBid:    Number(body.newBid),
      reason:    body.reason || '',
      changedAt: body.changedAt || new Date().toISOString(),
    }
    const today = new Date(Date.now() + 9*3600*1000).toISOString().slice(0, 10) // KST 기준
    bidChangeHistory = [
      ...bidChangeHistory.filter(h => h.changedAt.slice(0, 10) >= today.slice(0,10).replace(/./g, (c,i) => i < 8 ? c : String.fromCharCode(c.charCodeAt(0)-1)) || true),
      entry,
    ].slice(-200) // 최대 200개 보관
    return c.json({ ok: true, total: bidChangeHistory.length })
  } catch(e: any) { return c.json({ ok:false, error: e.message }, 500) }
})

app.get('/', (c) => c.html(PAGE))
export default app

// ══════════════════════════════════════════════════════════════════════════════
const PAGE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>파워링크 광고 관리</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:'Noto Sans KR',sans-serif}
body{background:#f5f6f8;color:#1a1a2e;min-height:100vh;font-size:13px}

/* 네이버 그린 팔레트 */
:root{
  --green:#03C75A;--green-light:#e8faf0;--green-dark:#029a46;
  --blue:#2563eb;--blue-light:#eff6ff;
  --red:#ef4444;--red-light:#fef2f2;
  --yellow:#f59e0b;--yellow-light:#fffbeb;
  --gray-50:#f9fafb;--gray-100:#f3f4f6;--gray-200:#e5e7eb;
  --gray-400:#9ca3af;--gray-500:#6b7280;--gray-600:#4b5563;--gray-700:#374151;--gray-800:#1f2937;
  --white:#ffffff;--border:#e5e7eb;--shadow:0 1px 3px rgba(0,0,0,.08);
}

/* 레이아웃 */
.nav{background:var(--white);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100;box-shadow:var(--shadow)}
.nav-inner{max-width:1320px;margin:0 auto;padding:0 20px;height:52px;display:flex;align-items:center;justify-content:space-between}
.nav-logo{display:flex;align-items:center;gap:8px}
.nav-logo .logo-icon{width:28px;height:28px;background:var(--green);border-radius:6px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:700}
.nav-logo .logo-text{font-size:15px;font-weight:700;color:var(--gray-800)}
.nav-logo .logo-sub{font-size:12px;color:var(--gray-400);margin-left:4px}
.wrap{max-width:1320px;margin:0 auto;padding:20px}

/* 카드 */
.card{background:var(--white);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow)}
.card-header{padding:14px 18px;border-bottom:1px solid var(--gray-100);display:flex;align-items:center;justify-content:space-between}
.card-header h3{font-size:13px;font-weight:700;color:var(--gray-800);display:flex;align-items:center;gap:7px}
.card-body{padding:16px 18px}

/* KPI 카드 */
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px}
.kpi{background:var(--white);border:1px solid var(--border);border-radius:10px;padding:16px 18px;box-shadow:var(--shadow)}
.kpi-label{font-size:11px;color:var(--gray-500);font-weight:500;margin-bottom:6px}
.kpi-val{font-size:24px;font-weight:700;line-height:1;margin-bottom:5px}
.kpi-sub{font-size:11px;color:var(--gray-400)}

/* 상태 뱃지 */
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600}
.badge-on{background:var(--green-light);color:var(--green-dark);border:1px solid #a7f3d0}
.badge-off{background:var(--red-light);color:var(--red);border:1px solid #fecaca}
.badge-wait{background:var(--yellow-light);color:var(--yellow);border:1px solid #fde68a}
.badge-gray{background:var(--gray-100);color:var(--gray-500);border:1px solid var(--gray-200)}
.dot{width:6px;height:6px;border-radius:50%;display:inline-block}
.dot-on{background:var(--green)}
.dot-off{background:var(--red)}

/* 예산 바 */
.budget-bar-wrap{height:8px;background:var(--gray-100);border-radius:4px;overflow:hidden;margin:8px 0}
.budget-bar{height:100%;border-radius:4px;transition:width .6s ease;background:var(--green)}
.budget-bar.warn{background:var(--yellow)}
.budget-bar.danger{background:var(--red)}

/* 테이블 */
.tbl-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
thead tr{background:var(--gray-50);border-bottom:2px solid var(--gray-200)}
th{padding:10px 12px;text-align:left;font-size:11px;font-weight:600;color:var(--gray-500);white-space:nowrap}
th.r{text-align:right}
td{padding:11px 12px;border-bottom:1px solid var(--gray-100);color:var(--gray-700);vertical-align:middle}
td.r{text-align:right}
tbody tr:hover{background:var(--gray-50)}
tbody tr:last-child td{border-bottom:none}

.kw-name{font-weight:600;color:var(--gray-800);font-size:13px}
.bid-val{font-weight:600;color:var(--blue);font-size:13px}
.cost-val{font-weight:700;color:var(--gray-800)}
.no-data{color:var(--gray-300);font-size:12px}
.up-arrow{color:var(--green);font-size:10px}
.down-arrow{color:var(--red);font-size:10px}

/* 탭 */
.tabs{display:flex;gap:0;border-bottom:2px solid var(--gray-200);margin-bottom:16px}
.tab{padding:8px 16px;font-size:13px;font-weight:500;color:var(--gray-500);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;transition:.15s}
.tab.active{color:var(--green);border-bottom-color:var(--green);font-weight:700}
.tab:hover:not(.active){color:var(--gray-700)}

/* 지역 칩 */
.chip{display:inline-flex;align-items:center;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:500;margin:2px}
.chip-ne{background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe}
.chip-sw{background:#f5f3ff;color:#7c3aed;border:1px solid #ddd6fe}

/* 입찰가 수정 패널 */
.bid-panel{background:var(--gray-50);border:1px solid var(--border);border-radius:8px;padding:14px 16px}
.input-row{display:flex;gap:8px;align-items:center;margin-top:10px}
select,input[type=number]{border:1px solid var(--gray-200);border-radius:6px;padding:7px 10px;font-size:13px;color:var(--gray-700);background:var(--white);outline:none;transition:.15s}
select:focus,input:focus{border-color:var(--green);box-shadow:0 0 0 3px rgba(3,199,90,.12)}
.btn{padding:8px 16px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:.15s;display:inline-flex;align-items:center;gap:6px}
.btn-green{background:var(--green);color:#fff}.btn-green:hover{background:var(--green-dark)}
.btn-outline{background:var(--white);border:1px solid var(--border);color:var(--gray-600)}.btn-outline:hover{background:var(--gray-50)}
.btn-sm{padding:5px 11px;font-size:12px}
.btn-red-sm{background:var(--red-light);color:var(--red);border:1px solid #fecaca;padding:5px 10px;font-size:11px;font-weight:600;border-radius:5px;cursor:pointer}

/* 이력 */
.hist-item{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:8px;background:var(--white);border:1px solid var(--gray-100);margin-bottom:6px}
.hist-kw{font-weight:600;color:var(--gray-800);font-size:13px}
.hist-bid{font-size:12px;color:var(--gray-500)}
.hist-time{font-size:11px;color:var(--gray-400)}

/* 토스트 */
#toast{position:fixed;bottom:24px;right:24px;padding:12px 18px;border-radius:8px;font-size:13px;font-weight:500;opacity:0;transition:opacity .3s;z-index:9999;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.15)}

/* 로딩 */
#loading{position:fixed;inset:0;background:rgba(245,246,248,.92);display:flex;align-items:center;justify-content:center;z-index:200;flex-direction:column;gap:12px}
.spinner{width:32px;height:32px;border:3px solid var(--gray-200);border-top-color:var(--green);border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* 어제 실적 카드 */
.yest-card{background:linear-gradient(135deg,#f0fdf4 0%,#ecfdf5 100%);border:1px solid #a7f3d0;border-radius:10px;padding:16px 20px;margin-bottom:14px;box-shadow:var(--shadow)}
.yest-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.yest-title{font-size:13px;font-weight:700;color:#065f46;display:flex;align-items:center;gap:6px}
.yest-date{font-size:11px;color:#6b7280;background:#fff;border:1px solid #d1fae5;border-radius:20px;padding:2px 10px}
.yest-stats{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
.yest-stat{text-align:center}
.yest-stat-label{font-size:10px;color:#6b7280;margin-bottom:3px;font-weight:500}
.yest-stat-val{font-size:20px;font-weight:700;line-height:1}
.yest-stat-sub{font-size:10px;color:#9ca3af;margin-top:2px}
.yest-empty{text-align:center;padding:20px;color:#6b7280;font-size:12px}
.cache-badge{font-size:10px;color:#9ca3af;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:20px;padding:2px 8px;display:inline-flex;align-items:center;gap:4px}
.cache-badge.fresh{color:#059669;background:#ecfdf5;border-color:#a7f3d0}

/* 트렌드 차트 */
.chart-card{background:var(--white);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow);margin-bottom:14px}
.chart-wrap{padding:14px 18px 8px;position:relative;height:200px}

/* 데스크탑 전용 (모바일에서 숨김) */
.desktop-only{display:table-cell}
@media(max-width:480px){.desktop-only{display:none!important}}

/* 반응형 */
@media(max-width:900px){
  .kpi-grid{grid-template-columns:repeat(2,1fr)}
  .main-grid{grid-template-columns:1fr!important}
  .yest-stats{grid-template-columns:repeat(3,1fr)}
}

/* ── 모바일 (480px 이하) ── */
@media(max-width:480px){
  body{font-size:13px}
  .wrap{padding:8px 10px;padding-bottom:80px} /* 하단 고정바 공간 */
  .nav-inner{padding:0 12px;height:48px}
  .nav-logo .logo-sub{display:none}
  .kpi-grid{grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:10px}
  .kpi{padding:12px 14px}
  .kpi-val{font-size:20px}
  /* 어제실적 */
  .yest-card{padding:12px 14px}
  .yest-stats{grid-template-columns:repeat(3,1fr);gap:8px}
  .yest-stat-val{font-size:16px}
  /* 트렌드 차트 */
  .chart-wrap{height:160px}
  /* 예산 숫자 줄바꿈 허용 */
  .budget-nums{flex-wrap:wrap;gap:8px!important}
  .budget-nums>div{min-width:calc(50% - 8px)}
  /* 테이블 → 카드형 */
  .tbl-wrap table,
  .tbl-wrap thead,
  .tbl-wrap tbody,
  .tbl-wrap th,
  .tbl-wrap td,
  .tbl-wrap tr{display:block}
  .tbl-wrap thead{display:none}
  .tbl-wrap tbody tr{
    background:var(--white);
    border:1px solid var(--gray-200);
    border-radius:10px;
    margin-bottom:8px;
    padding:10px 12px;
    position:relative;
  }
  .tbl-wrap tbody tr:hover{background:var(--white)}
  .tbl-wrap td{
    border:none;
    padding:2px 0;
    text-align:left!important;
    display:flex;
    align-items:center;
    justify-content:space-between;
    font-size:12px;
  }
  .tbl-wrap td::before{
    content:attr(data-label);
    font-size:11px;
    color:var(--gray-400);
    font-weight:500;
    min-width:52px;
    flex-shrink:0;
  }
  .tbl-wrap td:first-child{display:none} /* # 숫자 숨김 */
  .tbl-wrap td.kw-name-cell{
    font-size:14px;
    font-weight:700;
    color:var(--gray-800);
    justify-content:flex-start;
    padding-bottom:6px;
    border-bottom:1px solid var(--gray-100);
    margin-bottom:4px;
  }
  .tbl-wrap td.kw-name-cell::before{display:none}
  /* 오른쪽 패널 전체 숨김 (모바일엔 하단바로 대체) */
  .right-panel{display:none}
  /* 하단 고정 입찰가 수정바 */
  #mobile-bid-bar{
    display:flex!important;
    position:fixed;
    bottom:0;left:0;right:0;
    background:var(--white);
    border-top:1px solid var(--border);
    box-shadow:0 -2px 12px rgba(0,0,0,.10);
    padding:10px 12px;
    gap:8px;
    align-items:center;
    z-index:200;
  }
  #toast{bottom:80px;right:12px;left:12px;text-align:center}
  .yest-header{flex-wrap:wrap;gap:6px}
  .card-header{padding:12px 14px}
  .card-body{padding:12px 14px}
}
</style>
</head>
<body>

<div id="loading">
  <div class="spinner"></div>
  <p style="color:#6b7280;font-size:13px">광고 데이터 불러오는 중...</p>
</div>
<div id="toast"></div>

<!-- 상단 네비 -->
<nav class="nav">
  <div class="nav-inner">
    <div class="nav-logo">
      <div class="logo-icon">N</div>
      <span class="logo-text">파워링크</span>
      <span class="logo-sub">광고 관리</span>
      <span id="camp-status" class="badge badge-gray" style="margin-left:10px">확인중</span>
    </div>
    <div style="display:flex;align-items:center;gap:10px">
      <span id="cached-at" style="font-size:11px;color:var(--gray-400)"></span>
      <button class="btn btn-outline btn-sm" onclick="hardRefresh()">
        <i class="fas fa-sync-alt" id="ri"></i> 새로고침
      </button>
    </div>
  </div>
</nav>

<div class="wrap">

  <!-- KPI 4개 -->
  <div class="kpi-grid" style="margin-bottom:14px">
    <div class="kpi">
      <div class="kpi-label">광고 상태</div>
      <div id="k-status" class="kpi-val" style="font-size:18px;color:var(--gray-400)">—</div>
      <div id="k-budget-label" class="kpi-sub">일예산 확인중</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">운영 키워드</div>
      <div id="k-kw" class="kpi-val" style="color:var(--green)">—</div>
      <div class="kpi-sub" id="k-region-sub">15개 지역 노출</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">이번 달 사용</div>
      <div id="k-month" class="kpi-val" style="color:var(--gray-800)">—</div>
      <div id="k-30d" class="kpi-sub">30일 누적 —</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">30일 클릭 · CPC</div>
      <div id="k-clk" class="kpi-val" style="color:var(--blue)">—</div>
      <div id="k-cpc" class="kpi-sub">평균 CPC —</div>
    </div>
  </div>

  <!-- 어제 실적 카드 -->
  <div class="yest-card" id="yest-card">
    <div class="yest-header">
      <div class="yest-title">
        <i class="fas fa-chart-bar"></i>
        어제 실적
        <span id="yest-date-badge" class="yest-date">날짜 로딩중...</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span id="yest-cache-badge" class="cache-badge"><i class="fas fa-database"></i>캐시 1h</span>
        <button class="btn btn-outline btn-sm" onclick="refreshYest()" id="yest-refresh-btn" style="font-size:11px;padding:4px 10px">
          <i class="fas fa-sync-alt" id="yri"></i> 실적 새로고침
        </button>
      </div>
    </div>
    <div id="yest-body">
      <div class="yest-empty"><div class="spinner" style="margin:0 auto 6px;width:20px;height:20px;border-width:2px"></div>어제 실적 불러오는 중...</div>
    </div>
  </div>

  <!-- 7일 트렌드 차트 -->
  <div class="chart-card" id="trend-card" style="display:none">
    <div class="card-header">
      <h3><i class="fas fa-chart-line" style="color:var(--blue)"></i>최근 7일 트렌드 <span style="font-size:11px;font-weight:400;color:var(--gray-400)">노출·클릭</span></h3>
      <span id="trend-updated" style="font-size:10px;color:var(--gray-400)"></span>
    </div>
    <div class="chart-wrap">
      <canvas id="trendChart"></canvas>
    </div>
  </div>

  <!-- 예산 카드 -->
  <div class="card" style="margin-bottom:14px">
    <div class="card-body" style="padding:14px 18px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
        <span style="font-size:13px;font-weight:700;color:var(--gray-800)">
          <i class="fas fa-wallet" style="color:var(--yellow);margin-right:6px"></i>예산 현황
        </span>
        <div class="budget-nums" style="display:flex;gap:24px;flex-wrap:wrap">
          <div>
            <div style="font-size:10px;color:var(--gray-400);margin-bottom:2px">일예산</div>
            <div id="b-daily" style="font-size:15px;font-weight:700;color:var(--gray-800)">—</div>
          </div>
          <div>
            <div style="font-size:10px;color:var(--gray-400);margin-bottom:2px">오늘 사용</div>
            <div id="b-used" style="font-size:15px;font-weight:700;color:var(--gray-800)">—</div>
          </div>
          <div>
            <div style="font-size:10px;color:var(--gray-400);margin-bottom:2px">오늘 남은 예산</div>
            <div id="b-remain" style="font-size:15px;font-weight:700;color:var(--green)">—</div>
          </div>
          <div style="border-left:1px solid var(--gray-200);padding-left:24px">
            <div id="b-month-label" style="font-size:10px;color:var(--gray-400);margin-bottom:2px">이번달 누적</div>
            <div id="b-month" style="font-size:15px;font-weight:700;color:#7c3aed">—</div>
          </div>
        </div>
      </div>
      <div class="budget-bar-wrap">
        <div id="budget-bar" class="budget-bar" style="width:0%"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--gray-400);margin-top:4px">
        <span id="b-pct">0%</span>
        <span>일예산 <span id="b-daily2">—</span></span>
      </div>
    </div>
  </div>

  <!-- 메인 2컬럼 -->
  <div class="main-grid" style="display:grid;grid-template-columns:1fr 320px;gap:14px;align-items:start">

    <!-- 왼쪽: 키워드 테이블 -->
    <div>
      <div class="card">
        <div class="card-header">
          <h3>
            <i class="fas fa-search" style="color:var(--green)"></i>
            키워드별 실적
            <span id="kw-count" style="font-size:11px;font-weight:400;color:var(--gray-400)">30일 기준</span>
          </h3>
          <div style="display:flex;align-items:center;gap:8px">
            <span id="kw-total-badge" style="background:var(--green-light);color:var(--green-dark);font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px"></span>
            <!-- 정렬 탭 -->
            <select id="sort-sel" onchange="applySort()" style="font-size:11px;padding:4px 8px;border-radius:5px;border:1px solid var(--gray-200);color:var(--gray-600);cursor:pointer">
              <option value="bid">입찰가 순</option>
              <option value="cost">비용 순</option>
              <option value="imp">노출 순</option>
              <option value="ctr">CTR 순</option>
            </select>
          </div>
        </div>
        <!-- 안내 박스 (데이터 없을 때) -->
        <div id="no-data-box" style="display:none;margin:12px 18px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px 14px">
          <div style="font-size:12px;font-weight:600;color:#92400e;margin-bottom:4px">
            <i class="fas fa-clock" style="margin-right:5px"></i>아직 실적 데이터 없음
          </div>
          <div style="font-size:11px;color:#b45309;line-height:1.6">
            광고 ON 상태입니다. 오늘 집행 데이터는 내일 이후 표시됩니다.<br>
            실적은 전일 기준 · 2~6h 캐시. 상단 "실적 새로고침"으로 강제 갱신 가능.
          </div>
        </div>
        <div class="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th style="width:36px">#</th>
                <th>키워드</th>
                <th class="r">입찰가</th>
                <th class="r">상태</th>
                <th class="r">노출</th>
                <th class="r">클릭</th>
                <th class="r">CTR</th>
                <th class="r">실제비용</th>
                <th class="r">CPC</th>
                <th class="r" style="width:60px">수정</th>
              </tr>
            </thead>
            <tbody id="kw-body">
              <tr><td colspan="10" style="text-align:center;padding:40px;color:var(--gray-300)">
                <div class="spinner" style="margin:0 auto 8px"></div>
              </td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 오른쪽 패널 -->
    <div class="right-panel" style="display:flex;flex-direction:column;gap:12px">

      <!-- 입찰가 수정 -->
      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-edit" style="color:var(--blue)"></i>입찰가 수정</h3>
        </div>
        <div class="card-body">
          <div style="font-size:11px;color:var(--gray-500);margin-bottom:6px">키워드 선택</div>
          <select id="bid-sel" style="width:100%;font-size:12px">
            <option value="">키워드를 선택하세요...</option>
          </select>
          <div id="cur-bid-info" style="font-size:11px;color:var(--gray-400);margin:7px 0 0;display:none">
            현재 입찰가: <strong id="cur-bid-val" style="color:var(--blue)"></strong>원
          </div>
          <div class="input-row" style="margin-top:10px">
            <input id="bid-val" type="number" min="70" step="10" placeholder="새 입찰가 (원)" style="flex:1;min-width:0"/>
            <button class="btn btn-green btn-sm" onclick="applyBid()">
              <i class="fas fa-check"></i> 적용
            </button>
          </div>
          <div style="font-size:10px;color:var(--gray-400);margin-top:6px">최소 70원 · 10원 단위</div>
        </div>
      </div>

      <!-- 지역 타겟 -->
      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-map-marker-alt" style="color:var(--yellow)"></i>타겟 지역 <span style="font-size:11px;font-weight:400;color:var(--gray-400)">15개</span></h3>
        </div>
        <div class="card-body" style="padding:12px 16px">
          <div style="margin-bottom:8px">
            <span style="font-size:10px;color:#2563eb;font-weight:600;letter-spacing:.3px">동북권</span>
            <div id="chips-ne" style="margin-top:4px"></div>
          </div>
          <div>
            <span style="font-size:10px;color:#7c3aed;font-weight:600;letter-spacing:.3px">서남권</span>
            <div id="chips-sw" style="margin-top:4px"></div>
          </div>
        </div>
      </div>

      <!-- 스케줄 -->
      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-clock" style="color:var(--green)"></i>자동 스케줄</h3>
        </div>
        <div class="card-body" style="padding:12px 16px">
          <div style="display:flex;flex-direction:column;gap:8px">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--gray-50);border-radius:6px">
              <div>
                <div style="font-size:12px;font-weight:600;color:var(--gray-700)">광고 OFF</div>
                <div style="font-size:10px;color:var(--gray-400)">새벽 1시 (KST)</div>
              </div>
              <span class="badge badge-gray" style="font-size:10px">01:00</span>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--gray-50);border-radius:6px">
              <div>
                <div style="font-size:12px;font-weight:600;color:var(--gray-700)">광고 ON + 입찰 최적화</div>
                <div style="font-size:10px;color:var(--gray-400)">아침 7시 (KST)</div>
              </div>
              <span class="badge badge-on" style="font-size:10px">07:00</span>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--gray-50);border-radius:6px">
              <div>
                <div style="font-size:12px;font-weight:600;color:var(--gray-700)">2시간 점검</div>
                <div style="font-size:10px;color:var(--gray-400)">09~23시 매 2시간</div>
              </div>
              <span class="badge badge-on" style="font-size:10px">스윗스팟</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 입찰 변경 이력 -->
      <div class="card">
        <div class="card-header">
          <h3><i class="fas fa-history" style="color:var(--gray-500)"></i>입찰 변경 이력</h3>
          <button class="btn-red-sm" onclick="loadHistory()">새로고침</button>
        </div>
        <div class="card-body" style="padding:10px 14px">
          <div id="hist-list">
            <div style="text-align:center;padding:20px 0;color:var(--gray-300);font-size:12px">이력 없음</div>
          </div>
        </div>
      </div>

    </div><!-- /right -->
  </div><!-- /main-grid -->
</div><!-- /wrap -->

<!-- 모바일 하단 고정 입찰가 수정바 (480px 이하에서만 표시) -->
<div id="mobile-bid-bar" style="display:none">
  <select id="mbid-sel" style="flex:1;min-width:0;font-size:13px;border:1px solid var(--gray-200);border-radius:8px;padding:8px 10px;color:var(--gray-700);background:var(--white)">
    <option value="">키워드 선택...</option>
  </select>
  <input id="mbid-val" type="number" min="70" step="10" placeholder="입찰가" style="width:90px;font-size:13px;border:1px solid var(--gray-200);border-radius:8px;padding:8px 10px;color:var(--gray-700)"/>
  <button onclick="applyMobileBid()" style="background:var(--green);color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:700;white-space:nowrap;cursor:pointer">
    <i class="fas fa-check"></i>
  </button>
</div>

<script>
let D = null
let YD = null
let trendChart = null
let _lastBidUpdate = 0  // 마지막으로 확인한 서버 입찰가 변경 시각

// ────────────────────────── 초기 로드 ──────────────────────────
// ────────────────────────── 자동 새로고침 폴링 ──────────────────────────
// 30초마다 서버 lastBidUpdate 확인 → 변경 감지 시 자동으로 입찰가 재로드
function startAutoRefresh() {
  setInterval(async () => {
    try {
      const r = await fetch('/api/ping')
      const { lastBidUpdate } = await r.json()
      if (_lastBidUpdate === 0) {
        _lastBidUpdate = lastBidUpdate  // 초기값 세팅
        return
      }
      if (lastBidUpdate > _lastBidUpdate) {
        _lastBidUpdate = lastBidUpdate
        // 스케줄러가 입찰가 변경 → NCC 데이터 자동 재로드
        const r2 = await fetch('/api/data?lite=1')
        const d2 = await r2.json()
        if (d2.ok) {
          D = d2
          render()
          if (YD) renderYesterday()
          toast('🔄 입찰가 자동 업데이트됨', 'ok')
        }
      }
    } catch(e) { /* 폴링 실패는 조용히 무시 */ }
  }, 30000)  // 30초마다
}

async function init() {
  const loadingEl = document.getElementById('loading')
  const slowTimer = setTimeout(() => {
    loadingEl.querySelector('p').textContent = '네이버 API 응답 대기 중... (첫 로드는 10~20초 소요)'
  }, 5000)

  try {
    // ── 1단계: lite=1 로 빠르게 (캠페인+키워드+입찰가, stats 스킵)
    const r1 = await fetch('/api/data?lite=1')
    D = await r1.json()
    clearTimeout(slowTimer)
    if (!D.ok) throw new Error(D.error)
    render()
    loadHistory()
    loadingEl.style.display = 'none'
    // 어제 실적은 비동기 병렬 (블로킹 안 함)
    loadYesterday()

    // ── 2단계: 백그라운드에서 stats 채워서 재렌더 (30일·이번달 실적)
    fetch('/api/data').then(r2 => r2.json()).then(d2 => {
      if (d2.ok) {
        D = d2
        render()  // 실적 컬럼 업데이트
        if (YD) renderYesterday()  // 어제 실적 입찰가도 최신 D로 갱신
      }
    }).catch(() => {/* 2단계 실패해도 1단계 렌더는 유지 */})

  } catch(e) {
    clearTimeout(slowTimer)
    loadingEl.innerHTML =
      '<div style="color:#ef4444;font-size:13px;text-align:center">' +
      '<i class="fas fa-exclamation-circle" style="margin-bottom:8px;display:block;font-size:24px"></i>' +
      e.message + '<br><button onclick="location.reload()" style="margin-top:12px;padding:6px 16px;background:#03C75A;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">다시 시도</button>' +
      '</div>'
    return
  }
  startAutoRefresh()  // 초기 로드 성공 후 자동 새로고침 폴링 시작
}

async function hardRefresh() {
  const ic = document.getElementById('ri')
  ic.classList.add('fa-spin')
  // ncc만 클리어: 입찰가·키워드·캠페인 새로고침 (크레딧 절약 — stats는 건드리지 않음)
  await fetch('/api/cache?type=ncc', { method:'DELETE' })
  const r = await fetch('/api/data')
  D = await r.json()
  render()
  loadHistory()
  if (YD) renderYesterday()  // 어제 실적 입찰가도 최신값으로 갱신
  ic.classList.remove('fa-spin')
  toast('입찰가·상태를 새로 불러옴. 실적은 ' + (D.statsTtlMin||60) + '분 캐시 유지', 'ok')
}

// ────────────────────────── 어제 실적 로드 ──────────────────────────
async function loadYesterday() {
  try {
    const r = await fetch('/api/yesterday')
    YD = await r.json()
    renderYesterday()
  } catch(e) {
    document.getElementById('yest-body').innerHTML =
      '<div class="yest-empty" style="color:#ef4444"><i class="fas fa-exclamation-triangle" style="margin-right:4px"></i>실적 조회 실패: ' + e.message + '</div>'
  }
}

async function refreshYest() {
  const ic = document.getElementById('yri')
  const btn = document.getElementById('yest-refresh-btn')
  ic.classList.add('fa-spin')
  btn.disabled = true
  // stats 캐시만 클리어 — 입찰가는 그대로
  await fetch('/api/cache?type=stats', { method:'DELETE' })
  await loadYesterday()
  ic.classList.remove('fa-spin')
  btn.disabled = false
  toast('어제 실적 강제 갱신 완료', 'ok')
}

function renderYesterday() {
  if (!YD) return
  const yestBody = document.getElementById('yest-body')
  const dateBadge = document.getElementById('yest-date-badge')

  if (!YD.ok) {
    yestBody.innerHTML = '<div class="yest-empty" style="color:#ef4444"><i class="fas fa-exclamation-triangle"></i> ' + (YD.error || '조회 실패') + '</div>'
    return
  }

  const y = YD.yest || {}
  // 날짜 표시 (MM.DD 형식)
  const dLabel = y.date ? y.date.slice(5).replace('-','.') : '—'
  dateBadge.textContent = dLabel + ' 기준'

  // 캐시 배지 업데이트
  const cacheBadge = document.getElementById('yest-cache-badge')
  cacheBadge.className = 'cache-badge fresh'
  const ca = YD.cachedAt ? new Date(YD.cachedAt).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}) : ''
  cacheBadge.innerHTML = '<i class="fas fa-check-circle"></i>' + ca + ' 갱신'

  const hasData = (y.imp > 0 || y.clk > 0)

  if (!hasData) {
    yestBody.innerHTML =
      '<div class="yest-empty">' +
      '<i class="fas fa-moon" style="color:#9ca3af;margin-right:6px"></i>' +
      '어제(' + dLabel + ') 실적 없음 — 광고 미집행 또는 집계 대기 중</div>'
  } else {
    // ① 합산 KPI
    yestBody.innerHTML =
      '<div class="yest-stats">' +
      stat('노출', y.imp.toLocaleString(), '회',  'var(--gray-800)') +
      stat('클릭', y.clk > 0 ? y.clk.toLocaleString() : '0', '회', y.clk > 0 ? '#2563eb' : 'var(--gray-400)') +
      stat('CTR',  y.imp > 0 ? y.ctr + '%' : '—', '', y.ctr >= 1 ? 'var(--green)' : y.ctr > 0 ? '#f59e0b' : 'var(--gray-400)') +
      stat('비용',  y.cost > 0 ? fmt(y.cost) + '원' : '0원', '', y.cost > 0 ? '#7c3aed' : 'var(--gray-400)') +
      stat('CPC',  y.cpc  > 0 ? fmt(y.cpc)  + '원' : '—',   '', y.cpc  > 0 ? 'var(--gray-800)' : 'var(--gray-400)') +
      '</div>'
  }

  // ② 키워드별 breakdown (노출·클릭 있는 것만)
  const kws = YD.kwYest || []
  if (kws.length > 0) {
    let tbl = '<div style="margin-top:12px;border-top:1px solid #d1fae5;padding-top:10px">'
    const clkNote = y.clk > 0
      ? ' <span style="color:#2563eb">(클릭 ' + y.clk + '건은 광고그룹 집계 기준 — 키워드별 클릭은 API 미지원)</span>'
      : ''
    tbl += '<div style="font-size:11px;font-weight:600;color:#065f46;margin-bottom:6px"><i class="fas fa-list" style="margin-right:4px"></i>키워드별 노출 현황' + clkNote + '</div>'
    tbl += '<table style="width:100%;border-collapse:collapse;font-size:12px">'
    tbl += '<thead><tr style="background:#f0fdf4">'
    tbl += '<th style="padding:5px 8px;text-align:left;color:#6b7280;font-weight:600;font-size:11px">키워드</th>'
    tbl += '<th style="padding:5px 8px;text-align:right;color:#6b7280;font-weight:600;font-size:11px">입찰가(현재)</th>'
    tbl += '<th style="padding:5px 8px;text-align:right;color:#6b7280;font-weight:600;font-size:11px">노출</th>'
    tbl += '</tr></thead><tbody>'
    // D.keywords 에서 최신 입찰가 맵 생성
    const liveBidMap = {}
    if (D && D.keywords) D.keywords.forEach(k => { liveBidMap[k.keyword] = k.bidAmt })
    for (const k of kws) {
      // 노출 비율 바 (최대 기준)
      const maxImp = Math.max(...kws.map(x => x.imp), 1)
      const pct = Math.round(k.imp / maxImp * 100)
      // 최신 입찰가 우선 (D.keywords), 없으면 stats에 담긴 값
      const liveBid = liveBidMap[k.keyword] ?? k.bidAmt
      tbl += '<tr style="border-bottom:1px solid #f0fdf4">'
      tbl += '<td style="padding:6px 8px;font-weight:600;color:#1f2937">' + k.keyword + '</td>'
      tbl += '<td style="padding:6px 8px;text-align:right;color:#2563eb;white-space:nowrap;font-weight:700">' + fmt(liveBid) + '원</td>'
      tbl += '<td style="padding:6px 8px;min-width:100px">'
        + '<div style="display:flex;align-items:center;gap:5px;justify-content:flex-end">'
        + '<div style="flex:1;max-width:60px;height:5px;background:#e5e7eb;border-radius:3px;overflow:hidden">'
        + '<div style="width:' + pct + '%;height:100%;background:#03C75A;border-radius:3px"></div></div>'
        + '<span style="font-size:12px;color:#374151;min-width:28px;text-align:right">' + k.imp + '</span>'
        + '</div></td>'
      tbl += '</tr>'
    }
    tbl += '</tbody></table></div>'
    yestBody.innerHTML += tbl
  }

  // ③ 세팅 가이드
  let guide = ''
  if (y.ctr >= 1) {
    guide = '<div style="margin-top:10px;padding:7px 12px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:6px;font-size:11px;color:#065f46"><i class="fas fa-check-circle" style="margin-right:4px"></i>CTR ' + y.ctr + '% — 스윗스팟. 입찰가 -8% 자동 조정 예정</div>'
  } else if (y.ctr > 0) {
    guide = '<div style="margin-top:10px;padding:7px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;font-size:11px;color:#92400e"><i class="fas fa-minus-circle" style="margin-right:4px"></i>CTR ' + y.ctr + '% — 낮음. 입찰가 -10% 자동 조정 예정</div>'
  } else if (y.imp === 0) {
    guide = '<div style="margin-top:10px;padding:7px 12px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;font-size:11px;color:#1e40af"><i class="fas fa-arrow-up" style="margin-right:4px"></i>노출 없음 → 입찰가 +15% 자동 상향 예정</div>'
  }
  yestBody.innerHTML += guide

  // ④ 차트
  if (YD.trend7 && YD.trend7.length > 0) renderTrendChart(YD.trend7)
}

function stat(label, val, unit, color) {
  return '<div class="yest-stat">' +
    '<div class="yest-stat-label">' + label + '</div>' +
    '<div class="yest-stat-val" style="color:' + color + '">' + val + '</div>' +
    '<div class="yest-stat-sub">' + unit + '</div>' +
    '</div>'
}

function renderTrendChart(trend7) {
  const card = document.getElementById('trend-card')
  card.style.display = 'block'

  const labels = trend7.map(d => d.date.slice(5).replace('-','.'))
  const impData = trend7.map(d => d.imp)
  const clkData = trend7.map(d => d.clk)

  const ctx = document.getElementById('trendChart').getContext('2d')
  if (trendChart) { trendChart.destroy() }
  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: '노출',
          data: impData,
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239,68,68,.08)',
          tension: .3,
          pointRadius: 4,
          pointBackgroundColor: '#ef4444',
          fill: true,
          yAxisID: 'y',
        },
        {
          label: '클릭',
          data: clkData,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245,158,11,.08)',
          tension: .3,
          pointRadius: 5,
          pointBackgroundColor: '#f59e0b',
          fill: true,
          yAxisID: 'y2',
        },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode:'index', intersect:false },
      plugins: {
        legend: { position:'top', labels:{ font:{ size:11 }, padding:12 } },
        tooltip: {
          callbacks: {
            label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y.toLocaleString() + (ctx.dataset.label === '노출' ? '회' : '회')
          }
        }
      },
      scales: {
        x: { grid:{ color:'#f3f4f6' }, ticks:{ font:{ size:11 } } },
        y: {
          type:'linear', display:true, position:'left',
          grid:{ color:'#f3f4f6' },
          ticks:{ font:{ size:10 }, color:'#ef4444' },
          title:{ display:true, text:'노출', color:'#ef4444', font:{ size:10 } }
        },
        y2: {
          type:'linear', display:true, position:'right',
          grid:{ drawOnChartArea:false },
          ticks:{ font:{ size:10 }, color:'#f59e0b' },
          title:{ display:true, text:'클릭', color:'#f59e0b', font:{ size:10 } }
        },
      }
    }
  })
  document.getElementById('trend-updated').textContent = '7일(' + labels[0] + '~' + labels[labels.length-1] + ')'
}

// ────────────────────────── 렌더 ──────────────────────────
function render() {
  renderKpi()
  renderBudget()
  renderTable()
  renderBidSelect()
  renderRegions()
  const ca = document.getElementById('cached-at')
  if (D.cachedAt) {
    const t = new Date(D.cachedAt)
    ca.textContent = t.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}) + ' 기준'
  }
}

function renderKpi() {
  const b   = D.budget || {}
  const kws = D.keywords || []
  const isOn = D.isOn

  // 상태
  const st = document.getElementById('k-status')
  const badge = document.getElementById('camp-status')
  if (isOn) {
    st.textContent = '광고 ON'
    st.style.color = 'var(--green)'
    badge.className = 'badge badge-on'
    badge.innerHTML = '<span class="dot dot-on"></span> 운영중'
  } else {
    st.textContent = '광고 OFF'
    st.style.color = 'var(--red)'
    badge.className = 'badge badge-off'
    badge.innerHTML = '<span class="dot dot-off"></span> 중단'
  }
  document.getElementById('k-budget-label').textContent = '일예산 ' + fmt(b.daily) + '원'

  // 키워드 수
  document.getElementById('k-kw').textContent = kws.length + '개'
  document.getElementById('k-region-sub').textContent = (D.regions||[]).length + '개 지역 노출'

  // 비용
  const mu = b.monthUsed || 0
  const t30 = b.total30Used || 0
  document.getElementById('k-month').textContent = mu > 0 ? fmt(mu) + '원' : '—'
  document.getElementById('k-30d').textContent   = '30일 ' + (t30 > 0 ? fmt(t30) + '원' : '데이터 없음')

  // 클릭 CPC
  const totalClk  = kws.reduce((s,k) => s + k.clk, 0)
  const totalCost = kws.reduce((s,k) => s + k.cost, 0)
  const avgCpc    = totalClk > 0 ? Math.round(totalCost / totalClk) : 0
  document.getElementById('k-clk').textContent = totalClk > 0 ? totalClk.toLocaleString() + '회' : '—'
  document.getElementById('k-cpc').textContent = avgCpc > 0 ? '평균 CPC ' + fmt(avgCpc) + '원' : '평균 CPC —'
}

function renderBudget() {
  const b = D.budget || {}
  const daily  = b.daily  || 0
  const used   = b.todayUsed || 0
  const remain = b.todayRemain || 0
  const pct    = daily > 0 ? Math.min(100, Math.round(used / daily * 100)) : 0

  document.getElementById('b-daily').textContent   = fmt(daily) + '원'
  document.getElementById('b-daily2').textContent  = fmt(daily) + '원'
  document.getElementById('b-used').textContent    = fmt(used) + '원'
  document.getElementById('b-remain').textContent  = fmt(remain) + '원'
  document.getElementById('b-month-label').textContent = (b.monthLabel || '') + ' 누적'
  document.getElementById('b-month').textContent   = fmt(b.monthUsed || 0) + '원'
  document.getElementById('b-pct').textContent     = pct + '%'

  const bar = document.getElementById('budget-bar')
  bar.style.width = pct + '%'
  bar.className = 'budget-bar' + (pct >= 90 ? ' danger' : pct >= 70 ? ' warn' : '')
}

function renderTable() {
  const kws = D.keywords || []
  const hasAny = kws.some(k => k.imp > 0 || k.cost > 0)
  document.getElementById('no-data-box').style.display = hasAny ? 'none' : 'block'
  document.getElementById('kw-total-badge').textContent = kws.length + '개 키워드'

  applySort()
}

function applySort() {
  const kws  = [...(D.keywords || [])]
  const mode = document.getElementById('sort-sel').value

  kws.sort((a,b) => {
    if (mode === 'cost') return (b.cost || 0) - (a.cost || 0)
    if (mode === 'imp')  return (b.imp  || 0) - (a.imp  || 0)
    if (mode === 'ctr')  return (b.ctr  || 0) - (a.ctr  || 0)
    return b.bidAmt - a.bidAmt  // 기본: 입찰가
  })

  const tbody = document.getElementById('kw-body')
  if (!kws.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--gray-300)">키워드 없음</td></tr>'
    return
  }

  tbody.innerHTML = kws.map((k, i) => {
    const hasData = k.imp > 0 || k.cost > 0

    const statusBadge = k.status === 'ELIGIBLE'
      ? '<span class="badge badge-on" style="font-size:10px"><span class="dot dot-on"></span>운영</span>'
      : k.status === 'UNDER_REVIEW'
        ? '<span class="badge badge-wait" style="font-size:10px">심사중</span>'
        : '<span class="badge badge-off" style="font-size:10px">정지</span>'

    const imp  = hasData ? '<strong>' + k.imp.toLocaleString() + '</strong>'  : '<span class="no-data">—</span>'
    const clk  = hasData ? k.clk.toLocaleString()                             : '<span class="no-data">—</span>'
    const ctr  = hasData ? (k.ctr > 0
      ? '<strong style="color:var(--green)">' + k.ctr + '%</strong>'
      : '<span style="color:var(--gray-400)">0%</span>')                      : '<span class="no-data">—</span>'
    const cost = hasData && k.cost > 0
      ? '<strong class="cost-val">' + fmt(k.cost) + '원</strong>'
      : '<span class="no-data">—</span>'
    const cpc  = hasData && k.acpc > 0 ? fmt(k.acpc) + '원'                  : '<span class="no-data">—</span>'

    return '<tr data-id="' + k.id + '" data-ag="' + k.agId + '" data-bid="' + k.bidAmt + '" data-kw="' + k.keyword.replace(/"/g,'&quot;') + '">' +
      '<td style="color:var(--gray-400);font-size:11px">' + (i+1) + '</td>' +
      '<td class="kw-name-cell"><span class="kw-name">' + k.keyword + '</span>' +
        '<button class="btn-red-sm" style="margin-left:auto" onclick="quickEdit(this.closest(\'tr\'))">수정</button>' +
      '</td>' +
      '<td class="r" data-label="입찰가"><span class="bid-val">' + k.bidAmt.toLocaleString() + '원</span></td>' +
      '<td class="r" data-label="상태">' + statusBadge + '</td>' +
      '<td class="r" data-label="노출">' + imp  + '</td>' +
      '<td class="r" data-label="클릭">' + clk  + '</td>' +
      '<td class="r" data-label="CTR">'  + ctr  + '</td>' +
      '<td class="r" data-label="비용">'  + cost + '</td>' +
      '<td class="r" data-label="CPC">'   + cpc  + '</td>' +
      '<td class="r desktop-only"><button class="btn-red-sm" onclick="quickEdit(this.closest(\'tr\'))">수정</button></td>' +
    '</tr>'
  }).join('')
}

function renderBidSelect() {
  const kws = [...(D.keywords || [])].sort((a,b) => a.keyword.localeCompare(b.keyword))
  const opts = '<option value="">키워드 선택...</option>' +
    kws.map(k =>
      '<option value="' + k.id + '" data-ag="' + k.agId + '" data-bid="' + k.bidAmt + '">'
      + k.keyword + ' — ' + k.bidAmt.toLocaleString() + '원</option>'
    ).join('')

  // 데스크탑 셀렉트
  const sel = document.getElementById('bid-sel')
  sel.innerHTML = opts
  sel.onchange = () => {
    const opt = sel.options[sel.selectedIndex]
    const info = document.getElementById('cur-bid-info')
    if (opt.value) {
      document.getElementById('cur-bid-val').textContent = Number(opt.dataset.bid).toLocaleString()
      document.getElementById('bid-val').value = opt.dataset.bid
      info.style.display = 'block'
    } else { info.style.display = 'none' }
  }

  // 모바일 하단바 셀렉트 동기화
  const msel = document.getElementById('mbid-sel')
  if (msel) {
    msel.innerHTML = opts
    msel.onchange = () => {
      const opt = msel.options[msel.selectedIndex]
      const mval = document.getElementById('mbid-val')
      if (opt.value) mval.value = opt.dataset.bid
      else mval.value = ''
    }
  }
}

function renderRegions() {
  const ne = document.getElementById('chips-ne')
  const sw = document.getElementById('chips-sw')
  ne.innerHTML = (D.regions||[]).filter(r => ['남양주','구리','강동','하남','중랑','동대문','노원','강북','성북'].includes(r))
    .map(r => '<span class="chip chip-ne">' + r + '</span>').join('')
  sw.innerHTML = (D.regions||[]).filter(r => ['금천','관악','구로','영등포','광명','안양'].includes(r))
    .map(r => '<span class="chip chip-sw">' + r + '</span>').join('')
}

// ────────────────────────── 입찰가 수정 ──────────────────────────
function quickEdit(tr) {
  const id = tr.dataset.id
  const isMobile = window.innerWidth <= 480

  if (isMobile) {
    // 모바일: 하단 바 셀렉트에서 해당 키워드 선택 + 입찰가 채우기
    const msel = document.getElementById('mbid-sel')
    const mval = document.getElementById('mbid-val')
    for (let i = 0; i < msel.options.length; i++) {
      if (msel.options[i].value === id) {
        msel.selectedIndex = i
        mval.value = msel.options[i].dataset.bid
        mval.focus()
        break
      }
    }
  } else {
    // 데스크탑: 기존 방식
    const sel = document.getElementById('bid-sel')
    for (let i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === id) {
        sel.selectedIndex = i
        sel.dispatchEvent(new Event('change'))
        document.querySelector('.card-body select')?.closest('.card')?.scrollIntoView({ behavior:'smooth', block:'start' })
        break
      }
    }
  }
}

// 모바일 하단바 입찰가 적용
async function applyMobileBid() {
  const msel = document.getElementById('mbid-sel')
  const mval = document.getElementById('mbid-val')
  const opt  = msel.options[msel.selectedIndex]
  if (!opt.value) { toast('키워드를 선택하세요', 'err'); return }
  const val = parseInt(mval.value)
  if (!val || val < 70) { toast('최소 70원 이상 입력하세요', 'err'); return }
  const rounded = Math.round(val / 10) * 10
  const kwName  = opt.text.split(' —')[0]
  const oldBid  = parseInt(opt.dataset.bid || '0')

  toast('입찰가 적용 중...', 'info')
  try {
    const r = await fetch('/api/bid', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ nccKeywordId: opt.value, nccAdgroupId: opt.dataset.ag, bidAmt: rounded, keyword: kwName, oldBid })
    })
    const d = await r.json()
    if (!d.ok) throw new Error(d.error)
    // D.keywords 업데이트
    const kw = D.keywords.find(k => k.id === opt.value)
    if (kw) kw.bidAmt = rounded
    renderTable()
    renderBidSelect()
    saveLocalHistory({ keyword: kwName, oldBid, newBid: rounded, reason: '수동 변경', changedAt: new Date().toISOString() })
    loadHistory()
    mval.value = ''
    toast('✅ ' + kwName + ' → ' + rounded.toLocaleString() + '원', 'ok')
  } catch(e) {
    toast('❌ 실패: ' + e.message, 'err')
  }
}

async function applyBid() {
  const sel = document.getElementById('bid-sel')
  const opt = sel.options[sel.selectedIndex]
  if (!opt.value) { toast('키워드를 선택하세요', 'err'); return }

  const val = parseInt(document.getElementById('bid-val').value)
  if (!val || val < 70) { toast('최소 70원 이상 입력하세요', 'err'); return }
  const rounded = Math.round(val / 10) * 10
  const kwName  = opt.text.split(' —')[0]
  const oldBid  = parseInt(opt.dataset.bid || '0')

  toast('입찰가 적용 중...', 'info')
  try {
    const r = await fetch('/api/bid', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        nccKeywordId: opt.value,
        nccAdgroupId: opt.dataset.ag,
        bidAmt: rounded,
        keyword: kwName,
        oldBid: oldBid
      })
    })
    const d = await r.json()
    if (!d.ok) throw new Error(d.error)

    // 로컬 데이터 즉시 반영
    const kw = D.keywords.find(k => k.id === opt.value)
    if (kw) {
      kw.bidAmt = rounded
      opt.dataset.bid = rounded
      opt.text = kw.keyword + ' — ' + rounded.toLocaleString() + '원'
    }
    document.getElementById('cur-bid-val').textContent = rounded.toLocaleString()

    // localStorage에 이력 저장 (서버 재시작해도 유지)
    saveLocalHistory({ keyword: kwName, oldBid, newBid: rounded, reason: '수동 변경', changedAt: new Date().toISOString() })

    renderTable()
    loadHistory()
    toast('✅ ' + kwName + ' → ' + rounded.toLocaleString() + '원 적용', 'ok')
  } catch(e) {
    toast('❌ 실패: ' + e.message, 'err')
  }
}

// ────────────── 이력 (서버 자동조정 + localStorage 수동변경 통합) ──────────────

// localStorage 저장: KST 날짜별, 최대 3일 보관
function saveLocalHistory(entry) {
  try {
    const today = new Date(Date.now() + 9*3600*1000).toISOString().slice(0,10)
    const key = 'bid_hist_' + today
    const arr = JSON.parse(localStorage.getItem(key) || '[]')
    arr.push(entry)
    localStorage.setItem(key, JSON.stringify(arr.slice(-100)))
    for (let i = 4; i <= 30; i++) {
      const old = new Date(Date.now() + 9*3600*1000 - i*86400000).toISOString().slice(0,10)
      localStorage.removeItem('bid_hist_' + old)
    }
  } catch(e) {}
}

function getLocalHistory() {
  try {
    return [0,1,2].flatMap(i => {
      const d = new Date(Date.now() + 9*3600*1000 - i*86400000).toISOString().slice(0,10)
      return JSON.parse(localStorage.getItem('bid_hist_' + d) || '[]')
    })
  } catch(e) { return [] }
}

async function loadHistory() {
  try {
    // 서버 이력 (자동 스케줄러 변경분)
    const r = await fetch('/api/history')
    const d = await r.json()
    const serverHist = (d.ok && d.history) ? d.history : []

    // localStorage 이력 (수동 변경분, Vercel 재시작 후에도 유지)
    const localHist = getLocalHistory()

    // 통합 + 중복 제거 (keyword+changedAt 기준) + 최신순 정렬
    const seen = new Set()
    const merged = [...serverHist, ...localHist]
      .filter(h => { const k = h.keyword + h.changedAt; if (seen.has(k)) return false; seen.add(k); return true })
      .sort((a,b) => a.changedAt > b.changedAt ? -1 : 1)

    const list = document.getElementById('hist-list')
    if (!merged.length) {
      list.innerHTML = '<div style="text-align:center;padding:16px 0;color:var(--gray-300);font-size:12px"><i class="fas fa-inbox" style="margin-right:4px"></i>변경 이력 없음</div>'
      return
    }

    list.innerHTML = merged.map(h => {
      const isUp   = h.newBid > h.oldBid
      const arrow  = isUp ? '<span class="up-arrow">▲</span>' : '<span class="down-arrow">▼</span>'
      const diff   = Math.abs(h.newBid - h.oldBid)
      const dtKst  = h.changedAt ? new Date(new Date(h.changedAt).getTime() + 9*3600*1000) : null
      const timeStr = dtKst ? dtKst.toISOString().slice(11,16) : ''
      const dateStr = dtKst ? dtKst.toISOString().slice(5,10).replace('-','.') : ''
      const reason  = (h.reason||'').slice(0,26)
      const srcBadge = (h.reason === '수동 변경')
        ? '<span style="font-size:9px;background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;border-radius:4px;padding:1px 5px;margin-left:4px">수동</span>'
        : '<span style="font-size:9px;background:#f0fdf4;color:#059669;border:1px solid #a7f3d0;border-radius:4px;padding:1px 5px;margin-left:4px">자동</span>'
      return '<div class="hist-item">' +
        '<div style="flex:1;min-width:0">' +
          '<div class="hist-kw">' + arrow + ' ' + h.keyword + srcBadge + '</div>' +
          '<div class="hist-bid">' + Number(h.oldBid).toLocaleString() + '원 → ' +
            '<strong style="color:' + (isUp ? 'var(--green)' : 'var(--red)') + '">' + Number(h.newBid).toLocaleString() + '원</strong>' +
            ' <span style="font-size:10px;color:var(--gray-400)">(' + (isUp?'+':'-') + diff.toLocaleString() + '원)</span>' +
          '</div>' +
          '<div style="font-size:10px;color:var(--gray-400);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + reason + '</div>' +
        '</div>' +
        '<div class="hist-time" style="white-space:nowrap;text-align:right;font-size:11px">' + dateStr + '<br><strong>' + timeStr + '</strong></div>' +
      '</div>'
    }).join('')
  } catch(e) {}
}

// ────────────────────────── 유틸 ──────────────────────────
function fmt(n) { return Number(n||0).toLocaleString() }

function toast(msg, t) {
  const el = document.getElementById('toast')
  if (t === 'ok')   { el.style.background='#ecfdf5'; el.style.color='#065f46'; el.style.border='1px solid #a7f3d0' }
  if (t === 'err')  { el.style.background='#fef2f2'; el.style.color='#991b1b'; el.style.border='1px solid #fecaca' }
  if (t === 'info') { el.style.background='#eff6ff'; el.style.color='#1e40af'; el.style.border='1px solid #bfdbfe' }
  el.textContent = msg
  el.style.opacity = '1'
  clearTimeout(el._t)
  el._t = setTimeout(() => el.style.opacity = '0', 3000)
}

init()
</script>
</body>
</html>`
