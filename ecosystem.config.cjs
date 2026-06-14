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
    // cron: 매일 01:00 KST 실행
    {
      name: 'ad-off-01',
      script: 'python3',
      args: '/home/user/webapp/scheduler.py off',
      cron_restart: '0 1 * * *',   // 매일 01:00 (서버 시각)
      watch: false,
      autorestart: false,
      instances: 1,
      exec_mode: 'fork',
      out_file: '/home/user/webapp/data/ad-off.log',
      error_file: '/home/user/webapp/data/ad-off-err.log'
    },

    // ── 3. 아침 7시 광고 ON + 스마트 입찰 최적화 ─────────────────────
    // cron: 매일 07:00 KST 실행
    {
      name: 'ad-on-07',
      script: 'python3',
      args: '/home/user/webapp/scheduler.py on',
      cron_restart: '0 7 * * *',   // 매일 07:00 (서버 시각)
      watch: false,
      autorestart: false,
      instances: 1,
      exec_mode: 'fork',
      out_file: '/home/user/webapp/data/ad-on.log',
      error_file: '/home/user/webapp/data/ad-on-err.log'
    }
  ]
}
