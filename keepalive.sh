#!/bin/sh
# keepalive.sh —— 利用「Minis 正在执行的一轮 Agent 任务」保活 QQ 机器人
#
# 原理：把 run.mjs 作为本趟任务的前台子进程持续运行，
#       这一轮 Agent 任务不结束，Minis 的 enhanced/locationTracking 就会继续
#       给 App 维持后台时间片，node 进程随之存活。
#
#   ./keepalive.sh             永久运行，不设时限（默认）
#   ./keepalive.sh run 2h      到时限后退出（可选，一般不用）
#   ./keepalive.sh run forever 同上，永久
cd "$(dirname "$0")" || exit 1

SPEC=${2:-forever}    # forever = 永不主动退出
LOG=qqbot.log

case "$SPEC" in
  forever|0|"") SECS=0 ;;
  *h) SECS=$(( ${SPEC%h} * 3600 )) ;;
  *m) SECS=$(( ${SPEC%m} * 60 )) ;;
  *)  SECS=$SPEC ;;
esac

if [ "$SECS" -gt 0 ] 2>/dev/null; then
  echo "[keepalive] 开始 $(date -u +%FT%TZ)，本轮时限 ${SECS}s"
  END=$(( $(date +%s) + SECS ))
else
  echo "[keepalive] 开始 $(date -u +%FT%TZ)，永久运行（不自动退出）"
  END=0
fi

# 清理旧实例（按 pidfile + 进程表双保险）
[ -f .run.pid ] && kill -9 "$(cat .run.pid)" 2>/dev/null
ps -o pid,args 2>/dev/null | grep '[r]un\.mjs' | awk '$2!="PID"{print $1}' | while read -r p; do
  kill -9 "$p" 2>/dev/null
done
sleep 1

RESTARTS=0
while :; do
  if [ "$END" -gt 0 ] && [ "$(date +%s)" -ge "$END" ]; then
    echo "[keepalive] 到达时限，退出"
    exit 0
  fi

  # 关键：stdout/stderr 全部重定向到文件，绝不能接手父 shell 的管道
  # （管道一断，console.log 就抛 EPIPE 把进程干掉）
  : >> "$LOG"
  # 登录方式：LOGIN=env 用环境变量，LOGIN=qr 用 credentials.json（默认自动）
  node run.mjs ${LOGIN:+--login $LOGIN} > /dev/null 2>>"$LOG" &
  CHILD=$!

  wait $CHILD 2>/dev/null
  RESTARTS=$((RESTARTS + 1))
  echo "[keepalive] $(date -u +%FT%TZ) run.mjs 退出，第 $RESTARTS 次重启，5s 后……"
  sleep 5
done
