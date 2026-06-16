import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono()
app.use('*', cors())

// ── 인증 ──────────────────────────────────────────────────────────────────────
const AL  = '0100000000e8a9e5c719ef2ea8318c370686c95f2e7a575fd22e8075980031db54654aa701'
const SK  = 'AQAAAADoqeXHGe8uqDGMNwaGyV8ub0ko3GK/zB5aWTFEsaWJMw=='
const CID = '4412351'
const API = 'https://api.naver.com'

// ── 캐시 — 크레딧 최대 절약 ──────────────────────────────────────────────────
const cache: Record<string, { data: unknown; ts: number }> = {}
const TTL_1H  = 60 * 60 * 1000
const TTL_12H = 12 * 60 * 60 * 1000

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

async function nStats(ids: string[], since: string, until: string, ckey: string, ttl = TTL_12H) {
  if (!ids.length) return []
  if (cache[ckey] && Date.now() - cache[ckey].ts < ttl) return cache[ckey].data
  const uri = '/stats'
  const params = new URLSearchParams({
    ids: ids.join(','),
    fields: '["impCnt","clkCnt","salesAmt","ctr","cpc"]',
    timeRange: JSON.stringify({ since, until }),
    timeUnit: 'DAY',
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

app.get('/api/data', async (c) => {
  try {
    const now   = new Date()
    const today = now.toISOString().slice(0,10)
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0,10)
    const monthStart = today.slice(0,7) + '-01'

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

    const [statsRaw30, statsRawMonth] = await Promise.all([
      nStats(ids, since30,    today, '__stats30__',    TTL_12H) as Promise<any[]>,
      nStats(ids, monthStart, today, '__statsMonth__', TTL_12H) as Promise<any[]>,
    ])

    function sumStats(rows: any[]) {
      const m: Record<string, { imp:number; clk:number; cost:number }> = {}
      for (const row of rows) {
        const id = row.id
        const s = row.statData || row.stat || {}
        if (!m[id]) m[id] = { imp:0, clk:0, cost:0 }
        m[id].imp  += Number(s.impCnt  || 0)
        m[id].clk  += Number(s.clkCnt  || 0)
        m[id].cost += Number(s.salesAmt || 0)
      }
      return m
    }
    const map30    = sumStats(statsRaw30)
    const mapMonth = sumStats(statsRawMonth)

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

    return c.json({
      ok: true, isOn,
      camp: mainCamp ? {
        name:            mainCamp.name,
        status:          mainCamp.status,
        dailyBudget,
        totalChargeCost: mainCamp.totalChargeCost || 0,
      } : null,
      budget: {
        daily:        dailyBudget,
        todayUsed,
        todayRemain,
        monthUsed:    totalUsedMonth,
        total30Used:  totalUsed30,
        monthLabel:   today.slice(0,7),
      },
      keywords,
      regions: REGIONS,
      cachedAt: new Date().toISOString(),
    })
  } catch(e: any) { return c.json({ ok:false, error: e.message }, 500) }
})

app.post('/api/bid', async (c) => {
  try {
    const { nccKeywordId, nccAdgroupId, bidAmt } = await c.req.json()
    const r = await nPut(
      `/ncc/keywords/${nccKeywordId}?fields=nccAdgroupId,useGroupBidAmt,bidAmt`,
      { nccAdgroupId, useGroupBidAmt: false, bidAmt }
    )
    return c.json({ ok:true, result: r })
  } catch(e: any) { return c.json({ ok:false, error: e.message }, 500) }
})

app.delete('/api/cache', (c) => {
  Object.keys(cache).forEach(k => delete cache[k])
  return c.json({ ok:true })
})

app.get('/api/history', async (c) => {
  try {
    return c.json({ ok: true, history: bidChangeHistory, updatedAt: new Date().toISOString() })
  } catch(e: any) { return c.json({ ok:false, error: e.message }, 500) }
})

app.post('/api/history-write', async (c) => {
  try {
    const body = await c.req.json() as {
      keyword: string; oldBid: number; newBid: number; reason: string; changedAt: string
    }
    const entry: BidHistoryEntry = {
      keyword:   body.keyword,
      oldBid:    body.oldBid,
      newBid:    body.newBid,
      reason:    body.reason,
      changedAt: body.changedAt || new Date().toISOString(),
    }
    const today = new Date().toISOString().slice(0, 10)
    bidChangeHistory = [
      ...bidChangeHistory.filter(h => h.changedAt.slice(0, 10) === today),
      entry,
    ].slice(-50)
    return c.json({ ok: true })
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

/* 반응형 */
@media(max-width:900px){
  .kpi-grid{grid-template-columns:repeat(2,1fr)}
  .main-grid{grid-template-columns:1fr!important}
}
@media(max-width:600px){
  .kpi-grid{grid-template-columns:1fr 1fr}
  .wrap{padding:12px}
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

  <!-- 예산 카드 -->
  <div class="card" style="margin-bottom:14px">
    <div class="card-body" style="padding:14px 18px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
        <span style="font-size:13px;font-weight:700;color:var(--gray-800)">
          <i class="fas fa-wallet" style="color:var(--yellow);margin-right:6px"></i>예산 현황
        </span>
        <div style="display:flex;gap:24px;flex-wrap:wrap">
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
            광고 ON 상태입니다. 오늘 집행 데이터는 내일 아침 7시 이후 표시됩니다.<br>
            stats API는 전일 기준 · 12시간 캐시로 운영됩니다.
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
    <div style="display:flex;flex-direction:column;gap:12px">

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

<script>
let D = null

// ────────────────────────── 초기 로드 ──────────────────────────
async function init() {
  try {
    const r = await fetch('/api/data')
    D = await r.json()
    if (!D.ok) throw new Error(D.error)
    render()
    loadHistory()
  } catch(e) {
    document.getElementById('loading').innerHTML =
      '<div style="color:#ef4444;font-size:13px"><i class="fas fa-exclamation-circle"></i> ' + e.message + '</div>'
    return
  }
  document.getElementById('loading').style.display = 'none'
}

async function hardRefresh() {
  const ic = document.getElementById('ri')
  ic.classList.add('fa-spin')
  await fetch('/api/cache', { method:'DELETE' })
  const r = await fetch('/api/data')
  D = await r.json()
  render()
  loadHistory()
  ic.classList.remove('fa-spin')
  toast('데이터를 새로 불러왔습니다.', 'ok')
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
      '<td><span class="kw-name">' + k.keyword + '</span></td>' +
      '<td class="r"><span class="bid-val">' + k.bidAmt.toLocaleString() + '원</span></td>' +
      '<td class="r">' + statusBadge + '</td>' +
      '<td class="r">' + imp  + '</td>' +
      '<td class="r">' + clk  + '</td>' +
      '<td class="r">' + ctr  + '</td>' +
      '<td class="r">' + cost + '</td>' +
      '<td class="r">' + cpc  + '</td>' +
      '<td class="r"><button class="btn-red-sm" onclick="quickEdit(this.parentElement.parentElement)">수정</button></td>' +
    '</tr>'
  }).join('')
}

function renderBidSelect() {
  const sel = document.getElementById('bid-sel')
  const kws = [...(D.keywords || [])].sort((a,b) => a.keyword.localeCompare(b.keyword))
  sel.innerHTML = '<option value="">키워드를 선택하세요...</option>' +
    kws.map(k =>
      '<option value="' + k.id + '" data-ag="' + k.agId + '" data-bid="' + k.bidAmt + '">'
      + k.keyword + ' — ' + k.bidAmt.toLocaleString() + '원</option>'
    ).join('')
  sel.onchange = () => {
    const opt = sel.options[sel.selectedIndex]
    const info = document.getElementById('cur-bid-info')
    if (opt.value) {
      document.getElementById('cur-bid-val').textContent = Number(opt.dataset.bid).toLocaleString()
      document.getElementById('bid-val').value = opt.dataset.bid
      info.style.display = 'block'
    } else {
      info.style.display = 'none'
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

async function applyBid() {
  const sel = document.getElementById('bid-sel')
  const opt = sel.options[sel.selectedIndex]
  if (!opt.value) { toast('키워드를 선택하세요', 'err'); return }

  const val = parseInt(document.getElementById('bid-val').value)
  if (!val || val < 70) { toast('최소 70원 이상 입력하세요', 'err'); return }
  const rounded = Math.round(val / 10) * 10

  toast('입찰가 적용 중...', 'info')
  try {
    const r = await fetch('/api/bid', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ nccKeywordId: opt.value, nccAdgroupId: opt.dataset.ag, bidAmt: rounded })
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
    renderTable()
    toast('✅ ' + opt.text.split(' —')[0] + ' → ' + rounded.toLocaleString() + '원 적용', 'ok')
  } catch(e) {
    toast('❌ 실패: ' + e.message, 'err')
  }
}

// ────────────────────────── 이력 ──────────────────────────
async function loadHistory() {
  try {
    const r = await fetch('/api/history')
    const d = await r.json()
    const list = document.getElementById('hist-list')
    if (!d.history || !d.history.length) {
      list.innerHTML = '<div style="text-align:center;padding:16px 0;color:var(--gray-300);font-size:12px"><i class="fas fa-inbox" style="margin-right:4px"></i>오늘 변경 이력 없음</div>'
      return
    }
    const sorted = [...d.history].reverse()
    list.innerHTML = sorted.map(h => {
      const arrow = h.newBid > h.oldBid
        ? '<span class="up-arrow">▲</span>'
        : '<span class="down-arrow">▼</span>'
      const diff = Math.abs(h.newBid - h.oldBid)
      const time = h.changedAt ? h.changedAt.slice(11,16) : ''
      const reasonShort = (h.reason||'').replace(/→입찰가/g,'').replace(/\\(.*?\\)/g,'').slice(0,20)
      return '<div class="hist-item">' +
        '<div>' +
          '<div class="hist-kw">' + arrow + ' ' + h.keyword + '</div>' +
          '<div class="hist-bid">' + h.oldBid.toLocaleString() + '원 → <strong style="color:var(--green)">' + h.newBid.toLocaleString() + '원</strong>' +
          ' <span style="font-size:10px;color:var(--gray-400)">(' + (h.newBid > h.oldBid ? '+' : '-') + diff.toLocaleString() + ')</span></div>' +
          '<div style="font-size:10px;color:var(--gray-400);margin-top:2px">' + reasonShort + '</div>' +
        '</div>' +
        '<div class="hist-time">' + time + '</div>' +
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
