#!/bin/sh
# 一键启动：没凭证就自动出二维码等你扫，扫完自动上线并保活
cd "$(dirname "$0")" || exit 1

need_bind() {
  if [ ! -f credentials.json ]; then return 0; fi
  # 有凭证也验一下，失效同样要重扫
  node run.mjs --once >/dev/null 2>&1 || return 0
  return 1
}

if need_bind; then
  echo "🔑 没有可用凭证，开始扫码绑定（本轮会一直等着你扫码）"
  node bind.mjs --png || { echo "❌ 绑定失败"; exit 1; }
  echo "✅ 绑定完成，开始启动"
fi

echo "🚀 启动奶蛙…"
exec ./keepalive.sh run forever
