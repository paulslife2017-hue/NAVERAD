#!/usr/bin/env python3
"""오늘 KST 13:00 1회 실행용 — 실행 후 자동 종료"""
import time, subprocess
from datetime import datetime, timezone, timedelta

now = datetime.now(timezone.utc)
target = now.replace(hour=4, minute=0, second=0, microsecond=0)
if now >= target:
    target += timedelta(days=1)

secs = int((target - now).total_seconds())
kst_str = (target + timedelta(hours=9)).strftime("%Y-%m-%d %H:%M KST")
print(f"[one-time] {secs}초 대기 후 실행 → {kst_str}", flush=True)

time.sleep(secs)
print("[one-time] KST 13:00 도달 — scheduler on 실행", flush=True)
subprocess.run(["python3", "/home/user/webapp/scheduler.py", "on"])
print("[one-time] 완료", flush=True)
