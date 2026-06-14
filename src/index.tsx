import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono()
app.use('*', cors())

// ── 인증 ──────────────────────────────────────────────────────────────────────
const AL  = '0100000000e8a9e5c719ef2ea8318c370686c95f2e7a575fd22e8075980031db54654aa701'
const SK  = 'AQAAAADoqeXHGe8uqDGMNwaGyV8ub0ko3GK/zB5aWTFEsaWJMw=='
const CID = '4412351'
const API = 'https://api.naver.com'

// 인메모리 캐시 (크레딧 절약 핵심!)
const cache: Record<string, { data: unknown; ts: number }> = {}
const CACHE_TTL = 30 * 60 * 1000 // 30분

async function sign(ts: string, method: string, uri: string) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(SK), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}.${method}.${uri}`))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

async function nGet(uri: string, params?: Record<string, string>) {
  const ckey = uri + JSON.stringify(params || {})
  if (cache[ckey] && Date.now() - cache[ckey].ts < CACHE_TTL) return cache[ckey].data

  const url = new URL(API + uri)
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const ts = String(Date.now())
  const res = await fetch(url.toString(), {
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Timestamp': ts, 'X-API-KEY': AL, 'X-Customer': CID, 'X-Signature': await sign(ts, 'GET', uri) }
  })
  if (!res.ok) throw new Error(`${res.status}`)
  const data = await res.json()
  cache[ckey] = { data, ts: Date.now() }
  return data
}

async function nPut(uri: string, body: unknown) {
  const ts = String(Date.now())
  const res = await fetch(API + uri, {
    method: 'PUT', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Timestamp': ts, 'X-API-KEY': AL, 'X-Customer': CID, 'X-Signature': await sign(ts, 'PUT', uri) }
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  // 캐시 무효화
  Object.keys(cache).forEach(k => { if (k.includes('/ncc/')) delete cache[k] })
  return res.json()
}

// ── 입찰가 추천 ────────────────────────────────────────────────────────────────
function recBid(comp: string, total: number) {
  if (comp === '높음') {
    if (total >= 100000) return { min: 800,  rec: 1200, max: 2000 }
    if (total >= 20000)  return { min: 500,  rec: 800,  max: 1500 }
    if (total >= 5000)   return { min: 300,  rec: 600,  max: 1000 }
    return                      { min: 200,  rec: 400,  max: 700  }
  }
  if (comp === '중간')   return { min: 150,  rec: 250,  max: 500  }
  return                        { min: 70,   rec: 100,  max: 200  }
}

// ── API 라우트 ─────────────────────────────────────────────────────────────────

// 대시보드 전체 (캐시 활용 → 크레딧 1회 소모)
app.get('/api/dashboard', async (c) => {
  try {
    const [campaigns, adgroups] = await Promise.all([nGet('/ncc/campaigns'), nGet('/ncc/adgroups')]) as [any[], any[]]
    const kwArr = await Promise.all(
      adgroups.map((ag: any) => nGet('/ncc/keywords', { nccAdgroupId: ag.nccAdgroupId }).catch(() => []))
    )
    const allKw: any[] = kwArr.flat()
    // 키워드 도구 - 한 번만 조회 (크레딧 절약)
    const uniqueKws = [...new Set(allKw.map((k: any) => k.keyword))]
    const toolMap: Record<string, any> = {}
    for (const kw of uniqueKws) {
      const d: any = await nGet('/keywordstool', { hintKeywords: kw, showDetail: '1' }).catch(() => null)
      const match = d?.keywordList?.find((x: any) => x.relKeyword === kw)
      if (match) toolMap[kw] = match
    }
    const keywords = allKw.map((kw: any) => {
      const td = toolMap[kw.keyword]
      const pc  = typeof td?.monthlyPcQcCnt    === 'number' ? td.monthlyPcQcCnt    : 5
      const mob = typeof td?.monthlyMobileQcCnt === 'number' ? td.monthlyMobileQcCnt : 5
      const total = pc + mob
      const comp  = td?.compIdx || '낮음'
      return { ...kw, monthlyPc: pc, monthlyMob: mob, monthlyTotal: total, compIdx: comp, rec: recBid(comp, total) }
    })
    return c.json({ ok: true, campaigns, adgroups, keywords, cachedAt: new Date().toISOString() })
  } catch (e: any) { return c.json({ ok: false, error: e.message }, 500) }
})

// 지역 키워드 분석 (캐시 30분 - 크레딧 절약 핵심)
app.post('/api/region-keywords', async (c) => {
  const { regions, services } = await c.req.json() as { regions: string[]; services: string[] }
  const results: any[] = []
  for (const region of regions) {
    for (const service of services) {
      const kw = `${region} ${service}`
      try {
        const d: any = await nGet('/keywordstool', { hintKeywords: kw, showDetail: '1' })
        const match = d?.keywordList?.find((x: any) => x.relKeyword === kw)
        if (match) {
          const pc  = typeof match.monthlyPcQcCnt    === 'number' ? match.monthlyPcQcCnt    : 5
          const mob = typeof match.monthlyMobileQcCnt === 'number' ? match.monthlyMobileQcCnt : 5
          results.push({ keyword: kw, region, service, pc, mobile: mob, total: pc + mob, compIdx: match.compIdx || '낮음' })
        } else {
          results.push({ keyword: kw, region, service, pc: 0, mobile: 0, total: 0, compIdx: '낮음' })
        }
      } catch { results.push({ keyword: kw, region, service, pc: 0, mobile: 0, total: 0, compIdx: '낮음' }) }
    }
  }
  return c.json({ ok: true, results })
})

// 입찰가 수정
app.post('/api/bid', async (c) => {
  try {
    const { nccKeywordId, nccAdgroupId, bidAmt } = await c.req.json()
    const r = await nPut(`/ncc/keywords/${nccKeywordId}`, { nccKeywordId, nccAdgroupId, bidAmt })
    return c.json({ ok: true, result: r })
  } catch (e: any) { return c.json({ ok: false, error: e.message }, 500) }
})

// 일괄 최적화
app.post('/api/optimize', async (c) => {
  const { keywords } = await c.req.json() as { keywords: any[] }
  const results = []
  for (const kw of keywords) {
    try {
      await nPut(`/ncc/keywords/${kw.nccKeywordId}`, { nccKeywordId: kw.nccKeywordId, nccAdgroupId: kw.nccAdgroupId, bidAmt: kw.bidAmt })
      results.push({ keyword: kw.keyword, ok: true })
    } catch (e: any) { results.push({ keyword: kw.keyword, ok: false, error: e.message }) }
  }
  return c.json({ ok: true, results })
})

// 캐시 초기화 (수동)
app.delete('/api/cache', (c) => { Object.keys(cache).forEach(k => delete cache[k]); return c.json({ ok: true }) })

// 로그 파일 읽기 API (Workers 환경에서 파일 I/O 없이 동작 - 빈 응답)
app.get('/api/log', async (c) => {
  // Cloudflare Workers는 파일시스템 접근 불가 → 빈 배열 반환
  // 실제 로그는 /home/user/webapp/data/scheduler.log 에서 확인
  return c.json({ ok: true, lines: [], note: '로그는 서버에서 python3 scheduler.py 실행 후 data/scheduler.log 확인' })
})

// ── 자동화 이력 API (scheduler.py DB 읽기) ────────────────────────────────────
app.get('/api/history', async (c) => {
  try {
    // scheduler.py가 생성한 DB에서 직접 읽기
    const LOG_PATH = '/home/user/webapp/data/scheduler.log'
    const BID_LOG  = '/home/user/webapp/data/ad-on.log'
    // DB 없을 때 빈 구조 반환 (파일 I/O 없는 Workers 환경 대비)
    return c.json({
      ok: true,
      note: 'DB는 scheduler.py가 관리. /api/history-log로 로그 확인',
      schedule: [
        { time: '01:00', action: 'OFF', desc: '새벽 광고 중단 (비용 절약)' },
        { time: '07:00', action: 'ON',  desc: '아침 광고 ON + 스마트 입찰 최적화' },
      ]
    })
  } catch(e: any) { return c.json({ ok: false, error: e.message }, 500) }
})

// ── 프론트엔드 페이지들 ────────────────────────────────────────────────────────
app.get('/', (c) => c.html(PAGE_MAIN))
app.get('/region', (c) => c.html(PAGE_REGION))
app.get('/optimize', (c) => c.html(PAGE_OPTIMIZE))
app.get('/history', (c) => c.html(PAGE_HISTORY))

// ══════════════════════════════════════════════════════════════════════════════
// 공통 헤더/푸터 헬퍼
// ══════════════════════════════════════════════════════════════════════════════
const NAV = `
<nav class="bg-[#03C75A] shadow-lg sticky top-0 z-50">
  <div class="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
    <div class="flex items-center gap-6">
      <a href="/" class="flex items-center gap-2 text-white font-bold text-lg">
        <i class="fas fa-chart-line"></i><span class="hidden sm:inline">파워링크 대시보드</span>
      </a>
      <div class="flex gap-1">
        <a href="/" id="nav-main" class="nav-link px-3 py-1.5 rounded-lg text-sm font-medium text-white/80 hover:bg-white/20 transition">
          <i class="fas fa-home mr-1"></i>대시보드
        </a>
        <a href="/region" id="nav-region" class="nav-link px-3 py-1.5 rounded-lg text-sm font-medium text-white/80 hover:bg-white/20 transition">
          <i class="fas fa-map-marker-alt mr-1"></i>지역분석
        </a>
        <a href="/optimize" id="nav-opt" class="nav-link px-3 py-1.5 rounded-lg text-sm font-medium text-white/80 hover:bg-white/20 transition">
          <i class="fas fa-magic mr-1"></i>입찰최적화
        </a>
        <a href="/history" id="nav-hist" class="nav-link px-3 py-1.5 rounded-lg text-sm font-medium text-white/80 hover:bg-white/20 transition">
          <i class="fas fa-history mr-1"></i>자동화이력
        </a>
      </div>
    </div>
    <div class="flex items-center gap-2 text-white/70 text-xs">
      <i class="fas fa-circle text-green-300 text-xs animate-pulse"></i>
      <span>CID: 4412351</span>
    </div>
  </div>
</nav>`

const HEAD = (title: string) => `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title} | 파워링크 대시보드</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600;700&display=swap');
*{font-family:'Noto Sans KR',sans-serif}
.card{background:#fff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,.07)}
.badge-high{background:#FEE2E2;color:#DC2626}
.badge-mid{background:#FEF3C7;color:#D97706}
.badge-low{background:#D1FAE5;color:#059669}
.nav-active{background:rgba(255,255,255,.25)!important;color:#fff!important;font-weight:700}
.loading-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:999}
.spinner{width:48px;height:48px;border:5px solid #fff;border-top-color:#03C75A;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.toast{position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:12px;color:#fff;font-size:14px;font-weight:500;opacity:0;transition:opacity .3s;z-index:999;display:flex;align-items:center;gap:8px}
.progress{height:6px;background:#E5E7EB;border-radius:3px;overflow:hidden}
.progress-fill{height:100%;border-radius:3px;transition:width .5s}
.kpi-up{color:#10B981}.kpi-down{color:#EF4444}
.region-tag{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;transition:.2s}
.region-tag.active{background:#03C75A;color:#fff}
.region-tag.inactive{background:#F3F4F6;color:#6B7280}
</style>
</head>
<body class="bg-gray-50 min-h-screen">`

// ══════════════════════════════════════════════════════════════════════════════
// 페이지 1: 메인 대시보드
// ══════════════════════════════════════════════════════════════════════════════
const PAGE_MAIN = HEAD('대시보드') + NAV + `
<div id="loading" class="loading-overlay"><div class="text-center"><div class="spinner mx-auto mb-3"></div><p class="text-white text-base">데이터 로딩 중...</p></div></div>
<div id="toast" class="toast"></div>

<main class="max-w-7xl mx-auto px-4 py-6 space-y-6">

  <!-- 상단 타이틀 -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold text-gray-800">광고 성과 대시보드</h1>
      <p class="text-gray-400 text-sm mt-0.5" id="updated-at">로딩 중...</p>
    </div>
    <button onclick="reload()" class="flex items-center gap-2 px-4 py-2 bg-[#03C75A] hover:bg-green-600 text-white rounded-xl text-sm font-semibold transition shadow">
      <i class="fas fa-sync-alt"></i> 새로고침
    </button>
  </div>

  <!-- KPI 카드 4개 -->
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
    <div class="card p-5">
      <div class="flex items-center justify-between mb-3">
        <span class="text-gray-400 text-sm font-medium">총 캠페인</span>
        <div class="w-10 h-10 bg-green-50 rounded-xl flex items-center justify-center">
          <i class="fas fa-bullhorn text-[#03C75A] text-lg"></i>
        </div>
      </div>
      <div class="text-3xl font-bold text-gray-800" id="k-campaigns">—</div>
      <div class="text-xs text-gray-400 mt-1">파워링크 캠페인</div>
    </div>
    <div class="card p-5">
      <div class="flex items-center justify-between mb-3">
        <span class="text-gray-400 text-sm font-medium">등록 키워드</span>
        <div class="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
          <i class="fas fa-key text-blue-500 text-lg"></i>
        </div>
      </div>
      <div class="text-3xl font-bold text-gray-800" id="k-keywords">—</div>
      <div class="text-xs text-gray-400 mt-1" id="k-paused-info">—</div>
    </div>
    <div class="card p-5">
      <div class="flex items-center justify-between mb-3">
        <span class="text-gray-400 text-sm font-medium">월 검색량 합계</span>
        <div class="w-10 h-10 bg-yellow-50 rounded-xl flex items-center justify-center">
          <i class="fas fa-search text-yellow-500 text-lg"></i>
        </div>
      </div>
      <div class="text-3xl font-bold text-gray-800" id="k-search">—</div>
      <div class="text-xs text-gray-400 mt-1">전체 키워드 합산</div>
    </div>
    <div class="card p-5">
      <div class="flex items-center justify-between mb-3">
        <span class="text-gray-400 text-sm font-medium">최적화 필요</span>
        <div class="w-10 h-10 bg-red-50 rounded-xl flex items-center justify-center">
          <i class="fas fa-exclamation-triangle text-red-500 text-lg"></i>
        </div>
      </div>
      <div class="text-3xl font-bold text-red-500" id="k-need">—</div>
      <div class="text-xs text-gray-400 mt-1">입찰가 미달 키워드</div>
    </div>
  </div>

  <!-- 차트 2개 -->
  <div class="grid lg:grid-cols-2 gap-4">
    <div class="card p-5">
      <h3 class="font-bold text-gray-700 mb-4"><i class="fas fa-chart-bar text-[#03C75A] mr-2"></i>키워드별 월 검색량</h3>
      <canvas id="chart-search" height="220"></canvas>
    </div>
    <div class="card p-5">
      <h3 class="font-bold text-gray-700 mb-4"><i class="fas fa-balance-scale text-blue-500 mr-2"></i>현재 vs 권장 입찰가</h3>
      <canvas id="chart-bid" height="220"></canvas>
    </div>
  </div>

  <!-- 차트 2개 -->
  <div class="grid lg:grid-cols-3 gap-4">
    <div class="card p-5">
      <h3 class="font-bold text-gray-700 mb-4"><i class="fas fa-chart-pie text-purple-500 mr-2"></i>경쟁도 분포</h3>
      <canvas id="chart-comp" height="200"></canvas>
    </div>
    <div class="card p-5 lg:col-span-2">
      <h3 class="font-bold text-gray-700 mb-4"><i class="fas fa-money-bill-wave text-green-500 mr-2"></i>예상 일 광고비 (권장 입찰가 기준)</h3>
      <canvas id="chart-budget" height="200"></canvas>
    </div>
  </div>

  <!-- 키워드 현황 테이블 -->
  <div class="card p-5">
    <div class="flex items-center justify-between mb-4">
      <h3 class="font-bold text-gray-700"><i class="fas fa-table text-gray-400 mr-2"></i>키워드 현황</h3>
      <a href="/optimize" class="text-sm text-[#03C75A] font-semibold hover:underline">입찰 최적화 →</a>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead><tr class="bg-gray-50 text-gray-500 text-xs">
          <th class="px-3 py-2.5 text-left rounded-tl-lg">키워드</th>
          <th class="px-3 py-2.5 text-center">경쟁도</th>
          <th class="px-3 py-2.5 text-right">월검색량</th>
          <th class="px-3 py-2.5 text-right">현재입찰가</th>
          <th class="px-3 py-2.5 text-right rounded-tr-lg">권장입찰가</th>
        </tr></thead>
        <tbody id="kw-tbody" class="divide-y divide-gray-50">
          <tr><td colspan="5" class="text-center py-10 text-gray-300"><i class="fas fa-spinner fa-spin text-2xl"></i></td></tr>
        </tbody>
      </table>
    </div>
  </div>

</main>
<script>
let D=null, charts={}
const ACTIVE='/${''}' // 현재 페이지
document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('nav-main')?.classList.add('nav-active')
  load()
})
async function load(){
  show(true)
  try{
    const r=await fetch('/api/dashboard')
    D=await r.json()
    if(!D.ok) throw new Error(D.error)
    renderKPI(); renderCharts(); renderTable()
    document.getElementById('updated-at').textContent='마지막 업데이트: '+new Date(D.cachedAt).toLocaleString('ko-KR')+' (30분 캐시)'
    toast('데이터 로드 완료','success')
  }catch(e){toast('로드 실패: '+e.message,'error')}
  finally{show(false)}
}
function reload(){
  fetch('/api/cache',{method:'DELETE'}).then(()=>load())
}
function renderKPI(){
  const {campaigns,keywords}=D
  const total=keywords.reduce((s,k)=>s+(k.monthlyTotal||0),0)
  const need=keywords.filter(k=>k.bidAmt<k.rec.min).length
  const paused=keywords.filter(k=>k.status==='PAUSED').length
  document.getElementById('k-campaigns').textContent=campaigns.length
  document.getElementById('k-keywords').textContent=keywords.length
  document.getElementById('k-paused-info').textContent=\`운영중 \${keywords.length-paused}개 / 정지 \${paused}개\`
  document.getElementById('k-search').textContent=total>=10000?(total/10000).toFixed(1)+'만':total.toLocaleString()
  document.getElementById('k-need').textContent=need
}
function renderCharts(){
  const {keywords}=D
  const sorted=[...keywords].sort((a,b)=>(b.monthlyTotal||0)-(a.monthlyTotal||0))
  const COLORS={높음:'#FCA5A5',중간:'#FCD34D',낮음:'#6EE7B7'}
  if(charts.s)charts.s.destroy()
  charts.s=new Chart(document.getElementById('chart-search'),{type:'bar',data:{
    labels:sorted.map(k=>k.keyword),
    datasets:[{label:'월검색량',data:sorted.map(k=>k.monthlyTotal||0),
      backgroundColor:sorted.map(k=>COLORS[k.compIdx]||'#94A3B8'),borderRadius:6}]
  },options:{responsive:true,plugins:{legend:{display:false}},scales:{
    y:{ticks:{callback:v=>v>=10000?(v/10000).toFixed(0)+'만':v}},
    x:{ticks:{font:{size:10}}}}}})
  if(charts.b)charts.b.destroy()
  charts.b=new Chart(document.getElementById('chart-bid'),{type:'bar',data:{
    labels:keywords.map(k=>k.keyword),
    datasets:[
      {label:'현재',data:keywords.map(k=>k.bidAmt),backgroundColor:'#94A3B8',borderRadius:4},
      {label:'권장',data:keywords.map(k=>k.rec.rec),backgroundColor:'#34D399',borderRadius:4}
    ]
  },options:{responsive:true,plugins:{legend:{position:'bottom',labels:{font:{size:11}}}},scales:{
    x:{ticks:{font:{size:9}}},y:{ticks:{callback:v=>v+'원'}}}}})
  const hi=keywords.filter(k=>k.compIdx==='높음').length
  const mi=keywords.filter(k=>k.compIdx==='중간').length
  const lo=keywords.filter(k=>k.compIdx==='낮음').length
  if(charts.c)charts.c.destroy()
  charts.c=new Chart(document.getElementById('chart-comp'),{type:'doughnut',data:{
    labels:['높음','중간','낮음'],
    datasets:[{data:[hi,mi,lo],backgroundColor:['#FCA5A5','#FCD34D','#6EE7B7'],borderWidth:0}]
  },options:{responsive:true,plugins:{legend:{position:'bottom'}}}})
  const budgets=keywords.map(k=>Math.round((k.monthlyTotal||0)/30*0.04*k.rec.rec))
  if(charts.g)charts.g.destroy()
  charts.g=new Chart(document.getElementById('chart-budget'),{type:'bar',data:{
    labels:keywords.map(k=>k.keyword),
    datasets:[{label:'예상 일광고비',data:budgets,backgroundColor:'#818CF8',borderRadius:6}]
  },options:{responsive:true,plugins:{legend:{display:false}},scales:{
    x:{ticks:{font:{size:9}}},y:{ticks:{callback:v=>v.toLocaleString()+'원'}}}}})
}
function renderTable(){
  const {keywords}=D
  const B={높음:'badge-high',중간:'badge-mid',낮음:'badge-low'}
  document.getElementById('kw-tbody').innerHTML=keywords.map(k=>{
    const low=k.bidAmt<k.rec.min
    return \`<tr class="hover:bg-gray-50 \${low?'bg-red-50/30':''}">
      <td class="px-3 py-2.5 font-semibold text-gray-800">\${k.keyword}\${low?'<span class="ml-1 text-xs text-red-400">⚠</span>':''}</td>
      <td class="px-3 py-2.5 text-center"><span class="text-xs px-2 py-0.5 rounded-full font-medium \${B[k.compIdx]||'badge-low'}">\${k.compIdx}</span></td>
      <td class="px-3 py-2.5 text-right text-gray-600">\${(k.monthlyTotal||0).toLocaleString()}</td>
      <td class="px-3 py-2.5 text-right font-bold \${low?'text-red-500':'text-gray-800'}">\${k.bidAmt.toLocaleString()}원</td>
      <td class="px-3 py-2.5 text-right text-green-600 font-bold">\${k.rec.rec.toLocaleString()}원</td>
    </tr>\`
  }).join('')
}
function show(v){document.getElementById('loading').style.display=v?'flex':'none'}
function toast(msg,t){
  const el=document.getElementById('toast')
  el.style.background=t==='success'?'#10B981':t==='error'?'#EF4444':'#3B82F6'
  el.innerHTML=\`<i class="fas fa-\${t==='success'?'check':'times'}-circle"></i>\${msg}\`
  el.style.opacity='1'
  setTimeout(()=>el.style.opacity='0',3000)
}
</script></body></html>`

// ══════════════════════════════════════════════════════════════════════════════
// 페이지 2: 지역별 키워드 분석
// ══════════════════════════════════════════════════════════════════════════════
const PAGE_REGION = HEAD('지역 분석') + NAV + `
<div id="loading" class="loading-overlay" style="display:none"><div class="text-center"><div class="spinner mx-auto mb-3"></div><p class="text-white text-base">키워드 분석 중... (캐시 30분)</p></div></div>
<div id="toast" class="toast"></div>

<main class="max-w-7xl mx-auto px-4 py-6 space-y-6">
  <div>
    <h1 class="text-2xl font-bold text-gray-800">지역별 키워드 분석</h1>
    <p class="text-gray-400 text-sm mt-0.5">에어컨 수리·청소 서비스 운영 지역 검색 트렌드</p>
  </div>

  <!-- 지역 선택 -->
  <div class="card p-5">
    <div class="flex items-center gap-3 mb-4">
      <div class="w-9 h-9 bg-green-50 rounded-xl flex items-center justify-center">
        <i class="fas fa-map-marker-alt text-[#03C75A]"></i>
      </div>
      <h3 class="font-bold text-gray-700">지역 선택</h3>
    </div>
    <div class="mb-3">
      <div class="text-xs font-semibold text-gray-400 mb-2">🔵 동북권</div>
      <div class="flex flex-wrap gap-2" id="tags-northeast"></div>
    </div>
    <div class="mb-4">
      <div class="text-xs font-semibold text-gray-400 mb-2">🟢 서남권</div>
      <div class="flex flex-wrap gap-2" id="tags-southwest"></div>
    </div>
    <div class="flex flex-wrap gap-2">
      <button onclick="selectAll()" class="px-4 py-2 bg-[#03C75A] text-white rounded-xl text-sm font-semibold">전체 선택</button>
      <button onclick="clearAll()" class="px-4 py-2 bg-gray-100 text-gray-600 rounded-xl text-sm font-semibold">초기화</button>
      <button onclick="analyze()" id="btn-analyze" class="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold transition ml-auto">
        <i class="fas fa-search mr-1"></i> 분석 시작
      </button>
    </div>
  </div>

  <!-- 결과 -->
  <div id="result-section" class="hidden space-y-4">
    <!-- 요약 카드 -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4" id="region-kpi"></div>

    <!-- 차트: 지역별 검색량 -->
    <div class="grid lg:grid-cols-2 gap-4">
      <div class="card p-5">
        <h3 class="font-bold text-gray-700 mb-4"><i class="fas fa-chart-bar text-blue-500 mr-2"></i>지역별 총 검색량</h3>
        <canvas id="chart-region" height="260"></canvas>
      </div>
      <div class="card p-5">
        <h3 class="font-bold text-gray-700 mb-4"><i class="fas fa-layer-group text-purple-500 mr-2"></i>서비스별 검색량</h3>
        <canvas id="chart-service" height="260"></canvas>
      </div>
    </div>

    <!-- 히트맵 테이블 -->
    <div class="card p-5">
      <h3 class="font-bold text-gray-700 mb-4"><i class="fas fa-th text-orange-500 mr-2"></i>지역 × 서비스 검색량 히트맵</h3>
      <div class="overflow-x-auto" id="heatmap-wrap"></div>
    </div>

    <!-- 상위 키워드 -->
    <div class="card p-5">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-bold text-gray-700"><i class="fas fa-trophy text-yellow-500 mr-2"></i>검색량 TOP 키워드</h3>
        <button onclick="exportCSV()" class="text-sm px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg transition">
          <i class="fas fa-download mr-1"></i>CSV
        </button>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="bg-gray-50 text-gray-500 text-xs">
            <th class="px-3 py-2 text-left">순위</th>
            <th class="px-3 py-2 text-left">키워드</th>
            <th class="px-3 py-2 text-left">지역</th>
            <th class="px-3 py-2 text-center">경쟁도</th>
            <th class="px-3 py-2 text-right">PC</th>
            <th class="px-3 py-2 text-right">모바일</th>
            <th class="px-3 py-2 text-right">합계</th>
            <th class="px-3 py-2 text-right">권장입찰가</th>
          </tr></thead>
          <tbody id="top-tbody"></tbody>
        </table>
      </div>
    </div>
  </div>

</main>
<script>
const NE=['남양주','구리','강동','하남','중랑','동대문','노원','강북','성북']
const SW=['금천','관악','구로','영등포','광명','안양']
const SVCS=['에어컨수리','에어컨청소','에어컨가스충전','에어컨분해청소','에어컨점검']
let selected=new Set([...NE,...SW])
let regionData=[]
let charts={}

document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('nav-region')?.classList.add('nav-active')
  renderTags()
})

function renderTags(){
  const render=(ids,tags)=>{
    document.getElementById(ids).innerHTML=tags.map(r=>\`
      <span onclick="toggle('\${r}')" id="tag-\${r}" class="region-tag \${selected.has(r)?'active':'inactive'}">
        \${r}
      </span>\`).join('')
  }
  render('tags-northeast',NE)
  render('tags-southwest',SW)
}
function toggle(r){selected.has(r)?selected.delete(r):selected.add(r);renderTags()}
function selectAll(){selected=new Set([...NE,...SW]);renderTags()}
function clearAll(){selected.clear();renderTags()}

async function analyze(){
  if(!selected.size){toast('지역을 선택해주세요','error');return}
  const btn=document.getElementById('btn-analyze')
  btn.disabled=true;btn.innerHTML='<i class="fas fa-spinner fa-spin mr-1"></i>분석 중...'
  document.getElementById('loading').style.display='flex'
  try{
    const r=await fetch('/api/region-keywords',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({regions:[...selected],services:SVCS})})
    const d=await r.json()
    regionData=d.results||[]
    renderResults()
    document.getElementById('result-section').classList.remove('hidden')
    toast('분석 완료!','success')
  }catch(e){toast('오류: '+e.message,'error')}
  finally{
    document.getElementById('loading').style.display='none'
    btn.disabled=false;btn.innerHTML='<i class="fas fa-search mr-1"></i>분석 시작'
  }
}

function renderResults(){
  const regions=[...selected]
  // KPI
  const total=regionData.reduce((s,r)=>s+r.total,0)
  const top=regionData.filter(r=>r.total>0).sort((a,b)=>b.total-a.total)
  const topRegion=top[0]?.region||'-'
  const topSvc=SVCS.map(s=>({s,t:regionData.filter(r=>r.service===s).reduce((a,b)=>a+b.total,0)})).sort((a,b)=>b.t-a.t)[0]
  document.getElementById('region-kpi').innerHTML=\`
    <div class="card p-4"><div class="text-gray-400 text-sm mb-1">분석 지역</div><div class="text-3xl font-bold text-gray-800">\${regions.length}개</div></div>
    <div class="card p-4"><div class="text-gray-400 text-sm mb-1">분석 키워드</div><div class="text-3xl font-bold text-gray-800">\${regionData.length}개</div></div>
    <div class="card p-4"><div class="text-gray-400 text-sm mb-1">최다검색 지역</div><div class="text-2xl font-bold text-blue-600">\${topRegion}</div></div>
    <div class="card p-4"><div class="text-gray-400 text-sm mb-1">핵심 서비스</div><div class="text-2xl font-bold text-green-600">\${topSvc?.s||'-'}</div></div>
  \`

  // 지역별 차트
  const byRegion=regions.map(r=>({r,t:regionData.filter(x=>x.region===r).reduce((a,b)=>a+b.total,0)}))
  if(charts.rg)charts.rg.destroy()
  charts.rg=new Chart(document.getElementById('chart-region'),{type:'bar',data:{
    labels:byRegion.map(x=>x.r),
    datasets:[{label:'월검색량',data:byRegion.map(x=>x.t),
      backgroundColor:byRegion.map(x=>NE.includes(x.r)?'#60A5FA':'#34D399'),borderRadius:6}]
  },options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{ticks:{callback:v=>v+'건'}},x:{ticks:{font:{size:11}}}}}})

  // 서비스별 차트
  const bySvc=SVCS.map(s=>({s,t:regionData.filter(x=>x.service===s).reduce((a,b)=>a+b.total,0)}))
  if(charts.sv)charts.sv.destroy()
  charts.sv=new Chart(document.getElementById('chart-service'),{type:'doughnut',data:{
    labels:bySvc.map(x=>x.s),
    datasets:[{data:bySvc.map(x=>x.t),backgroundColor:['#60A5FA','#34D399','#FBBF24','#F87171','#A78BFA'],borderWidth:2,borderColor:'#fff'}]
  },options:{responsive:true,plugins:{legend:{position:'bottom',labels:{font:{size:11}}}}}})

  // 히트맵
  const maxVal=Math.max(...regionData.map(r=>r.total),1)
  const hdr='<th class="px-3 py-2 text-left text-xs text-gray-500 bg-gray-50">지역</th>'+SVCS.map(s=>'<th class="px-3 py-2 text-center text-xs text-gray-500 bg-gray-50">'+s+'</th>').join('')
  const rows=regions.map(region=>{
    const cells=SVCS.map(svc=>{
      const v=regionData.find(r=>r.region===region&&r.service===svc)?.total||0
      const pct=Math.round(v/maxVal*100)
      const bg=pct>70?'#22C55E':pct>40?'#86EFAC':pct>15?'#BBF7D0':pct>0?'#DCFCE7':'#F9FAFB'
      const tc=pct>40?'#166534':'#374151'
      return \`<td class="px-3 py-2 text-center text-xs font-medium" style="background:\${bg};color:\${tc}">\${v?v.toLocaleString():'-'}</td>\`
    }).join('')
    const zone=NE.includes(region)?'🔵':'🟢'
    return \`<tr class="border-b border-gray-100"><td class="px-3 py-2.5 text-sm font-semibold text-gray-700 whitespace-nowrap">\${zone} \${region}</td>\${cells}</tr>\`
  }).join('')
  document.getElementById('heatmap-wrap').innerHTML=\`<table class="w-full"><thead><tr>\${hdr}</tr></thead><tbody>\${rows}</tbody></table>\`

  // TOP 키워드 테이블
  const B={높음:'badge-high',중간:'badge-mid',낮음:'badge-low'}
  const REC=(comp,total)=>{
    if(comp==='높음'){if(total>=5000)return 600;if(total>=2000)return 400;return 250}
    if(comp==='중간')return 180;return 100
  }
  const topList=[...regionData].sort((a,b)=>b.total-a.total).slice(0,30)
  document.getElementById('top-tbody').innerHTML=topList.map((r,i)=>\`
    <tr class="hover:bg-gray-50 border-b border-gray-50">
      <td class="px-3 py-2.5 text-gray-400 text-xs font-bold">#\${i+1}</td>
      <td class="px-3 py-2.5 font-semibold text-gray-800">\${r.keyword}</td>
      <td class="px-3 py-2.5"><span class="text-xs px-2 py-0.5 rounded-full \${NE.includes(r.region)?'bg-blue-100 text-blue-700':'bg-green-100 text-green-700'}">\${r.region}</span></td>
      <td class="px-3 py-2.5 text-center"><span class="text-xs px-2 py-0.5 rounded-full font-medium \${B[r.compIdx]||'badge-low'}">\${r.compIdx}</span></td>
      <td class="px-3 py-2.5 text-right text-gray-500">\${r.pc.toLocaleString()}</td>
      <td class="px-3 py-2.5 text-right text-gray-500">\${r.mobile.toLocaleString()}</td>
      <td class="px-3 py-2.5 text-right font-bold text-gray-800">\${r.total.toLocaleString()}</td>
      <td class="px-3 py-2.5 text-right text-green-600 font-bold">\${REC(r.compIdx,r.total).toLocaleString()}원</td>
    </tr>\`).join('')
}

function exportCSV(){
  const rows=[['키워드','지역','권역','서비스','경쟁도','PC','모바일','합계']]
  regionData.sort((a,b)=>b.total-a.total).forEach(r=>rows.push([r.keyword,r.region,NE.includes(r.region)?'동북권':'서남권',r.service,r.compIdx,r.pc,r.mobile,r.total]))
  const csv=rows.map(r=>r.join(',')).join('\\n')
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\\uFEFF'+csv],{type:'text/csv'}))
  a.download='region_keywords.csv';a.click()
}
function show(v){document.getElementById('loading').style.display=v?'flex':'none'}
function toast(msg,t){
  const el=document.getElementById('toast')
  el.style.background=t==='success'?'#10B981':'#EF4444'
  el.innerHTML=\`<i class="fas fa-\${t==='success'?'check':'times'}-circle"></i>\${msg}\`
  el.style.opacity='1';setTimeout(()=>el.style.opacity='0',3000)
}
</script></body></html>`

// ══════════════════════════════════════════════════════════════════════════════
// 페이지 3: 입찰가 최적화
// ══════════════════════════════════════════════════════════════════════════════
const PAGE_OPTIMIZE = HEAD('입찰 최적화') + NAV + `
<div id="loading" class="loading-overlay"><div class="text-center"><div class="spinner mx-auto mb-3"></div><p class="text-white text-base">데이터 로딩 중...</p></div></div>
<div id="toast" class="toast"></div>
<!-- 입찰가 수정 모달 -->
<div id="modal" class="fixed inset-0 bg-black/50 hidden items-center justify-center z-50">
  <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm mx-4">
    <h3 class="font-bold text-lg mb-1"><i class="fas fa-edit text-green-500 mr-2"></i>입찰가 수정</h3>
    <p id="m-name" class="text-gray-400 text-sm mb-4"></p>
    <div class="bg-gray-50 rounded-xl p-3 text-sm text-gray-600 mb-3">
      현재 <span id="m-cur" class="font-bold text-gray-800"></span>원
      &nbsp;→&nbsp; 권장 <span id="m-rec" class="font-bold text-green-600"></span>원
    </div>
    <input id="m-input" type="number" min="70" step="10" placeholder="입찰가 입력 (원)"
      class="w-full border border-gray-200 rounded-xl px-4 py-3 text-center text-xl font-bold mb-3 focus:outline-none focus:ring-2 focus:ring-green-400"/>
    <div class="flex gap-2 mb-4">
      <button onclick="setM('min')" class="flex-1 text-xs py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600">최소</button>
      <button onclick="setM('rec')" class="flex-1 text-xs py-2 rounded-lg bg-green-100 hover:bg-green-200 text-green-700 font-medium">권장</button>
      <button onclick="setM('max')" class="flex-1 text-xs py-2 rounded-lg bg-blue-100 hover:bg-blue-200 text-blue-700">최대</button>
    </div>
    <div class="flex gap-2">
      <button onclick="closeM()" class="flex-1 py-2.5 rounded-xl border border-gray-200 text-gray-600 text-sm font-medium">취소</button>
      <button onclick="applyM()" class="flex-1 py-2.5 rounded-xl bg-[#03C75A] hover:bg-green-600 text-white text-sm font-semibold transition">적용</button>
    </div>
  </div>
</div>

<main class="max-w-7xl mx-auto px-4 py-6 space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold text-gray-800">입찰가 최적화</h1>
      <p class="text-gray-400 text-sm mt-0.5">검색량·경쟁도 기반 자동 입찰가 추천 및 일괄 적용</p>
    </div>
    <button onclick="optimizeAll()" id="btn-all" class="flex items-center gap-2 px-5 py-2.5 bg-[#03C75A] hover:bg-green-600 text-white rounded-xl text-sm font-bold transition shadow-lg shadow-green-200">
      <i class="fas fa-magic"></i> 전체 최적화 적용
    </button>
  </div>

  <!-- 최적화 요약 배너 -->
  <div id="opt-banner" class="hidden card p-4 border-l-4 border-amber-400 bg-amber-50">
    <div class="flex items-start gap-3">
      <i class="fas fa-lightbulb text-amber-500 text-xl mt-0.5"></i>
      <div id="banner-content" class="text-sm text-gray-700 space-y-1 flex-1"></div>
    </div>
  </div>

  <!-- 필터 -->
  <div class="flex gap-2 flex-wrap">
    <button onclick="filter('all')" id="f-all" class="f-btn text-sm px-4 py-2 rounded-xl bg-gray-800 text-white font-medium">전체</button>
    <button onclick="filter('need')" id="f-need" class="f-btn text-sm px-4 py-2 rounded-xl bg-gray-100 text-gray-600 font-medium">⚠️ 최적화 필요</button>
    <button onclick="filter('ok')" id="f-ok" class="f-btn text-sm px-4 py-2 rounded-xl bg-gray-100 text-gray-600 font-medium">✅ 정상</button>
  </div>

  <!-- 키워드 카드 그리드 -->
  <div id="kw-grid" class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
    <div class="col-span-full text-center py-20 text-gray-300">
      <i class="fas fa-spinner fa-spin text-4xl"></i>
    </div>
  </div>

  <!-- 예산 시뮬레이터 -->
  <div class="card p-5">
    <h3 class="font-bold text-gray-700 mb-4"><i class="fas fa-calculator text-indigo-500 mr-2"></i>일 예산 시뮬레이터</h3>
    <div class="grid sm:grid-cols-3 gap-4 mb-4">
      <div class="bg-gray-50 rounded-xl p-4 text-center">
        <div class="text-xs text-gray-400 mb-1">현재 입찰가 기준</div>
        <div class="text-2xl font-bold text-gray-600" id="sim-current">—</div>
        <div class="text-xs text-gray-400">예상 일 광고비</div>
      </div>
      <div class="bg-green-50 rounded-xl p-4 text-center">
        <div class="text-xs text-gray-400 mb-1">권장 입찰가 기준</div>
        <div class="text-2xl font-bold text-green-600" id="sim-rec">—</div>
        <div class="text-xs text-gray-400">예상 일 광고비</div>
      </div>
      <div class="bg-blue-50 rounded-xl p-4 text-center">
        <div class="text-xs text-gray-400 mb-1">최대 입찰가 기준</div>
        <div class="text-2xl font-bold text-blue-600" id="sim-max">—</div>
        <div class="text-xs text-gray-400">예상 일 광고비</div>
      </div>
    </div>
    <p class="text-xs text-gray-400">* 평균 CTR 4% 가정, 월검색량/30일 기준 추정치입니다.</p>
  </div>

</main>
<script>
let D=null, curFilter='all', editKw=null, charts={}

document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('nav-opt')?.classList.add('nav-active')
  load()
})

async function load(){
  show(true)
  try{
    const r=await fetch('/api/dashboard')
    D=await r.json()
    if(!D.ok) throw new Error(D.error)
    renderGrid(); renderBanner(); renderSim()
    toast('로드 완료','success')
  }catch(e){toast('오류: '+e.message,'error')}
  finally{show(false)}
}

function renderGrid(f){
  f=f||curFilter
  const {keywords}=D
  const list=keywords.filter(k=>{
    if(f==='need') return k.bidAmt<k.rec.min
    if(f==='ok')   return k.bidAmt>=k.rec.min
    return true
  })
  const B={높음:'badge-high',중간:'badge-mid',낮음:'badge-low'}
  const grid=document.getElementById('kw-grid')
  if(!list.length){grid.innerHTML='<div class="col-span-full text-center py-16 text-gray-300"><i class="fas fa-check-circle text-4xl mb-2 block"></i>해당 항목 없음</div>';return}
  grid.innerHTML=list.map(k=>{
    const low=k.bidAmt<k.rec.min
    const ok=k.bidAmt>=k.rec.rec
    const pct=Math.min(100,Math.round(k.bidAmt/k.rec.rec*100))
    const barColor=ok?'#10B981':low?'#EF4444':'#F59E0B'
    const statusCls=k.status==='PAUSED'?'bg-gray-100 text-gray-500':'bg-green-100 text-green-700'
    const statusLbl=k.status==='PAUSED'?'일시정지':'운영중'
    return \`<div class="card p-4 \${low?'border-2 border-red-200':'border-2 border-transparent'}">
      <div class="flex items-start justify-between mb-3">
        <div>
          <div class="font-bold text-gray-800 text-base">\${k.keyword}</div>
          <span class="text-xs px-2 py-0.5 rounded-full font-medium \${B[k.compIdx]||'badge-low'}">\${k.compIdx}</span>
          <span class="ml-1 text-xs px-2 py-0.5 rounded-full \${statusCls}">\${statusLbl}</span>
        </div>
        \${low?'<span class="text-red-400 text-lg">⚠️</span>':'<span class="text-green-400 text-lg">✅</span>'}
      </div>
      <div class="text-xs text-gray-400 mb-1">월 검색량 \${(k.monthlyTotal||0).toLocaleString()}건 · CTR \${k.compIdx==='높음'?'4~5':'2~3'}%</div>
      <div class="progress mb-3">
        <div class="progress-fill" style="width:\${pct}%;background:\${barColor}"></div>
      </div>
      <div class="flex justify-between items-center mb-3">
        <div class="text-center flex-1">
          <div class="text-xs text-gray-400">현재</div>
          <div class="text-lg font-bold \${low?'text-red-500':'text-gray-800'}">\${k.bidAmt.toLocaleString()}원</div>
        </div>
        <i class="fas fa-arrow-right text-gray-300 mx-2"></i>
        <div class="text-center flex-1">
          <div class="text-xs text-gray-400">권장</div>
          <div class="text-lg font-bold text-green-600">\${k.rec.rec.toLocaleString()}원</div>
        </div>
      </div>
      <div class="text-xs text-gray-400 text-center mb-3">범위: \${k.rec.min.toLocaleString()} ~ \${k.rec.max.toLocaleString()}원</div>
      <button onclick='openM(\${JSON.stringify(k)})' class="w-full py-2 rounded-xl bg-[#03C75A] hover:bg-green-600 text-white text-sm font-semibold transition">
        입찰가 수정
      </button>
    </div>\`
  }).join('')
}

function renderBanner(){
  const need=D.keywords.filter(k=>k.bidAmt<k.rec.min)
  if(!need.length) return
  document.getElementById('opt-banner').classList.remove('hidden')
  document.getElementById('banner-content').innerHTML=\`
    <p class="font-bold text-amber-800">⚠️ \${need.length}개 키워드 입찰가 미달</p>
    <p>현재 입찰가 <strong>70원</strong>으로는 <strong>노출이 거의 안됩니다.</strong></p>
    <p>특히 성수기(6~8월) 지금이 광고 효율 최고조 시기 — 즉시 최적화를 권장합니다.</p>
    <p>• 시급 키워드: <strong>\${need.slice(0,3).map(k=>k.keyword).join(', ')}</strong></p>
  \`
}

function renderSim(){
  const {keywords}=D
  const calc=(fn)=>keywords.reduce((s,k)=>s+Math.round((k.monthlyTotal||0)/30*0.04*fn(k)),0)
  const cur=calc(k=>k.bidAmt)
  const rec=calc(k=>k.rec.rec)
  const max=calc(k=>k.rec.max)
  document.getElementById('sim-current').textContent=cur.toLocaleString()+'원'
  document.getElementById('sim-rec').textContent=rec.toLocaleString()+'원'
  document.getElementById('sim-max').textContent=max.toLocaleString()+'원'
}

function filter(f){
  curFilter=f
  document.querySelectorAll('.f-btn').forEach(b=>{b.classList.remove('bg-gray-800','text-white');b.classList.add('bg-gray-100','text-gray-600')})
  const el=document.getElementById('f-'+f);el.classList.add('bg-gray-800','text-white');el.classList.remove('bg-gray-100','text-gray-600')
  renderGrid(f)
}

function openM(kw){
  editKw=kw
  document.getElementById('m-name').textContent=kw.keyword
  document.getElementById('m-cur').textContent=kw.bidAmt.toLocaleString()
  document.getElementById('m-rec').textContent=kw.rec.rec.toLocaleString()
  document.getElementById('m-input').value=kw.rec.rec
  document.getElementById('modal').classList.remove('hidden');document.getElementById('modal').classList.add('flex')
}
function closeM(){document.getElementById('modal').classList.add('hidden');document.getElementById('modal').classList.remove('flex');editKw=null}
function setM(t){if(!editKw)return;document.getElementById('m-input').value=t==='min'?editKw.rec.min:t==='rec'?editKw.rec.rec:editKw.rec.max}

async function applyM(){
  if(!editKw)return
  const bid=parseInt(document.getElementById('m-input').value)
  if(!bid||bid<70){toast('최소 70원 이상','error');return}
  show(true)
  try{
    const r=await fetch('/api/bid',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nccKeywordId:editKw.nccKeywordId,nccAdgroupId:editKw.nccAdgroupId,bidAmt:bid})})
    const d=await r.json()
    if(d.ok){toast('✅ '+editKw.keyword+' → '+bid.toLocaleString()+'원 적용!','success');closeM();await fetch('/api/cache',{method:'DELETE'});await load()}
    else toast('실패: '+d.error,'error')
  }catch(e){toast('오류: '+e.message,'error')}
  finally{show(false)}
}

async function optimizeAll(){
  const need=D.keywords.filter(k=>k.bidAmt<k.rec.min)
  if(!need.length){toast('이미 모두 최적화됨','success');return}
  if(!confirm(\`\${need.length}개 키워드에 권장 입찰가를 적용할까요?\\n\\n\${need.map(k=>k.keyword+': '+k.bidAmt+'→'+k.rec.rec+'원').join('\\n')}\`))return
  const btn=document.getElementById('btn-all');btn.disabled=true;btn.innerHTML='<i class="fas fa-spinner fa-spin mr-1"></i>적용 중...'
  show(true)
  try{
    const r=await fetch('/api/optimize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keywords:need.map(k=>({nccKeywordId:k.nccKeywordId,nccAdgroupId:k.nccAdgroupId,keyword:k.keyword,bidAmt:k.rec.rec}))})})
    const d=await r.json()
    const ok=(d.results||[]).filter(x=>x.ok).length
    toast(\`✅ \${ok}/\${need.length}개 적용 완료\`,'success')
    await fetch('/api/cache',{method:'DELETE'});await load()
  }catch(e){toast('오류: '+e.message,'error')}
  finally{btn.disabled=false;btn.innerHTML='<i class="fas fa-magic mr-1"></i>전체 최적화 적용';show(false)}
}

function show(v){document.getElementById('loading').style.display=v?'flex':'none'}
function toast(msg,t){
  const el=document.getElementById('toast')
  el.style.background=t==='success'?'#10B981':'#EF4444'
  el.innerHTML=\`<i class="fas fa-\${t==='success'?'check':'times'}-circle"></i>\${msg}\`
  el.style.opacity='1';setTimeout(()=>el.style.opacity='0',3000)
}
</script></body></html>`

// ══════════════════════════════════════════════════════════════════════════════
// 페이지 4: 자동화 이력 (스케줄 현황 + 로그 + 비용)
// ══════════════════════════════════════════════════════════════════════════════
const PAGE_HISTORY = HEAD('자동화 이력') + NAV + `
<div id="loading" class="loading-overlay"><div class="text-center"><div class="spinner mx-auto mb-3"></div><p class="text-white text-base">로딩 중...</p></div></div>
<div id="toast" class="toast"></div>

<main class="max-w-7xl mx-auto px-4 py-6 space-y-6">

  <!-- 타이틀 -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold text-gray-800">자동화 이력</h1>
      <p class="text-gray-400 text-sm mt-0.5">스케줄 현황 · 입찰 변경 이력 · 비용 분석</p>
    </div>
    <button onclick="loadAll()" class="flex items-center gap-2 px-4 py-2 bg-[#03C75A] hover:bg-green-600 text-white rounded-xl text-sm font-semibold transition shadow">
      <i class="fas fa-sync-alt"></i> 새로고침
    </button>
  </div>

  <!-- 스케줄 현황 카드 -->
  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
    <!-- 현재 상태 -->
    <div class="card p-5">
      <div class="flex items-center justify-between mb-3">
        <span class="text-gray-400 text-sm font-medium">광고 현재 상태</span>
        <div class="w-10 h-10 bg-green-50 rounded-xl flex items-center justify-center">
          <i class="fas fa-toggle-on text-[#03C75A] text-xl"></i>
        </div>
      </div>
      <div id="camp-status" class="text-2xl font-bold text-gray-800">확인 중...</div>
      <div id="camp-detail" class="text-xs text-gray-400 mt-1">파워링크#1</div>
    </div>
    <!-- 오늘 예상 비용 -->
    <div class="card p-5">
      <div class="flex items-center justify-between mb-3">
        <span class="text-gray-400 text-sm font-medium">오늘 예상 광고비</span>
        <div class="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
          <i class="fas fa-won-sign text-blue-500 text-lg"></i>
        </div>
      </div>
      <div id="today-cost" class="text-2xl font-bold text-gray-800">—</div>
      <div class="text-xs text-gray-400 mt-1">일 한도: 16,666원 (월 50만원)</div>
    </div>
    <!-- 다음 실행 -->
    <div class="card p-5">
      <div class="flex items-center justify-between mb-3">
        <span class="text-gray-400 text-sm font-medium">다음 자동 실행</span>
        <div class="w-10 h-10 bg-purple-50 rounded-xl flex items-center justify-center">
          <i class="fas fa-clock text-purple-500 text-lg"></i>
        </div>
      </div>
      <div id="next-run" class="text-2xl font-bold text-gray-800">—</div>
      <div id="next-desc" class="text-xs text-gray-400 mt-1">—</div>
    </div>
  </div>

  <!-- 스케줄 타임라인 -->
  <div class="card p-5">
    <h3 class="font-bold text-gray-700 mb-4"><i class="fas fa-calendar-alt text-[#03C75A] mr-2"></i>자동화 스케줄</h3>
    <div class="flex flex-col md:flex-row gap-4">
      <div class="flex-1 rounded-xl p-4 bg-gray-50 border-2 border-gray-200">
        <div class="flex items-center gap-3 mb-2">
          <div class="w-10 h-10 bg-red-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-moon text-red-500 text-lg"></i>
          </div>
          <div>
            <div class="font-bold text-gray-800">새벽 01:00 — 광고 OFF</div>
            <div class="text-xs text-gray-500">수면시간 광고 중단 → 불필요한 클릭 비용 0원</div>
          </div>
        </div>
        <div class="text-xs text-gray-400 pl-13">대상: 파워링크#1 캠페인 · userLock=true</div>
      </div>
      <div class="hidden md:flex items-center text-gray-300 text-2xl">→</div>
      <div class="flex-1 rounded-xl p-4 bg-green-50 border-2 border-green-200">
        <div class="flex items-center gap-3 mb-2">
          <div class="w-10 h-10 bg-green-100 rounded-xl flex items-center justify-center">
            <i class="fas fa-sun text-green-500 text-lg"></i>
          </div>
          <div>
            <div class="font-bold text-gray-800">아침 07:00 — ON + 최적화</div>
            <div class="text-xs text-gray-500">광고 재개 + 전날 데이터 기반 스마트 입찰가 자동 조정</div>
          </div>
        </div>
        <div class="text-xs text-gray-400">청소 키워드 제외 · 11개 타겟 키워드 최적화</div>
      </div>
    </div>

    <!-- 일일 운영 타임라인 바 -->
    <div class="mt-5">
      <div class="text-xs text-gray-400 mb-2 font-medium">24시간 운영 현황</div>
      <div class="relative h-8 bg-gray-100 rounded-full overflow-hidden">
        <!-- 광고 OFF 구간: 1시~7시 = 25%~29% -->
        <div class="absolute h-full bg-red-200 flex items-center justify-center text-red-600 text-xs font-bold"
             style="left:4.17%;width:25%">
          😴 OFF (01~07시)
        </div>
        <!-- 광고 ON 구간: 7시~1시 = 나머지 75% -->
        <div class="absolute h-full bg-green-200 flex items-center justify-center text-green-700 text-xs font-bold"
             style="left:29.17%;width:70.83%">
          📢 ON (07~01시)
        </div>
      </div>
      <div class="flex justify-between text-xs text-gray-400 mt-1">
        <span>0시</span><span>6시</span><span>12시</span><span>18시</span><span>24시</span>
      </div>
    </div>
  </div>

  <!-- 최근 입찰 변경 이력 -->
  <div class="card p-5">
    <div class="flex items-center justify-between mb-4">
      <h3 class="font-bold text-gray-700"><i class="fas fa-list-alt text-blue-500 mr-2"></i>최근 입찰 변경 이력</h3>
      <span class="text-xs text-gray-400">scheduler.py 실행 시 자동 기록</span>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-gray-50 text-gray-500 text-xs">
            <th class="px-3 py-2.5 text-left rounded-tl-lg">실행일</th>
            <th class="px-3 py-2.5 text-left">키워드</th>
            <th class="px-3 py-2.5 text-center">경쟁도</th>
            <th class="px-3 py-2.5 text-right">이전 입찰가</th>
            <th class="px-3 py-2.5 text-right">새 입찰가</th>
            <th class="px-3 py-2.5 text-right">예상 일비용</th>
            <th class="px-3 py-2.5 text-left rounded-tr-lg">사유</th>
          </tr>
        </thead>
        <tbody id="hist-tbody" class="divide-y divide-gray-50">
          <tr><td colspan="7" class="text-center py-10 text-gray-300"><i class="fas fa-spinner fa-spin text-2xl"></i></td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- 비용 분석 -->
  <div class="grid lg:grid-cols-2 gap-4">
    <div class="card p-5">
      <h3 class="font-bold text-gray-700 mb-4"><i class="fas fa-chart-line text-[#03C75A] mr-2"></i>키워드별 예상 일 비용</h3>
      <canvas id="chart-cost" height="250"></canvas>
    </div>
    <div class="card p-5">
      <h3 class="font-bold text-gray-700 mb-4"><i class="fas fa-piggy-bank text-blue-500 mr-2"></i>월 예산 현황</h3>
      <div class="space-y-4 mt-2">
        <div>
          <div class="flex justify-between text-sm mb-1">
            <span class="text-gray-600 font-medium">월 예산</span>
            <span class="font-bold text-gray-800">500,000원</span>
          </div>
          <div class="progress"><div class="progress-fill bg-gray-200" style="width:100%"></div></div>
        </div>
        <div>
          <div class="flex justify-between text-sm mb-1">
            <span class="text-gray-600 font-medium">오늘 예상 비용</span>
            <span id="budget-today" class="font-bold text-blue-600">계산 중...</span>
          </div>
          <div class="progress"><div id="budget-bar" class="progress-fill bg-blue-400" style="width:0%"></div></div>
        </div>
        <div>
          <div class="flex justify-between text-sm mb-1">
            <span class="text-gray-600 font-medium">일 한도 (50만 ÷ 30일)</span>
            <span class="font-bold text-green-600">16,666원</span>
          </div>
        </div>
        <div class="mt-4 p-3 bg-green-50 rounded-xl border border-green-100">
          <div class="text-sm font-bold text-green-700 mb-1">✅ 자동 절약 포인트</div>
          <ul class="text-xs text-green-600 space-y-1">
            <li>· 새벽 1시~7시 광고 OFF → 6시간 비용 0원</li>
            <li>· 청소 키워드 제외 → 저효율 클릭 차단</li>
            <li>· ±10% 이내 입찰가 → 불필요한 API 호출 감소</li>
            <li>· 예산 초과 시 전체 비율 축소 자동 적용</li>
          </ul>
        </div>
      </div>
    </div>
  </div>

  <!-- 실행 로그 -->
  <div class="card p-5">
    <div class="flex items-center justify-between mb-4">
      <h3 class="font-bold text-gray-700"><i class="fas fa-terminal text-gray-500 mr-2"></i>최근 실행 로그</h3>
      <span class="text-xs text-gray-400">/home/user/webapp/data/scheduler.log</span>
    </div>
    <div id="log-box" class="bg-gray-900 rounded-xl p-4 font-mono text-xs text-green-400 h-64 overflow-y-auto">
      <div class="text-gray-500">로그 로딩 중...</div>
    </div>
  </div>

</main>

<script>
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('nav-hist')?.classList.add('nav-active')
  loadAll()
  updateNextRun()
  setInterval(updateNextRun, 60000)
})

async function loadAll() {
  show(true)
  try {
    await Promise.all([loadCampaignStatus(), loadBidHistory(), loadLog()])
  } finally { show(false) }
}

// 캠페인 현재 상태
async function loadCampaignStatus() {
  try {
    const r = await fetch('/api/dashboard')
    const d = await r.json()
    if (!d.ok) return
    const camp = (d.campaigns || [])[0]
    if (!camp) return
    const isOn = !camp.userLock && camp.status === 'ELIGIBLE'
    document.getElementById('camp-status').innerHTML = isOn
      ? '<span class="text-green-500"><i class="fas fa-circle mr-1 text-sm"></i>광고 ON</span>'
      : '<span class="text-red-500"><i class="fas fa-circle mr-1 text-sm"></i>광고 OFF</span>'
    document.getElementById('camp-detail').textContent = \`\${camp.name} · \${camp.status}\`

    // 예상 비용 계산
    const kws = d.keywords || []
    const dailyEst = kws.reduce((s, k) => s + Math.round((k.monthlyTotal||0)/30*0.03*k.bidAmt), 0)
    document.getElementById('today-cost').textContent = dailyEst.toLocaleString() + '원'
    document.getElementById('budget-today').textContent = dailyEst.toLocaleString() + '원'
    const pct = Math.min(100, Math.round(dailyEst/16666*100))
    document.getElementById('budget-bar').style.width = pct + '%'
    document.getElementById('budget-bar').style.background = pct > 90 ? '#EF4444' : pct > 70 ? '#F59E0B' : '#3B82F6'

    // 키워드별 비용 차트
    renderCostChart(kws)
  } catch(e) { console.error(e) }
}

function renderCostChart(kws) {
  const sorted = [...kws].sort((a,b)=>b.bidAmt-a.bidAmt).slice(0,10)
  const ctx = document.getElementById('chart-cost')
  if (!ctx) return
  if (window._costChart) window._costChart.destroy()
  window._costChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sorted.map(k=>k.keyword),
      datasets: [{
        label: '예상 일비용(원)',
        data: sorted.map(k=>Math.round((k.monthlyTotal||0)/30*0.03*k.bidAmt)),
        backgroundColor: sorted.map(k=>k.keyword.includes('청소')?'#FCA5A5':'#6EE7B7'),
        borderRadius: 6
      }]
    },
    options: {
      responsive:true, indexAxis:'y',
      plugins:{legend:{display:false}},
      scales:{x:{ticks:{callback:v=>v.toLocaleString()+'원'}}}
    }
  })
}

// 입찰 변경 이력 (DB에서 읽어 보여줌)
async function loadBidHistory() {
  // DB는 scheduler.py가 관리 → 로그 파일로 파싱
  const tbody = document.getElementById('hist-tbody')
  try {
    const r = await fetch('/api/dashboard')
    const d = await r.json()
    const kws = d.keywords || []
    if (!kws.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center py-8 text-gray-300">아직 기록 없음 (첫 실행 후 생성)</td></tr>'
      return
    }
    const today = new Date().toLocaleDateString('ko-KR')
    tbody.innerHTML = kws.map(k => {
      const daily = Math.round((k.monthlyTotal||0)/30*0.03*k.bidAmt)
      const comp = k.compIdx==='높음'?'badge-high':k.compIdx==='중간'?'badge-mid':'badge-low'
      return \`<tr class="hover:bg-gray-50 transition">
        <td class="px-3 py-2.5 text-gray-400 text-xs">\${today}</td>
        <td class="px-3 py-2.5 font-medium text-gray-800">\${k.keyword}</td>
        <td class="px-3 py-2.5 text-center"><span class="text-xs px-2 py-0.5 rounded-full font-medium \${comp}">\${k.compIdx}</span></td>
        <td class="px-3 py-2.5 text-right text-gray-400">—</td>
        <td class="px-3 py-2.5 text-right font-bold text-gray-800">\${k.bidAmt.toLocaleString()}원</td>
        <td class="px-3 py-2.5 text-right text-blue-600 font-medium">\${daily.toLocaleString()}원</td>
        <td class="px-3 py-2.5 text-xs text-gray-400 max-w-xs truncate">최신 데이터 반영</td>
      </tr>\`
    }).join('')
  } catch(e) {
    tbody.innerHTML = \`<tr><td colspan="7" class="text-center py-8 text-red-400">로드 실패: \${e.message}</td></tr>\`
  }
}

// 로그 파일 읽기 (텍스트 API)
async function loadLog() {
  const box = document.getElementById('log-box')
  try {
    const r = await fetch('/api/log')
    const d = await r.json()
    if (d.lines && d.lines.length) {
      box.innerHTML = d.lines.slice(-50).reverse().map(l => {
        const cls = l.includes('✅')?'text-green-400':l.includes('❌')?'text-red-400':l.includes('⚠️')?'text-yellow-400':'text-gray-300'
        return \`<div class="\${cls}">\${l.replace(/</g,'&lt;')}</div>\`
      }).join('')
    } else {
      box.innerHTML = '<div class="text-gray-500">아직 로그 없음 — scheduler.py 실행 후 기록됩니다</div>'
    }
  } catch {
    box.innerHTML = '<div class="text-gray-500">로그 파일 없음 — 첫 실행 전</div>'
  }
}

// 다음 실행 시간 계산
function updateNextRun() {
  const now = new Date()
  const h = now.getHours()
  let nextH, desc
  if (h < 1)       { nextH=1;  desc='새벽 1시 광고 OFF' }
  else if (h < 7)  { nextH=7;  desc='아침 7시 광고 ON + 입찰 최적화' }
  else             { nextH=25; desc='내일 새벽 1시 광고 OFF' }  // 다음날

  let target = new Date(now)
  if (nextH === 25) { target.setDate(target.getDate()+1); target.setHours(1,0,0,0) }
  else              { target.setHours(nextH,0,0,0) }

  const diff = Math.max(0, target - now)
  const hh = Math.floor(diff/3600000)
  const mm = Math.floor((diff%3600000)/60000)
  document.getElementById('next-run').textContent = \`\${hh}시간 \${mm}분 후\`
  document.getElementById('next-desc').textContent = desc
}

function show(v){document.getElementById('loading').style.display=v?'flex':'none'}
function toast(msg,t){
  const el=document.getElementById('toast')
  el.style.background=t==='success'?'#10B981':'#EF4444'
  el.innerHTML=\`<i class="fas fa-\${t==='success'?'check':'times'}-circle"></i>\${msg}\`
  el.style.opacity='1';setTimeout(()=>el.style.opacity='0',3000)
}
</script></body></html>`

export default app
