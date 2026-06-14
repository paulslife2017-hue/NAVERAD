import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono()
app.use('*', cors())

// ── 인증 ──────────────────────────────────────────────────────────────────────
const AL  = '0100000000e8a9e5c719ef2ea8318c370686c95f2e7a575fd22e8075980031db54654aa701'
const SK  = 'AQAAAADoqeXHGe8uqDGMNwaGyV8ub0ko3GK/zB5aWTFEsaWJMw=='
const CID = '4412351'
const API = 'https://api.naver.com'

// 캐시 (1시간) — 크레딧 핵심 절약
const cache: Record<string, { data: unknown; ts: number }> = {}
const TTL_1H  = 60 * 60 * 1000
const TTL_6H  = 6  * 60 * 60 * 1000

// 청소 계열 제외
const EXCLUDE = new Set(['에어컨청소','삼성에어컨청소','벽걸이에어컨셀프청소','에어컨분해청소','에바크리닝','에어컨청소비용'])

// 지역 타겟 (수동 설정 완료)
const REGIONS = ['남양주','구리','강동','하남','중랑','동대문','노원','강북','성북','금천','관악','구로','영등포','광명','안양']

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

// stats API — GET /stats (필드 JSON배열 형식)
async function nStats(ids: string[], days = 30) {
  if (!ids.length) return []
  const ckey = '__stats__' + ids.slice(0,3).join(',') + days
  if (cache[ckey] && Date.now() - cache[ckey].ts < TTL_6H) return cache[ckey].data

  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0,10)
  const until = new Date().toISOString().slice(0,10)
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

// ── /api/data — 단일 엔드포인트 (최대 4 API 호출) ───────────────────────────
app.get('/api/data', async (c) => {
  try {
    // 1. 캠페인 + 광고그룹 병렬 (2회)
    const [camps, adgroups] = await Promise.all([
      nGet('/ncc/campaigns') as Promise<any[]>,
      nGet('/ncc/adgroups')  as Promise<any[]>,
    ])

    // 2. 키워드 (그룹 수만큼, 보통 1~2회)
    const kwBatch = await Promise.all(
      adgroups.map((ag: any) => nGet('/ncc/keywords', { nccAdgroupId: ag.nccAdgroupId }).catch(() => []) as Promise<any[]>)
    )
    const allKw: any[] = (kwBatch as any[][]).flat()

    // 3. stats (키워드 전체 ID 한방 — 1회, 6h캐시)
    const ids = allKw.map((k: any) => k.nccKeywordId)
    const statsRaw: any[] = await nStats(ids, 30) as any[]

    // stats를 keyword_id 기준으로 합산 (30일치 합계)
    const statsMap: Record<string, { imp: number; clk: number; cost: number }> = {}
    for (const row of statsRaw) {
      const id = row.id
      const s = row.statData || row.stat || {}
      if (!statsMap[id]) statsMap[id] = { imp: 0, clk: 0, cost: 0 }
      statsMap[id].imp  += Number(s.impCnt   || s.impressionCnt || 0)
      statsMap[id].clk  += Number(s.clkCnt   || s.clickCnt      || 0)
      statsMap[id].cost += Number(s.salesAmt  || 0)
    }

    // 키워드 보강
    const keywords = allKw.map((k: any) => {
      const st = statsMap[k.nccKeywordId] || { imp:0, clk:0, cost:0 }
      const ctr  = st.imp > 0 ? +(st.clk / st.imp * 100).toFixed(1) : 0
      const acpc = st.clk > 0 ? Math.round(st.cost / st.clk) : 0
      return {
        id:       k.nccKeywordId,
        agId:     k.nccAdgroupId,
        keyword:  k.keyword,
        bidAmt:   k.bidAmt,
        status:   k.status,
        userLock: k.userLock,
        excluded: EXCLUDE.has(k.keyword),
        imp:      st.imp,
        clk:      st.clk,
        cost:     st.cost,
        ctr,
        acpc,
      }
    })

    // 캠페인 상태
    const mainCamp = camps.find((c: any) => c.nccCampaignId === 'cmp-a001-01-000000010736912') || camps[0]
    const isOn = mainCamp && !mainCamp.userLock && mainCamp.status === 'ELIGIBLE'

    return c.json({
      ok: true,
      isOn,
      camp: mainCamp ? { name: mainCamp.name, status: mainCamp.status, dailyBudget: mainCamp.dailyBudget, totalChargeCost: mainCamp.totalChargeCost } : null,
      keywords,
      regions: REGIONS,
      cachedAt: new Date().toISOString(),
    })
  } catch(e: any) { return c.json({ ok:false, error: e.message }, 500) }
})

// ── /api/bid ─────────────────────────────────────────────────────────────────
app.post('/api/bid', async (c) => {
  try {
    const { nccKeywordId, nccAdgroupId, bidAmt } = await c.req.json()
    const r = await nPut(`/ncc/keywords/${nccKeywordId}?fields=nccAdgroupId,useGroupBidAmt,bidAmt`,
      { nccAdgroupId, useGroupBidAmt: false, bidAmt })
    return c.json({ ok:true, result: r })
  } catch(e: any) { return c.json({ ok:false, error: e.message }, 500) }
})

// ── /api/cache ────────────────────────────────────────────────────────────────
app.delete('/api/cache', (c) => {
  Object.keys(cache).forEach(k => delete cache[k])
  return c.json({ ok:true })
})

// ── 대시보드 단일 페이지 ──────────────────────────────────────────────────────
app.get('/', (c) => c.html(PAGE))
export default app

// ══════════════════════════════════════════════════════════════════════════════
const PAGE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>파워링크 광고 대시보드</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap');
*{font-family:'Noto Sans KR',sans-serif;box-sizing:border-box}
body{background:#0f1117;color:#e2e8f0;min-height:100vh}
.card{background:#1a1f2e;border:1px solid #2d3748;border-radius:16px}
.card-inner{background:#242938;border:1px solid #2d3748;border-radius:12px}
.naver-green{color:#03C75A}
.badge-on{background:#0d3321;color:#03C75A;border:1px solid #03C75A40}
.badge-off{background:#3d1515;color:#fc8181;border:1px solid #fc818140}
.badge-review{background:#2d2a0d;color:#f6e05e;border:1px solid #f6e05e40}
.badge-excl{background:#1e1e2e;color:#718096;border:1px solid #4a556840}
.kw-row{border-bottom:1px solid #2d3748;transition:.15s}
.kw-row:hover{background:#1e2535}
.kw-row:last-child{border-bottom:none}
.stat-zero{color:#4a5568}
.pill{display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600}
.spin{animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.toast{position:fixed;bottom:20px;right:20px;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:500;opacity:0;transition:opacity .3s;z-index:999}
.region-chip{display:inline-flex;align-items:center;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;background:#1a2535;color:#63b3ed;border:1px solid #2d4a6a}
.tab-btn{padding:6px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:.15s;color:#718096}
.tab-btn.active{background:#242938;color:#e2e8f0}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:#1a1f2e}
::-webkit-scrollbar-thumb{background:#4a5568;border-radius:2px}
</style>
</head>
<body>

<!-- 로딩 -->
<div id="loading" style="position:fixed;inset:0;background:#0f1117;display:flex;align-items:center;justify-content:center;z-index:100;flex-direction:column;gap:16px">
  <div style="width:40px;height:40px;border:3px solid #2d3748;border-top-color:#03C75A;border-radius:50%" class="spin"></div>
  <p style="color:#718096;font-size:14px">광고 데이터 로딩 중...</p>
</div>
<div id="toast" class="toast"></div>

<!-- NAV -->
<nav style="background:#13171f;border-bottom:1px solid #2d3748;position:sticky;top:0;z-index:50">
  <div style="max-width:1400px;margin:0 auto;padding:0 20px;height:52px;display:flex;align-items:center;justify-content:space-between">
    <div style="display:flex;align-items:center;gap:12px">
      <span style="font-size:18px;font-weight:700;color:#03C75A"><i class="fas fa-bolt"></i></span>
      <span style="font-size:15px;font-weight:700;color:#e2e8f0">파워링크 대시보드</span>
      <span style="font-size:11px;color:#4a5568;margin-left:4px">CID 4412351</span>
    </div>
    <div style="display:flex;align-items:center;gap:10px">
      <span id="camp-badge" class="pill badge-off"><i class="fas fa-circle" style="font-size:7px"></i>확인중</span>
      <span id="last-update" style="font-size:11px;color:#4a5568"></span>
      <button onclick="hardRefresh()" style="background:#242938;border:1px solid #2d3748;color:#a0aec0;padding:5px 12px;border-radius:8px;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px">
        <i class="fas fa-sync-alt" id="refresh-icon"></i> 새로고침
      </button>
    </div>
  </div>
</nav>

<main style="max-width:1400px;margin:0 auto;padding:20px">

  <!-- KPI 4개 -->
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px" id="kpi-row">
    <div class="card" style="padding:18px">
      <div style="font-size:11px;color:#718096;margin-bottom:8px">총 키워드</div>
      <div id="k-total" style="font-size:28px;font-weight:700;color:#e2e8f0">—</div>
      <div id="k-sub" style="font-size:11px;color:#4a5568;margin-top:4px">—</div>
    </div>
    <div class="card" style="padding:18px">
      <div style="font-size:11px;color:#718096;margin-bottom:8px">운영 키워드</div>
      <div id="k-active" style="font-size:28px;font-weight:700;color:#03C75A">—</div>
      <div style="font-size:11px;color:#4a5568;margin-top:4px">청소 제외 기준</div>
    </div>
    <div class="card" style="padding:18px">
      <div style="font-size:11px;color:#718096;margin-bottom:8px">30일 실제 비용</div>
      <div id="k-cost" style="font-size:28px;font-weight:700;color:#f6e05e">—</div>
      <div id="k-cost-sub" style="font-size:11px;color:#4a5568;margin-top:4px">VAT 포함</div>
    </div>
    <div class="card" style="padding:18px">
      <div style="font-size:11px;color:#718096;margin-bottom:8px">30일 클릭 수</div>
      <div id="k-clk" style="font-size:28px;font-weight:700;color:#76e4f7">—</div>
      <div id="k-acpc" style="font-size:11px;color:#4a5568;margin-top:4px">평균 CPC —원</div>
    </div>
  </div>

  <!-- 메인 2컬럼 -->
  <div style="display:grid;grid-template-columns:1fr 380px;gap:16px;align-items:start">

    <!-- 왼쪽: 키워드 테이블 -->
    <div class="card" style="padding:20px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <h2 style="font-size:15px;font-weight:700;color:#e2e8f0"><i class="fas fa-key" style="color:#03C75A;margin-right:8px"></i>키워드별 실적</h2>
        <div style="display:flex;gap:4px" id="tab-wrap">
          <button class="tab-btn active" onclick="setTab('all')" id="tab-all">전체</button>
          <button class="tab-btn" onclick="setTab('active')" id="tab-active">운영</button>
          <button class="tab-btn" onclick="setTab('excl')" id="tab-excl">제외</button>
        </div>
      </div>

      <!-- 데이터 없을 때 안내 -->
      <div id="no-data-notice" style="display:none;background:#1e2535;border:1px solid #2d4a6a;border-radius:10px;padding:14px 16px;margin-bottom:14px">
        <div style="color:#76e4f7;font-size:13px;font-weight:600;margin-bottom:6px"><i class="fas fa-info-circle mr-1"></i> 아직 실적 데이터 없음</div>
        <div style="color:#718096;font-size:12px;line-height:1.6">
          현재 광고가 <strong style="color:#fc8181">PAUSED</strong> 상태라 클릭/비용 데이터가 없습니다.<br>
          7시 광고 ON 이후 데이터가 쌓이면 자동 반영됩니다. <span style="color:#4a5568">(6시간 캐시)</span>
        </div>
      </div>

      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="border-bottom:1px solid #2d3748">
              <th style="padding:8px 10px;text-align:left;color:#4a5568;font-weight:600;font-size:11px;white-space:nowrap">키워드</th>
              <th style="padding:8px 10px;text-align:center;color:#4a5568;font-weight:600;font-size:11px">상태</th>
              <th style="padding:8px 10px;text-align:right;color:#4a5568;font-weight:600;font-size:11px">입찰가</th>
              <th style="padding:8px 10px;text-align:right;color:#4a5568;font-weight:600;font-size:11px">노출</th>
              <th style="padding:8px 10px;text-align:right;color:#4a5568;font-weight:600;font-size:11px">클릭</th>
              <th style="padding:8px 10px;text-align:right;color:#4a5568;font-weight:600;font-size:11px">CTR</th>
              <th style="padding:8px 6px;text-align:right;color:#4a5568;font-weight:600;font-size:11px;white-space:nowrap">실제비용 <span style="font-weight:400;color:#2d3748">(30일)</span></th>
              <th style="padding:8px 10px;text-align:right;color:#4a5568;font-weight:600;font-size:11px">CPC</th>
            </tr>
          </thead>
          <tbody id="kw-body">
            <tr><td colspan="8" style="text-align:center;padding:40px;color:#4a5568"><i class="fas fa-spinner fa-spin"></i></td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 오른쪽 패널 -->
    <div style="display:flex;flex-direction:column;gap:14px">

      <!-- 광고 상태 카드 -->
      <div class="card" style="padding:18px">
        <div style="font-size:11px;color:#718096;margin-bottom:12px;font-weight:600">광고 운영 현황</div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
          <div id="status-dot" style="width:10px;height:10px;border-radius:50%;background:#fc8181;flex-shrink:0"></div>
          <div id="status-text" style="font-size:20px;font-weight:700;color:#e2e8f0">—</div>
        </div>
        <div id="camp-detail" style="font-size:12px;color:#4a5568;margin-bottom:14px"></div>

        <!-- 스케줄 타임바 -->
        <div style="margin-bottom:8px">
          <div style="font-size:11px;color:#718096;margin-bottom:6px">오늘 운영 스케줄</div>
          <div style="position:relative;height:24px;background:#1e2535;border-radius:6px;overflow:hidden">
            <div style="position:absolute;height:100%;background:#3d1515;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fc8181;font-weight:700;left:4.17%;width:25%">OFF 01~07시</div>
            <div style="position:absolute;height:100%;background:#0d2e1a;display:flex;align-items:center;justify-content:center;font-size:10px;color:#03C75A;font-weight:700;left:29.17%;width:70.83%">ON 07~01시</div>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:10px;color:#4a5568;margin-top:3px">
            <span>0시</span><span>6시</span><span>12시</span><span>18시</span><span>24시</span>
          </div>
        </div>

        <!-- 다음 실행 -->
        <div class="card-inner" style="padding:10px 12px;display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:11px;color:#718096">다음 실행</div>
          <div style="text-align:right">
            <div id="next-run" style="font-size:13px;font-weight:700;color:#e2e8f0">—</div>
            <div id="next-desc" style="font-size:10px;color:#4a5568">—</div>
          </div>
        </div>
      </div>

      <!-- 지역 타겟 -->
      <div class="card" style="padding:18px">
        <div style="font-size:11px;color:#718096;margin-bottom:10px;font-weight:600">
          <i class="fas fa-map-marker-alt" style="color:#f6ad55;margin-right:4px"></i>지역 타겟 <span style="color:#4a5568">(15개 수동설정)</span>
        </div>
        <div id="region-chips" style="display:flex;flex-wrap:wrap;gap:5px"></div>
        <div style="margin-top:10px;font-size:11px;color:#4a5568;line-height:1.5">
          동북권 9개 · 서남권 6개<br>
          <span style="color:#2d3748">지역별 비용 데이터는 광고 집행 후 표시됩니다</span>
        </div>
      </div>

      <!-- 30일 비용 차트 -->
      <div class="card" style="padding:18px">
        <div style="font-size:11px;color:#718096;margin-bottom:12px;font-weight:600"><i class="fas fa-chart-bar" style="color:#a78bfa;margin-right:4px"></i>키워드별 실제 비용 (30일)</div>
        <canvas id="chart-cost" height="200"></canvas>
        <div id="chart-empty" style="display:none;text-align:center;padding:40px 0;color:#4a5568;font-size:12px">
          광고 집행 후 데이터가 표시됩니다
        </div>
      </div>

      <!-- 청소 제외 현황 -->
      <div class="card" style="padding:18px">
        <div style="font-size:11px;color:#718096;margin-bottom:10px;font-weight:600"><i class="fas fa-ban" style="color:#fc8181;margin-right:4px"></i>청소 키워드 제외 목록</div>
        <div id="excl-list" style="display:flex;flex-direction:column;gap:5px"></div>
        <div style="margin-top:10px;font-size:11px;color:#4a5568">
          저효율 클릭 차단 → 비용 절약
        </div>
      </div>

      <!-- 빠른 입찰 수정 -->
      <div class="card" style="padding:18px">
        <div style="font-size:11px;color:#718096;margin-bottom:12px;font-weight:600"><i class="fas fa-sliders-h" style="color:#76e4f7;margin-right:4px"></i>입찰가 수정</div>
        <select id="bid-sel" style="width:100%;background:#242938;border:1px solid #2d3748;color:#e2e8f0;padding:8px 10px;border-radius:8px;font-size:13px;margin-bottom:8px">
          <option value="">키워드 선택...</option>
        </select>
        <div style="display:flex;gap:6px">
          <input id="bid-val" type="number" min="70" step="10" placeholder="입찰가 (원)"
            style="flex:1;background:#242938;border:1px solid #2d3748;color:#e2e8f0;padding:8px 10px;border-radius:8px;font-size:13px"/>
          <button onclick="applyBid()" style="background:#03C75A;color:#fff;border:none;padding:8px 14px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap">적용</button>
        </div>
        <div id="bid-info" style="font-size:11px;color:#4a5568;margin-top:6px"></div>
      </div>

    </div>
  </div>

  <!-- 하단: 집행 안내 -->
  <div style="margin-top:16px;background:#13171f;border:1px solid #1e3a1e;border-radius:12px;padding:14px 18px;display:flex;gap:24px;flex-wrap:wrap">
    <div style="font-size:12px;color:#03C75A;font-weight:600"><i class="fas fa-shield-alt mr-1"></i> 크레딧 절약 구조</div>
    <div style="font-size:11px;color:#4a5568">· 모든 데이터 <strong style="color:#718096">1시간 캐시</strong> (stats 6시간)</div>
    <div style="font-size:11px;color:#4a5568">· API 호출 최대 <strong style="color:#718096">5회/새로고침</strong></div>
    <div style="font-size:11px;color:#4a5568">· 새벽 1시~7시 광고 OFF → <strong style="color:#718096">6시간 비용 0원</strong></div>
    <div style="font-size:11px;color:#4a5568">· 청소 키워드 <strong style="color:#718096">5종 제외</strong> 자동 적용</div>
  </div>

</main>

<script>
let D = null
let curTab = 'all'
let costChart = null

document.addEventListener('DOMContentLoaded', () => {
  loadData()
  updateNextRun()
  setInterval(updateNextRun, 60000)
  renderRegionChips()
  renderExclList()
})

async function loadData() {
  try {
    const r = await fetch('/api/data')
    D = await r.json()
    if (!D.ok) { toast('API 오류: ' + D.error, 'err'); return }
    renderAll()
  } catch(e) { toast('로드 실패: ' + e.message, 'err') }
  finally { document.getElementById('loading').style.display = 'none' }
}

async function hardRefresh() {
  const icon = document.getElementById('refresh-icon')
  icon.classList.add('spin')
  await fetch('/api/cache', { method: 'DELETE' })
  await loadData()
  icon.classList.remove('spin')
  toast('데이터 갱신 완료', 'ok')
}

function renderAll() {
  renderKPI()
  renderStatus()
  renderTable(curTab)
  renderCostChart()
  renderBidSelect()
  const now = new Date(D.cachedAt)
  document.getElementById('last-update').textContent = now.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}) + ' 기준'
}

function renderKPI() {
  const kws = D.keywords || []
  const active = kws.filter(k => !k.excluded)
  const excl   = kws.filter(k => k.excluded)
  const totalCost = active.reduce((s, k) => s + k.cost, 0)
  const totalClk  = active.reduce((s, k) => s + k.clk,  0)
  const acpc = totalClk > 0 ? Math.round(totalCost / totalClk) : 0
  const hasData = totalCost > 0 || totalClk > 0

  document.getElementById('k-total').textContent  = kws.length
  document.getElementById('k-sub').textContent    = \`청소 제외 \${excl.length}개 포함\`
  document.getElementById('k-active').textContent = active.length
  document.getElementById('k-cost').textContent   = hasData ? totalCost.toLocaleString() + '원' : '—'
  document.getElementById('k-cost-sub').textContent = hasData ? \`30일 누적 · VAT포함\` : '데이터 없음 (광고 집행 전)'
  document.getElementById('k-clk').textContent    = hasData ? totalClk.toLocaleString() + '회' : '—'
  document.getElementById('k-acpc').textContent   = hasData ? \`평균 CPC \${acpc.toLocaleString()}원\` : '집행 후 표시'

  if (!hasData) document.getElementById('no-data-notice').style.display = 'block'
  else          document.getElementById('no-data-notice').style.display = 'none'
}

function renderStatus() {
  const { isOn, camp } = D
  const dot  = document.getElementById('status-dot')
  const txt  = document.getElementById('status-text')
  const badge = document.getElementById('camp-badge')

  if (isOn) {
    dot.style.background = '#03C75A'
    txt.textContent = '광고 ON'
    txt.style.color = '#03C75A'
    badge.className = 'pill badge-on'
    badge.innerHTML = '<i class="fas fa-circle" style="font-size:7px"></i> ON'
  } else {
    dot.style.background = '#fc8181'
    txt.textContent = '광고 OFF'
    txt.style.color = '#fc8181'
    badge.className = 'pill badge-off'
    badge.innerHTML = '<i class="fas fa-circle" style="font-size:7px"></i> OFF'
  }
  if (camp) {
    document.getElementById('camp-detail').textContent =
      \`\${camp.name} · 일예산 \${(camp.dailyBudget||0).toLocaleString()}원\`
  }
}

function setTab(t) {
  curTab = t
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
  document.getElementById('tab-' + t).classList.add('active')
  renderTable(t)
}

function renderTable(tab) {
  const kws = (D.keywords || []).filter(k => {
    if (tab === 'active') return !k.excluded
    if (tab === 'excl')   return k.excluded
    return true
  })
  const tbody = document.getElementById('kw-body')
  if (!kws.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:30px;color:#4a5568">없음</td></tr>'
    return
  }

  tbody.innerHTML = kws.map(k => {
    const statusBadge = k.excluded
      ? '<span class="pill badge-excl">제외</span>'
      : k.status === 'ELIGIBLE'
        ? '<span class="pill badge-on">운영</span>'
        : k.status === 'UNDER_REVIEW' || k.statusReason === 'KEYWORD_UNDER_REVIEW'
          ? '<span class="pill badge-review">심사중</span>'
          : '<span class="pill badge-off">정지</span>'

    const hasKwData = k.imp > 0 || k.cost > 0
    const impStr  = hasKwData ? k.imp.toLocaleString()  : '<span class="stat-zero">—</span>'
    const clkStr  = hasKwData ? k.clk.toLocaleString()  : '<span class="stat-zero">—</span>'
    const ctrStr  = hasKwData ? k.ctr + '%'             : '<span class="stat-zero">—</span>'
    const costStr = hasKwData
      ? \`<strong style="color:\${k.cost>0?'#f6e05e':'#718096'}">\${k.cost.toLocaleString()}원</strong>\`
      : '<span class="stat-zero">—</span>'
    const acpcStr = hasKwData && k.acpc > 0 ? k.acpc.toLocaleString() + '원' : '<span class="stat-zero">—</span>'

    return \`<tr class="kw-row \${k.excluded ? 'opacity-40' : ''}">
      <td style="padding:10px 10px;font-weight:600;color:\${k.excluded?'#4a5568':'#e2e8f0'};white-space:nowrap">
        \${k.keyword}\${k.excluded ? ' <span style="font-size:10px;color:#fc8181">[제외]</span>' : ''}
      </td>
      <td style="padding:10px;text-align:center">\${statusBadge}</td>
      <td style="padding:10px;text-align:right;color:#a0aec0;font-size:12px">\${k.bidAmt.toLocaleString()}원</td>
      <td style="padding:10px;text-align:right;font-size:12px">\${impStr}</td>
      <td style="padding:10px;text-align:right;font-size:12px">\${clkStr}</td>
      <td style="padding:10px;text-align:right;font-size:12px">\${ctrStr}</td>
      <td style="padding:10px 6px;text-align:right;font-size:12px">\${costStr}</td>
      <td style="padding:10px;text-align:right;font-size:12px">\${acpcStr}</td>
    </tr>\`
  }).join('')
}

function renderCostChart() {
  const kws = (D.keywords || []).filter(k => !k.excluded && k.cost > 0).sort((a,b) => b.cost - a.cost)
  const ctx = document.getElementById('chart-cost')

  if (!kws.length) {
    ctx.style.display = 'none'
    document.getElementById('chart-empty').style.display = 'block'
    return
  }
  ctx.style.display = 'block'
  document.getElementById('chart-empty').style.display = 'none'
  if (costChart) costChart.destroy()
  costChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: kws.map(k => k.keyword),
      datasets: [{
        data: kws.map(k => k.cost),
        backgroundColor: 'rgba(167,139,250,0.7)',
        borderColor: '#a78bfa',
        borderWidth: 1,
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true, indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#4a5568', callback: v => v.toLocaleString() + '원', font:{size:10} }, grid: { color: '#1e2535' } },
        y: { ticks: { color: '#a0aec0', font: { size: 11 } }, grid: { display: false } }
      }
    }
  })
}

function renderBidSelect() {
  const sel = document.getElementById('bid-sel')
  const kws = (D.keywords || []).filter(k => !k.excluded)
  sel.innerHTML = '<option value="">키워드 선택...</option>' +
    kws.map(k => \`<option value="\${k.id}" data-ag="" data-bid="\${k.bidAmt}">\${k.keyword} (\${k.bidAmt}원)</option>\`).join('')
  sel.addEventListener('change', () => {
    const opt = sel.selectedOptions[0]
    if (!opt.value) { document.getElementById('bid-info').textContent = ''; return }
    const bid = opt.dataset.bid
    document.getElementById('bid-val').value = bid
    document.getElementById('bid-info').textContent = '현재 입찰가: ' + Number(bid).toLocaleString() + '원'
  })
}

async function applyBid() {
  const sel = document.getElementById('bid-sel')
  const val = parseInt(document.getElementById('bid-val').value)
  if (!sel.value) { toast('키워드를 선택하세요', 'err'); return }
  if (!val || val < 70) { toast('최소 70원 이상 입력', 'err'); return }

  const kw = (D.keywords || []).find(k => k.id === sel.value)
  if (!kw) return

  // adgroupId는 dashboard에서 가져와야 함 — /ncc/adgroups 재조회 대신 캐시에서 추출
  // 실제론 API /ncc/keywords 응답에 nccAdgroupId가 없음 → /api/data에서 포함시켜야 함
  // 임시: 직접 bid API 호출 시 nccAdgroupId 필요 → 키워드 데이터에 포함 필요
  toast('입찰가 적용 중...', 'info')
  try {
    const r = await fetch('/api/bid', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nccKeywordId: kw.id, nccAdgroupId: kw.agId, bidAmt: val })
    })
    const d = await r.json()
    if (d.ok) {
      toast(\`✅ \${kw.keyword} → \${val.toLocaleString()}원 적용\`, 'ok')
      await hardRefresh()
    } else toast('실패: ' + d.error, 'err')
  } catch(e) { toast('오류: ' + e.message, 'err') }
}

function renderRegionChips() {
  const NE = ['남양주','구리','강동','하남','중랑','동대문','노원','강북','성북']
  const SW = ['금천','관악','구로','영등포','광명','안양']
  const wrap = document.getElementById('region-chips')
  wrap.innerHTML = [...NE, ...SW].map(r =>
    \`<span class="region-chip">\${r}</span>\`
  ).join('')
}

function renderExclList() {
  const excls = ['에어컨청소','삼성에어컨청소','벽걸이에어컨셀프청소','에어컨분해청소','에바크리닝']
  document.getElementById('excl-list').innerHTML = excls.map(kw =>
    \`<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;background:#1e1e2e;border-radius:6px">
      <i class="fas fa-times-circle" style="color:#fc8181;font-size:11px"></i>
      <span style="font-size:12px;color:#718096">\${kw}</span>
    </div>\`
  ).join('')
}

function updateNextRun() {
  const h = new Date().getHours()
  let nextH, desc
  if (h < 1)      { nextH = 1;  desc = '새벽 1시 광고 OFF' }
  else if (h < 7) { nextH = 7;  desc = '아침 7시 광고 ON + 입찰 최적화' }
  else            { nextH = 25; desc = '내일 새벽 1시 광고 OFF' }

  const now = new Date()
  const target = new Date(now)
  if (nextH === 25) { target.setDate(target.getDate()+1); target.setHours(1,0,0,0) }
  else              { target.setHours(nextH,0,0,0) }

  const diff = Math.max(0, target - now)
  const hh = Math.floor(diff/3600000)
  const mm = Math.floor((diff%3600000)/60000)
  document.getElementById('next-run').textContent  = \`\${hh}시간 \${mm}분 후\`
  document.getElementById('next-desc').textContent = desc
}

function toast(msg, t) {
  const el = document.getElementById('toast')
  el.style.background = t==='ok' ? '#0d3321' : t==='err' ? '#3d1515' : '#1a2535'
  el.style.border = \`1px solid \${t==='ok'?'#03C75A40':t==='err'?'#fc818140':'#76e4f740'}\`
  el.style.color  = t==='ok' ? '#03C75A' : t==='err' ? '#fc8181' : '#76e4f7'
  el.textContent = msg
  el.style.opacity = '1'
  setTimeout(() => el.style.opacity = '0', 3000)
}
</script>
</body>
</html>`
