#!/bin/sh
# minis-qqbot 进程管理
#   ./svc.sh start     后台启动（已有实例则提示）
#   ./svc.sh stop      停止（按 PID 精确清理，iSH 里 pkill -f 杀不干净）
#   ./svc.sh restart   重启
#   ./svc.sh status    状态
#   ./svc.sh logs      跟踪日志
#   ./svc.sh watch     守护循环：进程挂了自动拉起（前台运行，建议 nohup 起来）
cd "$(dirname "$0")" || exit 1
PIDF=.run.pid
LOG=qqbot.log

alive() {
  [ -f "$PIDF" ] || return 1
  p=$(cat "$PIDF" 2>/dev/null)
  [ -n "$p" ] && kill -0 "$p" 2>/dev/null
}

kill_all() {
  # 先按 pidfile，再扫全部 node run.mjs
  [ -f "$PIDF" ] && kill -9 "$(cat $PIDF)" 2>/dev/null
  ps aux 2>/dev/null | grep '[r]un\.mjs' | awk '{print $1}' | while read -r p; do
    kill -9 "$p" 2>/dev/null
  done
  sleep 1
  rm -f "$PIDF"
}

case "$1" in
  start)
    if alive; then echo "已在运行 pid=$(cat $PIDF)"; exit 0; fi
    kill_all
    nohup node run.mjs > /dev/null 2>&1 &   # 日志由 run.mjs 自己写 qqbot.log，这里不要再重定向进去
    sleep 3
    if alive; then echo "✅ 已启动 pid=$(cat $PIDF)"; else echo "❌ 启动失败，看 $LOG"; tail -5 "$LOG"; exit 1; fi
    ;;
  stop)
    kill_all
    echo "已停止"
    ;;
  restart)
    kill_all
    nohup node run.mjs > /dev/null 2>&1 &   # 日志由 run.mjs 自己写 qqbot.log，这里不要再重定向进去
    sleep 3
    alive && echo "✅ 已重启 pid=$(cat $PIDF)" || echo "❌ 重启失败"
    ;;
  status)
    if alive; then
      echo "运行中 pid=$(cat $PIDF)"
      echo "最近事件:"; grep -E '\[in\]|\[out\]|\[group\]' "$LOG" 2>/dev/null | tail -5
    else
      echo "未运行"
    fi
    ;;
  logs)
    tail -f "$LOG"
    ;;
  watch)
    echo "守护模式启动（Ctrl-C 退出）"
    while :; do
      if ! alive; then
        echo "$(date) 进程不在，拉起…"
        kill_all >/dev/null 2>&1
        nohup node run.mjs > /dev/null 2>&1 &   # 日志由 run.mjs 自己写 qqbot.log，这里不要再重定向进去
        sleep 5
      fi
      sleep 15
    done
    ;;
  *)
    echo "用法: $0 {start|stop|restart|status|logs|watch}"
    exit 1
    ;;
esac
