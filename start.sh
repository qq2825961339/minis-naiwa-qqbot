#!/bin/sh
# start.sh —— 一键启动奶蛙
#
#   ./start.sh            正常启动（缺依赖自动装、缺凭证自动引导扫码、启动后进保活）
#   ./start.sh --no-keep  只启动服务，不保活
#   ./start.sh --force-qr 强制重新扫码
#
# 设计目标：新设备 clone 下来，跑这一条就能用。
cd "$(dirname "$0")" || exit 1
LOGIN_MODE=${LOGIN:-auto}

say()  { printf '\033[36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✅ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m⚠️  %s\033[0m\n' "$*"; }
err()  { printf '\033[31m❌ %s\033[0m\n' "$*"; }

for a in "$@"; do
  case "$a" in
    --no-keep) KEEP=0 ;;
    --force-qr) LOGIN_MODE=qr; FORCE_QR=1 ;;
  esac
done
[ -z "$KEEP" ] && KEEP=1

# ---------- 1. 环境检查 ----------
say "[1/4] 检查环境"
command -v node >/dev/null 2>&1 || { err "未安装 node，请先安装 Node.js >= 18"; exit 1; }
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 18 ] || { err "Node 版本 $NODE_MAJOR 太低，需要 >= 18"; exit 1; }
ok "Node $(node -v)"
command -v minis-model-use >/dev/null 2>&1 || warn "找不到 minis-model-use，需在 Minis App 内运行"

# ---------- 2. 依赖 ----------
say "[2/4] 检查依赖"
if [ -d node_modules/@tencent-connect ] && [ -d node_modules/ws ]; then
  ok "依赖已内置，无需安装"
else
  warn "依赖缺失，正在安装（需要联网，约 1 分钟）…"
  command -v npm >/dev/null 2>&1 || { err "找不到 npm，无法安装依赖"; exit 1; }
  npm install --no-bin-links --ignore-scripts --no-audit --no-fund || { err "依赖安装失败，检查网络后重试"; exit 1; }
  ok "依赖安装完成"
fi

# ---------- 2.5 模型 ----------
say "[2.5] 检查模型"
MODEL_N=$(minis-model-use list --all 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log((JSON.parse(s).data.models||[]).length)}catch(e){console.log(0)}})" 2>/dev/null)
if [ "$MODEL_N" = "0" ] || [ -z "$MODEL_N" ]; then
  warn "没有检测到可调用的模型，奶蛙会无法回复"
  echo "   去这里添加：minis://settings/model-groups"
  echo "   位置：设置 → 模型分组 → Minis 运行时可调用的模型"
  echo "   建议选支持图片输入的（能看 QQ 里发的图）"
  echo "   加完重新运行 ./start.sh"
  echo
  printf "   继续启动？（y/N）"
  read -r ans
  case "$ans" in y|Y) ;; *) exit 1 ;; esac
else
  ok "可用模型 $MODEL_N 个"
fi

# ---------- 3. 凭证 ----------
say "[3/4] 检查凭证"

creds_ok() {
  [ -f credentials.json ] || return 1
  node -e "
    const c=require('./credentials.json');
    const b=c.bots&&c.bots[0];
    process.exit(b&&b.appId&&b.appSecret&&String(b.appSecret).length>=16?0:1);
  " 2>/dev/null
}

verify_online() {
  [ "$LOGIN_MODE" = "env" ] || [ "$LOGIN_MODE" = "auto" ] || return 1
  timeout 30 node run.mjs --once >/dev/null 2>&1
}

NEED_QR=0
if [ -n "$FORCE_QR" ]; then
  NEED_QR=1
elif ! creds_ok; then
  warn "没有可用凭证，需要扫码绑定"
  NEED_QR=1
elif ! verify_online; then
  # 文件在但连不上：备份旧凭证，重新扫码
  TS=$(date +%Y%m%d-%H%M%S)
  mv credentials.json "credentials.json.bak-$TS" 2>/dev/null
  warn "凭证已失效（可能是 AppSecret 被重置），旧凭证已备份为 credentials.json.bak-$TS"
  NEED_QR=1
fi

if [ "$NEED_QR" = "1" ]; then
  say "请用手机 QQ 扫码绑定机器人"
  echo
  node bind.mjs --png --timeout 600 || { err "扫码失败"; exit 1; }
  ok "凭证已更新"
else
  ok "凭证有效"
fi

# ---------- 4. 启动 ----------
say "[4/4] 启动服务"
[ -f .run.pid ] && kill -9 "$(cat .run.pid)" 2>/dev/null
ps -o pid,args 2>/dev/null | grep '[r]un\.mjs' | awk '$2!="PID"{print $1}' | while read -r p; do kill -9 "$p" 2>/dev/null; done
sleep 1

if [ "$KEEP" = "0" ]; then
  ok "启动完成（未开保活）"
  echo "   前台运行：LOGIN=$LOGIN_MODE node run.mjs"
  echo "   后台运行：LOGIN=$LOGIN_MODE nohup node run.mjs > /dev/null 2>&1 &"
  exit 0
fi

ok "启动并进入保活（结束请按 Ctrl-C）"
echo "   日志：tail -f qqbot.log"
exec env LOGIN="$LOGIN_MODE" ./keepalive.sh run forever
