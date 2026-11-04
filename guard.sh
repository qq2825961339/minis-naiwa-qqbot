#!/bin/sh
# guard.sh —— minis-qqbot 技能变更守卫
#
# 用 .manifest.sha256 记录技能所有源文件的指纹。任何改动都会让 verify 失败。
# 规则：改动此技能前必须先征得用户同意，然后由用户显式执行 `./guard.sh approve`。
#
#   ./guard.sh verify      校验（默认）：列出被改动/新增/删除的文件，有差异则退出码 1
#   ./guard.sh approve     用户同意后重新登记指纹（会打印变更摘要）
#   ./guard.sh diff        显示具体改了什么
cd "$(dirname "$0")" || exit 1
MAN=.manifest.sha256

# 纳入守护的文件：源码与文档（不含 logs / media / node_modules / 凭据 / 运行态）
files() {
  find . -type f \
    ! -path './node_modules/*' ! -path './media/*' ! -path './inbox/*' \
    ! -name 'qqbot.log*' ! -name '.state.json*' ! -name '.intents.json' \
    ! -name '.run.pid' ! -name 'credentials.json' ! -name 'groups.json' \
    ! -name '.manifest.sha256' ! -name '.manifest.old' ! -name 'bind.html' \
    ! -name 'qr.png' ! -name '.bind.out' ! -name '*.tmp' \
    ! -name '.tmp-input.json' ! -name '.probe*.mjs' ! -name '.whoami.mjs' \
    ! -name 'keepalive.log' ! -name 'reconnect.log' \
  | sort
}

case "${1:-verify}" in
  approve)
    [ -f "$MAN" ] && cp "$MAN" .manifest.old
    files | xargs sha256sum > "$MAN"
    echo "✅ 已登记 $(wc -l < "$MAN") 个文件的指纹"
    [ -f .manifest.old ] && { echo "--- 本次变更 ---"; diff <(awk '{print $2}' .manifest.old) <(awk '{print $2}' "$MAN") 2>/dev/null | head -20; }
    ;;
  diff)
    files | xargs sha256sum > /tmp/.mq.sha 2>/dev/null
    diff "$MAN" /tmp/.mq.sha
    rm -f /tmp/.mq.sha
    ;;
  verify)
    [ -f "$MAN" ] || { echo "⚠️  尚未登记指纹，请先 ./guard.sh approve"; exit 2; }
    files | xargs sha256sum > /tmp/.mq.sha 2>/dev/null
    if diff -q "$MAN" /tmp/.mq.sha > /dev/null 2>&1; then
      echo "✅ 技能未被修改"
      rm -f /tmp/.mq.sha
      exit 0
    fi
    echo "❌ 检测到技能文件被改动："
    diff "$MAN" /tmp/.mq.sha | grep -E '^[<>]' | sed 's/^</  删除或变更:/; s/^>/  新增或变更:/' | head -20
    rm -f /tmp/.mq.sha
    exit 1
    ;;
  *)
    echo "用法: $0 {verify|approve|diff}"
    exit 1
    ;;
esac
