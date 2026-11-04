#!/bin/sh
# doctor.sh —— 体检：依赖 / 凭证 / 网络 / 服务 逐项检查
cd "$(dirname "$0")" || exit 1

pass=0; fail=0
chk() { # chk "名称" 0|1 "提示"
  if [ "$2" = "0" ]; then printf '\033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1));
  else printf '\033[31m✗\033[0m %s  \033[33m→ %s\033[0m\n' "$1" "$3"; fail=$((fail+1)); fi
}

echo "── 环境 ──"
command -v node >/dev/null 2>&1 && chk "Node 已安装（$(node -v)）" 0 || chk "Node 已安装" 1 "先装 Node >= 18"
[ -d node_modules/@tencent-connect ] && chk "依赖已安装" 0 || chk "依赖已安装" 1 "运行 npm install --no-bin-links --ignore-scripts"
command -v ffmpeg >/dev/null 2>&1 && chk "ffmpeg（GIF 转静态图）" 0 || chk "ffmpeg" 1 "apk add ffmpeg，不装的话 GIF 图看不了"

echo
echo "── 凭证 ──"
if [ -f credentials.json ]; then
  chk "credentials.json 存在" 0
  node -e "const b=require('./credentials.json').bots[0];process.exit(b&&b.appId&&b.appSecret?0:1)" 2>/dev/null \
    && chk "凭证字段完整" 0 || chk "凭证字段完整" 1 "重新扫码：node bind.mjs --png"
else
  chk "credentials.json" 1 "先扫码：node bind.mjs --png"
fi
[ -n "$QQBOT_APPID" ] && chk "环境变量 QQBOT_APPID" 0 || echo "· 环境变量 QQBOT_APPID 未设置（可选）"

echo
echo "── 模型 ──"
MODEL_N=$(minis-model-use list --all 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log((JSON.parse(s).data.models||[]).length)}catch(e){console.log(0)}})" 2>/dev/null)
if [ "$MODEL_N" != "0" ] && [ -n "$MODEL_N" ]; then
  chk "可调用模型 $MODEL_N 个" 0
else
  chk "可调用模型" 1 "设置 → 模型分组 → Minis 运行时可调用的模型  minis://settings/model-groups"
fi

echo
echo "── 连通性 ──"
timeout 20 node run.mjs --login qr --once >/dev/null 2>&1 \
  && chk "QQ 平台鉴权通过" 0 || chk "QQ 平台鉴权" 1 "凭证可能失效，重新扫码"

echo
echo "── 服务 ──"
if [ -f .run.pid ] && kill -0 "$(cat .run.pid)" 2>/dev/null; then
  chk "服务运行中（pid $(cat .run.pid)）" 0
else
  chk "服务运行中" 1 "运行 ./start.sh"
fi
grep -q '已上线' qqbot.log 2>/dev/null && chk "上次启动成功上线" 0 || chk "上线记录" 1 "看 qqbot.log"

echo
echo "通过 $pass 项，异常 $fail 项"
[ "$fail" = "0" ] && exit 0 || exit 1
