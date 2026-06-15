module.exports = {
  apps: [
    // ── 1. 대시보드 웹서버 ─────────────────────────────────────────────
    {
      name: 'naver-ad-dashboard',
      script: 'npx',
      args: 'wrangler pages dev dist --ip 0.0.0.0 --port 3000',
      env: { NODE_ENV: 'development' },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    },

    // ── 2. 새벽 1시 광고 OFF ───────────────────────────────────────────
    // KST 01:00 = UTC 16:00 (전날)
    {
      name: 'ad-off-01',
      script: 'python3',
      args: '/home/user/webapp/scheduler.py off',
      cron_restart: '0 16 * * *',   // UTC 16:00 = KST 01:00
      watch: false,
      autorestart: false,
      instances: 1,
      exec_mode: 'fork',
      out_file: '/home/user/webapp/data/ad-off.log',
      error_file: '/home/user/webapp/data/ad-off-err.log'
    },

    // ── 3. 아침 7시 광고 ON + 스마트 입찰 최적화 ─────────────────────
    // KST 07:00 = UTC 22:00 (전날)
    {
      name: 'ad-on-07',
      script: 'python3',
      args: '/home/user/webapp/scheduler.py on',
      cron_restart: '0 22 * * *',   // UTC 22:00 = KST 07:00
      watch: false,
      autorestart: false,
      instances: 1,
      exec_mode: 'fork',
      out_file: '/home/user/webapp/data/ad-on.log',
      error_file: '/home/user/webapp/data/ad-on-err.log'
    },

    // ── 4. 2시간 점검: 노출 확인 + 입찰가 자동 조정 ──────────────────
    // KST 09,11,13,15,17,19,21,23시 = UTC 00,02,04,06,08,10,12,14시
    // (07시 ON 이후 ~ 01시 OFF 직전까지, 짝수 홀수 교차 방지로 홀수 KST)
    {
      name: 'ad-check-2h',
      script: 'python3',
      args: '/home/user/webapp/scheduler.py check',
      cron_restart: '0 0,2,4,6,8,10,12,14 * * *',  // UTC → KST 09~23시 (2시간 간격)
      watch: false,
      autorestart: false,
      instances: 1,
      exec_mode: 'fork',
      out_file: '/home/user/webapp/data/ad-check.log',
      error_file: '/home/user/webapp/data/ad-check-err.log'
    }
  ]
}
