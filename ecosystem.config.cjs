module.exports = {
  apps: [
    // ── 1. 대시보드 웹서버 ─────────────────────────────────────────────
    {
      name: 'naver-ad-dashboard',
      script: 'npx',
      args: 'wrangler pages dev dist --ip 0.0.0.0 --port 3000 --compatibility-date=2026-05-03',
      env: { NODE_ENV: 'development' },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    },

    // ── 2. 새벽 1시 광고 OFF (KST 01:00 = UTC 16:00) ─────────────────
    // cron_restart: PM2가 이 시각에 프로세스를 재시작 = 스크립트 실행
    // autorestart:false + min_uptime 높게 → 정상 종료 후 재시작 안 함
    {
      name: 'ad-off-01',
      script: 'python3',
      args: '/home/user/webapp/scheduler.py off',
      cron_restart: '0 16 * * *',
      watch: false,
      autorestart: false,
      min_uptime: '1h',        // 1시간 이내 종료는 재시작 안 함
      instances: 1,
      exec_mode: 'fork',
      out_file: '/home/user/webapp/data/ad-off.log',
      error_file: '/home/user/webapp/data/ad-off-err.log'
    },

    // ── 3. 아침 7시 광고 ON (KST 07:00 = UTC 22:00) ──────────────────
    {
      name: 'ad-on-07',
      script: 'python3',
      args: '/home/user/webapp/scheduler.py on',
      cron_restart: '0 22 * * *',
      watch: false,
      autorestart: false,
      min_uptime: '1h',
      instances: 1,
      exec_mode: 'fork',
      out_file: '/home/user/webapp/data/ad-on.log',
      error_file: '/home/user/webapp/data/ad-on-err.log'
    },

    // ── 4. 2시간 점검 (KST 09,11,15,17,19,21,23 = UTC 0,2,6,8,10,12,14) ──
    // ※ 13시(UTC 04시)는 rank_check가 담당하므로 제외
    {
      name: 'ad-check-2h',
      script: 'python3',
      args: '/home/user/webapp/scheduler.py check',
      cron_restart: '0 0,2,6,8,10,12,14 * * *',
      watch: false,
      autorestart: false,
      min_uptime: '1h',
      instances: 1,
      exec_mode: 'fork',
      out_file: '/home/user/webapp/data/ad-check.log',
      error_file: '/home/user/webapp/data/ad-check-err.log'
    },

    // ── 5. 점심 13시 순위 점검 (KST 13:00 = UTC 04:00) ─────────────────
    // 노출0/클릭0 키워드 → KW_MAX_BID까지 대폭 상향 + Playwright 1페이지 확인
    {
      name: 'ad-rank-13',
      script: 'python3',
      args: '/home/user/webapp/scheduler.py rank_check',
      cron_restart: '0 4 * * *',
      watch: false,
      autorestart: false,
      min_uptime: '1h',
      instances: 1,
      exec_mode: 'fork',
      out_file: '/home/user/webapp/data/ad-rank.log',
      error_file: '/home/user/webapp/data/ad-rank-err.log'
    }
  ]
}
