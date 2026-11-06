#!/bin/sh
# 一键启动：没凭证就自动出二维码等你扫，扫完直接起进程（）
# 一键启动：没凭证就自动出二维码等你扫，扫完直接起进程

need_bind() {
  if [ ! -f credentials.json ]; then return 0; fi
  node run.mjs --once >/dev/null 2>&1 || return 0
  return 1
}

if need_bind; then
  echo "🔑 没有可用凭证，开始扫码绑定（本轮会一直等着你扫码）"
  node bind.mjs --png || { echo "❌ 绑定失败"; exit 1; }
  echo "✅ 绑定完成，开始启动"
fi

# 确保指令面板存在
if [ -f scripts/ensure-panels.mjs ]; then
  node scripts/ensure-panels.mjs || echo "⚠️ 面板配置失败，可稍后手动执行：node scripts/ensure-panels.mjs"
fi

echo "🚀 启动奶蛙…"
rm -f .run.pid
setsid sh -c 'node run.mjs > /dev/null 2>&1' < /dev/null > /dev/null 2>&1 &
sleep 16
echo "进程数: $(ps aux | grep -c '[r]un.mjs')"
