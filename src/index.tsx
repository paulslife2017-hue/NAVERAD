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
// 일반 API: 1시간, stats: 12시간 (하루 최대 2회만 호출)
const cache: Record<string, { data: unknown; ts: number }> = {}
const TTL_1H  = 60 * 60 * 1000
const TTL_12H = 12 * 60 * 60 * 1000

// 청소 계열 — UI에 표시 안 함 (완전 제거)
const EXCLUDE = new Set(['에어컨청소','삼성에어컨청소','벽걸이에어컨셀프청소','에어컨분해청소','에바크리닝','에어컨청소비용'])

// 지역 타겟 (수동 설정 완료)
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

// stats — GET /stats (12시간 캐시, 하루 최대 2회)
async function nStats(ids: string[], days = 30) {
  if (!ids.length) return []
  const ckey = '__stats__' + days
  if (cache[ckey] && Date.now() - cache[ckey].ts < TTL_12H) return cache[ckey].data

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

// ── /api/data ─────────────────────────────────────────────────────────────────
// 캠페인(1) + 광고그룹(1) + 키워드(그룹수) + stats(1) = 최대 5회, 이후 캐시
app.get('/api/data', async (c) => {
  try {
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

    // 운영 키워드만 (제외 키워드 완전 제거)
    const activeKw = allKw.filter((k: any) => !EXCLUDE.has(k.keyword))

    // stats: 운영 키워드 ID만 조회 (크레딧 절약)
    const ids = activeKw.map((k: any) => k.nccKeywordId)
    const statsRaw: any[] = await nStats(ids, 30) as any[]

    // 키워드별 30일 합산
    const statsMap: Record<string, { imp: number; clk: number; cost: number }> = {}
    for (const row of statsRaw) {
      const id = row.id
      const s = row.statData || row.stat || {}
      if (!statsMap[id]) statsMap[id] = { imp: 0, clk: 0, cost: 0 }
      statsMap[id].imp  += Number(s.impCnt  || 0)
      statsMap[id].clk  += Number(s.clkCnt  || 0)
      statsMap[id].cost += Number(s.salesAmt || 0)
    }

    const keywords = activeKw.map((k: any) => {
      const st = statsMap[k.nccKeywordId] || { imp:0, clk:0, cost:0 }
      const ctr  = st.imp > 0 ? +(st.clk / st.imp * 100).toFixed(1) : 0
      const acpc = st.clk > 0 ? Math.round(st.cost / st.clk) : 0
      return {
        id:      k.nccKeywordId,
        agId:    k.nccAdgroupId,
        keyword: k.keyword,
        bidAmt:  k.bidAmt,
        status:  k.status,
        imp:     st.imp,
        clk:     st.clk,
        cost:    st.cost,
        ctr,
        acpc,
      }
    })

    const mainCamp = camps.find((c: any) => c.nccCampaignId === 'cmp-a001-01-000000010736912') || camps[0]
    const isOn = mainCamp && !mainCamp.userLock && mainCamp.status === 'ELIGIBLE'

    return c.json({
      ok: true, isOn,
      camp: mainCamp ? { name: mainCamp.name, status: mainCamp.status, dailyBudget: mainCamp.dailyBudget } : null,
      keywords,
      regions: REGIONS,
      cachedAt: new Date().toISOString(),
    })
  } catch(e: any) { return c.json({ ok:false, error: e.message }, 500) }
})

// ── /api/bid ──────────────────────────────────────────────────────────────────
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

// ── /api/cache ────────────────────────────────────────────────────────────────
app.delete('/api/cache', (c) => {
  Object.keys(cache).forEach(k => delete cache[k])
  return c.json({ ok:true })
})

app.get('/', (c) => c.html(PAGE))
export default app

// ══════════════════════════════════════════════════════════════════════════════
const PAGE = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>파워링크 대시보드</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
<style>
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap');
*{font-family:'Noto Sans KR',sans-serif;box-sizing:border-box;margin:0;padding:0}
body{background:#0a0d14;color:#e2e8f0;min-height:100vh}
.card{background:#131825;border:1px solid #1e2a3a;border-radius:14px}
.pill{display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600}
.badge-on{background:#0a2e1a;color:#03C75A;border:1px solid #03C75A50}
.badge-off{background:#2e0a0a;color:#fc8181;border:1px solid #fc818150}
.badge-wait{background:#2a2200;color:#f6e05e;border:1px solid #f6e05e50}
.kw-row{border-bottom:1px solid #1a2235;transition:.12s}
.kw-row:hover{background:#181f2e}
.kw-row:last-child{border-bottom:none}
.zero{color:#334155}
.spin{animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.toast{position:fixed;bottom:20px;right:20px;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:500;opacity:0;transition:opacity .3s;z-index:999;pointer-events:none}
.region-chip{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;background:#0d1e30;color:#5ba3d9;border:1px solid #1a3a5c}
.region-chip-ne{background:#0d1e30;color:#63b3ed;border:1px solid #1e3a5c}
.region-chip-sw{background:#1a1030;color:#b794f4;border:1px solid #3a1e5c}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:#0a0d14}
::-webkit-scrollbar-thumb{background:#2d3748;border-radius:2px}
</style>
</head>
<body>

<!-- 로딩 -->
<div id="loading" style="position:fixed;inset:0;background:#0a0d14;display:flex;align-items:center;justify-content:center;z-index:100;flex-direction:column;gap:14px">
  <div style="width:36px;height:36px;border:3px solid #1e2a3a;border-top-color:#03C75A;border-radius:50%" class="spin"></div>
  <p style="color:#4a5568;font-size:13px">광고 데이터 불러오는 중...</p>
</div>
<div id="toast" class="toast"></div>

<!-- NAV -->
<nav style="background:#0d1020;border-bottom:1px solid #1a2235;position:sticky;top:0;z-index:50">
  <div style="max-width:1280px;margin:0 auto;padding:0 20px;height:50px;display:flex;align-items:center;justify-content:space-between">
    <div style="display:flex;align-items:center;gap:10px">
      <span style="color:#03C75A;font-size:16px"><i class="fas fa-bolt"></i></span>
      <span style="font-size:15px;font-weight:700">파워링크 대시보드</span>
      <span id="camp-badge" class="pill badge-off" style="margin-left:6px"><i class="fas fa-circle" style="font-size:7px"></i>확인중</span>
    </div>
    <div style="display:flex;align-items:center;gap:10px">
      <span id="last-update" style="font-size:11px;color:#334155"></span>
      <span id="cache-label" style="font-size:10px;color:#1e3a4a;background:#0d1a24;border:1px solid #1a3040;padding:2px 8px;border-radius:6px">캐시 12h</span>
      <button onclick="hardRefresh()" style="background:#131825;border:1px solid #1e2a3a;color:#94a3b8;padding:5px 12px;border-radius:8px;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px">
        <i class="fas fa-sync-alt" id="refresh-icon"></i> 새로고침
      </button>
    </div>
  </div>
</nav>

<main style="max-width:1280px;margin:0 auto;padding:20px">

  <!-- KPI 4개 -->
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px">
    <div class="card" style="padding:18px 20px">
      <div style="font-size:11px;color:#4a5568;margin-bottom:8px;font-weight:500">광고 상태</div>
      <div id="k-status" style="font-size:22px;font-weight:700;color:#fc8181">OFF</div>
      <div id="k-budget" style="font-size:11px;color:#334155;margin-top:5px">—</div>
    </div>
    <div class="card" style="padding:18px 20px">
      <div style="font-size:11px;color:#4a5568;margin-bottom:8px;font-weight:500">운영 키워드</div>
      <div id="k-active" style="font-size:22px;font-weight:700;color:#03C75A">—</div>
      <div style="font-size:11px;color:#334155;margin-top:5px">15개 지역 × 전체</div>
    </div>
    <div class="card" style="padding:18px 20px">
      <div style="font-size:11px;color:#4a5568;margin-bottom:8px;font-weight:500">30일 실제 비용</div>
      <div id="k-cost" style="font-size:22px;font-weight:700;color:#f6e05e">—</div>
      <div id="k-cost-sub" style="font-size:11px;color:#334155;margin-top:5px">광고 집행 후 표시</div>
    </div>
    <div class="card" style="padding:18px 20px">
      <div style="font-size:11px;color:#4a5568;margin-bottom:8px;font-weight:500">30일 클릭 · CPC</div>
      <div id="k-clk" style="font-size:22px;font-weight:700;color:#63b3ed">—</div>
      <div id="k-acpc" style="font-size:11px;color:#334155;margin-top:5px">평균 CPC —</div>
    </div>
  </div>

  <!-- 메인 레이아웃: 2컬럼 -->
  <div style="display:grid;grid-template-columns:1fr 340px;gap:16px;align-items:start">

    <!-- 왼쪽: 지역 헤더 + 키워드 테이블 -->
    <div style="display:flex;flex-direction:column;gap:14px">

      <!-- 지역 헤더 박스 -->
      <div class="card" style="padding:18px 20px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
          <i class="fas fa-map-marker-alt" style="color:#f6ad55"></i>
          <span style="font-size:14px;font-weight:700;color:#e2e8f0">타겟 지역 15개</span>
          <span style="font-size:11px;color:#334155;margin-left:4px">— 아래 모든 키워드가 이 지역 전체에 노출됩니다</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span style="font-size:11px;color:#5ba3d9;font-weight:600;min-width:38px">동북권</span>
            <div id="chips-ne" style="display:flex;flex-wrap:wrap;gap:4px"></div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span style="font-size:11px;color:#b794f4;font-weight:600;min-width:38px">서남권</span>
            <div id="chips-sw" style="display:flex;flex-wrap:wrap;gap:4px"></div>
          </div>
        </div>
      </div>

      <!-- 키워드 테이블 -->
      <div class="card" style="padding:18px 20px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <h2 style="font-size:14px;font-weight:700;color:#e2e8f0">
            <i class="fas fa-key" style="color:#03C75A;margin-right:8px"></i>키워드별 실적
            <span style="font-size:11px;font-weight:400;color:#334155;margin-left:6px">30일 실제 비용 기준</span>
          </h2>
          <span id="kw-count-badge" style="font-size:11px;color:#4a5568;background:#0d1020;border:1px solid #1e2a3a;padding:2px 10px;border-radius:12px"></span>
        </div>

        <!-- 데이터 없음 안내 -->
        <div id="no-data-box" style="display:none;background:#0d1a24;border:1px solid #1a3a5c;border-radius:10px;padding:12px 16px;margin-bottom:14px">
          <div style="color:#63b3ed;font-size:13px;font-weight:600;margin-bottom:5px">
            <i class="fas fa-info-circle"></i> 아직 실적 데이터 없음
          </div>
          <div style="color:#4a5568;font-size:12px;line-height:1.7">
            광고가 <strong style="color:#fc8181">PAUSED</strong> 상태라 노출·클릭·비용 데이터가 없습니다.<br>
            7시 광고 ON 이후 데이터가 쌓이면 자동 반영됩니다.
            <span style="color:#1e3a4a">&nbsp;(stats 12시간 캐시)</span>
          </div>
        </div>

        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="border-bottom:1px solid #1a2235">
                <th style="padding:8px 10px;text-align:left;color:#334155;font-weight:600;font-size:11px">키워드</th>
                <th style="padding:8px 10px;text-align:center;color:#334155;font-weight:600;font-size:11px">상태</th>
                <th style="padding:8px 10px;text-align:right;color:#334155;font-weight:600;font-size:11px">입찰가</th>
                <th style="padding:8px 10px;text-align:right;color:#334155;font-weight:600;font-size:11px">노출</th>
                <th style="padding:8px 10px;text-align:right;color:#334155;font-weight:600;font-size:11px">클릭</th>
                <th style="padding:8px 10px;text-align:right;color:#334155;font-weight:600;font-size:11px">CTR</th>
                <th style="padding:8px 8px;text-align:right;color:#334155;font-weight:600;font-size:11px;white-space:nowrap">실제 비용</th>
                <th style="padding:8px 10px;text-align:right;color:#334155;font-weight:600;font-size:11px">CPC</th>
              </tr>
            </thead>
            <tbody id="kw-body">
              <tr><td colspan="8" style="text-align:center;padding:40px;color:#334155">
                <i class="fas fa-spinner fa-spin"></i>
              </td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 오른쪽 패널 -->
    <div style="display:flex;flex-direction:column;gap:14px">

      <!-- 스케줄 카드 -->
      <div class="card" style="padding:18px 20px">
        <div style="font-size:11px;color:#4a5568;margin-bottom:12px;font-weight:600">운영 스케줄</div>

        <!-- 타임바 -->
        <div style="position:relative;height:22px;background:#0d1020;border-radius:6px;overflow:hidden;margin-bottom:4px">
          <div style="position:absolute;height:100%;left:4.17%;width:25%;background:#2e0a0a;display:flex;align-items:center;justify-content:center;font-size:9px;color:#fc8181;font-weight:700">OFF</div>
          <div style="position:absolute;height:100%;left:29.17%;width:70.83%;background:#0a2410;display:flex;align-items:center;justify-content:center;font-size:9px;color:#03C75A;font-weight:700">ON 07시~01시</div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:#1e2a3a;margin-bottom:14px">
          <span>0</span><span>6</span><span>12</span><span>18</span><span>24</span>
        </div>

        <!-- 다음 실행 -->
        <div style="background:#0d1020;border:1px solid #1a2235;border-radius:10px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:11px;color:#4a5568">다음 실행</div>
          <div style="text-align:right">
            <div id="next-run" style="font-size:14px;font-weight:700;color:#e2e8f0">—</div>
            <div id="next-desc" style="font-size:10px;color:#334155;margin-top:2px">—</div>
          </div>
        </div>
      </div>

      <!-- 입찰가 수정 -->
      <div class="card" style="padding:18px 20px">
        <div style="font-size:11px;color:#4a5568;margin-bottom:12px;font-weight:600">
          <i class="fas fa-sliders-h" style="color:#63b3ed;margin-right:4px"></i>입찰가 수정
        </div>
        <select id="bid-sel" style="width:100%;background:#0d1020;border:1px solid #1e2a3a;color:#e2e8f0;padding:8px 10px;border-radius:8px;font-size:13px;margin-bottom:8px;outline:none">
          <option value="">키워드 선택...</option>
        </select>
        <div style="display:flex;gap:6px">
          <input id="bid-val" type="number" min="70" step="10" placeholder="입찰가 (원)"
            style="flex:1;background:#0d1020;border:1px solid #1e2a3a;color:#e2e8f0;padding:8px 10px;border-radius:8px;font-size:13px;outline:none"/>
          <button onclick="applyBid()" style="background:#03C75A;color:#fff;border:none;padding:8px 14px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap">적용</button>
        </div>
        <div id="bid-info" style="font-size:11px;color:#334155;margin-top:6px"></div>
      </div>

      <!-- 크레딧 절약 현황 -->
      <div class="card" style="padding:16px 20px">
        <div style="font-size:11px;color:#4a5568;margin-bottom:10px;font-weight:600">
          <i class="fas fa-shield-alt" style="color:#03C75A;margin-right:4px"></i>크레딧 절약 구조
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:12px;color:#4a5568">API 호출 (새로고침당)</span>
            <span style="font-size:12px;font-weight:700;color:#03C75A">최대 5회</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:12px;color:#4a5568">일반 API 캐시</span>
            <span style="font-size:12px;font-weight:700;color:#63b3ed">1시간</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:12px;color:#4a5568">stats API 캐시</span>
            <span style="font-size:12px;font-weight:700;color:#f6e05e">12시간</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:12px;color:#4a5568">새벽 OFF (01~07시)</span>
            <span style="font-size:12px;font-weight:700;color:#fc8181">6h 비용 0원</span>
          </div>
        </div>
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid #1a2235">
          <div id="cache-age" style="font-size:10px;color:#1e3040;text-align:center">—</div>
        </div>
      </div>

    </div>
  </div>
</main>

<script>
let D = null

document.addEventListener('DOMContentLoaded', () => {
  loadData()
  updateNextRun()
  setInterval(updateNextRun, 60000)
  renderRegionChips()
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
  renderTable()
  renderBidSelect()
  const now = new Date(D.cachedAt)
  document.getElementById('last-update').textContent =
    now.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}) + ' 기준'
  // 캐시 경과 표시
  const ageMins = Math.floor((Date.now() - new Date(D.cachedAt).getTime()) / 60000)
  document.getElementById('cache-age').textContent =
    ageMins < 1 ? '방금 갱신됨' : ageMins + '분 전 캐시'
}

function renderKPI() {
  const kws = D.keywords || []
  const totalCost = kws.reduce((s, k) => s + k.cost, 0)
  const totalClk  = kws.reduce((s, k) => s + k.clk, 0)
  const acpc = totalClk > 0 ? Math.round(totalCost / totalClk) : 0
  const hasData = totalCost > 0 || totalClk > 0

  const isOn = D.isOn
  document.getElementById('k-status').textContent  = isOn ? '광고 ON' : '광고 OFF'
  document.getElementById('k-status').style.color  = isOn ? '#03C75A' : '#fc8181'
  document.getElementById('k-budget').textContent  =
    D.camp ? '일예산 ' + (D.camp.dailyBudget||0).toLocaleString() + '원' : '—'

  document.getElementById('k-active').textContent  = kws.length + '개'
  document.getElementById('k-cost').textContent    = hasData ? totalCost.toLocaleString() + '원' : '—'
  document.getElementById('k-cost-sub').textContent = hasData ? '30일 누적 · VAT 포함' : '광고 집행 후 표시'
  document.getElementById('k-clk').textContent     = hasData ? totalClk.toLocaleString() + '회' : '—'
  document.getElementById('k-acpc').textContent    = hasData
    ? '평균 CPC ' + acpc.toLocaleString() + '원'
    : '집행 후 표시'

  if (!hasData) document.getElementById('no-data-box').style.display = 'block'
  else          document.getElementById('no-data-box').style.display = 'none'
}

function renderStatus() {
  const badge = document.getElementById('camp-badge')
  if (D.isOn) {
    badge.className = 'pill badge-on'
    badge.innerHTML = '<i class="fas fa-circle" style="font-size:7px"></i> ON'
  } else {
    badge.className = 'pill badge-off'
    badge.innerHTML = '<i class="fas fa-circle" style="font-size:7px"></i> OFF'
  }
}

function renderTable() {
  const kws = D.keywords || []
  document.getElementById('kw-count-badge').textContent = kws.length + '개 키워드'
  const tbody = document.getElementById('kw-body')
  if (!kws.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:#334155">키워드 없음</td></tr>'
    return
  }

  // 비용 내림차순 정렬 (비용 있는 것 우선, 나머지 입찰가 내림차순)
  const sorted = [...kws].sort((a, b) => {
    if (b.cost !== a.cost) return b.cost - a.cost
    return b.bidAmt - a.bidAmt
  })

  tbody.innerHTML = sorted.map(k => {
    const st = k.status === 'ELIGIBLE'
      ? '<span class="pill badge-on">운영</span>'
      : k.status === 'UNDER_REVIEW'
        ? '<span class="pill badge-wait">심사중</span>'
        : '<span class="pill badge-off">정지</span>'

    const has = k.imp > 0 || k.cost > 0
    const imp  = has ? k.imp.toLocaleString()               : '<span class="zero">—</span>'
    const clk  = has ? k.clk.toLocaleString()               : '<span class="zero">—</span>'
    const ctr  = has ? k.ctr + '%'                          : '<span class="zero">—</span>'
    const cost = has
      ? '<strong style="color:' + (k.cost > 0 ? '#f6e05e' : '#718096') + '">'
        + k.cost.toLocaleString() + '원</strong>'
      : '<span class="zero">—</span>'
    const cpc  = has && k.acpc > 0
      ? k.acpc.toLocaleString() + '원'
      : '<span class="zero">—</span>'

    return '<tr class="kw-row">' +
      '<td style="padding:10px 10px;font-weight:600;color:#e2e8f0;white-space:nowrap">' + k.keyword + '</td>' +
      '<td style="padding:10px;text-align:center">' + st + '</td>' +
      '<td style="padding:10px;text-align:right;color:#94a3b8;font-size:12px">' + k.bidAmt.toLocaleString() + '원</td>' +
      '<td style="padding:10px;text-align:right;font-size:12px">' + imp  + '</td>' +
      '<td style="padding:10px;text-align:right;font-size:12px">' + clk  + '</td>' +
      '<td style="padding:10px;text-align:right;font-size:12px">' + ctr  + '</td>' +
      '<td style="padding:10px 8px;text-align:right;font-size:12px">' + cost + '</td>' +
      '<td style="padding:10px;text-align:right;font-size:12px">' + cpc  + '</td>' +
    '</tr>'
  }).join('')
}

function renderBidSelect() {
  const sel = document.getElementById('bid-sel')
  const kws = D.keywords || []
  sel.innerHTML = '<option value="">키워드 선택...</option>' +
    kws.map(k =>
      '<option value="' + k.id + '" data-ag="' + k.agId + '" data-bid="' + k.bidAmt + '">'
      + k.keyword + ' (' + k.bidAmt.toLocaleString() + '원)</option>'
    ).join('')
  sel.onchange = () => {
    const opt = sel.selectedOptions[0]
    if (!opt.value) { document.getElementById('bid-info').textContent = ''; return }
    document.getElementById('bid-val').value = opt.dataset.bid
    document.getElementById('bid-info').textContent =
      '현재 입찰가: ' + Number(opt.dataset.bid).toLocaleString() + '원'
  }
}

async function applyBid() {
  const sel = document.getElementById('bid-sel')
  const val = parseInt(document.getElementById('bid-val').value)
  if (!sel.value) { toast('키워드를 선택하세요', 'err'); return }
  if (!val || val < 70) { toast('최소 70원 이상 입력', 'err'); return }
  const kw = (D.keywords || []).find(k => k.id === sel.value)
  if (!kw) return
  toast('입찰가 적용 중...', 'info')
  try {
    const r = await fetch('/api/bid', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ nccKeywordId: kw.id, nccAdgroupId: kw.agId, bidAmt: val })
    })
    const d = await r.json()
    if (d.ok) {
      toast('✅ ' + kw.keyword + ' → ' + val.toLocaleString() + '원 적용', 'ok')
      await fetch('/api/cache', { method:'DELETE' })
      await loadData()
    } else toast('실패: ' + d.error, 'err')
  } catch(e) { toast('오류: ' + e.message, 'err') }
}

function renderRegionChips() {
  const NE = ['남양주','구리','강동','하남','중랑','동대문','노원','강북','성북']
  const SW = ['금천','관악','구로','영등포','광명','안양']
  document.getElementById('chips-ne').innerHTML =
    NE.map(r => '<span class="region-chip region-chip-ne">' + r + '</span>').join('')
  document.getElementById('chips-sw').innerHTML =
    SW.map(r => '<span class="region-chip region-chip-sw">' + r + '</span>').join('')
}

function updateNextRun() {
  const h = new Date().getHours()
  let nextH, desc
  if (h < 1)      { nextH = 1;  desc = '새벽 1시 광고 OFF' }
  else if (h < 7) { nextH = 7;  desc = '아침 7시 광고 ON + 입찰 최적화' }
  else            { nextH = 25; desc = '내일 새벽 1시 광고 OFF' }
  const now = new Date(), target = new Date(now)
  if (nextH === 25) { target.setDate(target.getDate()+1); target.setHours(1,0,0,0) }
  else target.setHours(nextH,0,0,0)
  const diff = Math.max(0, target - now)
  const hh = Math.floor(diff/3600000), mm = Math.floor((diff%3600000)/60000)
  document.getElementById('next-run').textContent  = hh + '시간 ' + mm + '분 후'
  document.getElementById('next-desc').textContent = desc
}

function toast(msg, t) {
  const el = document.getElementById('toast')
  el.style.background = t==='ok'?'#0a2410':t==='err'?'#2e0a0a':'#0d1a24'
  el.style.border = '1px solid ' + (t==='ok'?'#03C75A50':t==='err'?'#fc818150':'#63b3ed50')
  el.style.color  = t==='ok'?'#03C75A':t==='err'?'#fc8181':'#63b3ed'
  el.textContent = msg
  el.style.opacity = '1'
  setTimeout(() => el.style.opacity = '0', 3000)
}
</script>
</body>
</html>`
