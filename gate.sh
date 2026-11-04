#!/bin/sh
# 从日志里取最新一次扫码 task_id，生成可点击的扫码页
cd "$(dirname "$0")"
task=$(node bind.mjs > .bind.out 2>&1 & echo $! >/dev/null; sleep 6; pkill -f 'bind.mjs' 2>/dev/null; grep -o 'task_id=[0-9a-f-]*' .bind.out | head -1)
url="https://q.qq.com/qqbot/openclaw/connect.html?$task&source=&_wv=2"
node -e "
const fs=require('fs');const u=process.argv[1];
fs.writeFileSync('bind.html','<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>QQ 扫码绑定</title><body style=\"font-family:-apple-system;text-align:center;padding:24px;background:#fff\"><h2>QQ 扫码绑定机器人</h2><p style=\"color:#666\">用手机 QQ 扫码，选择要绑定的机器人</p><img style=\"width:240px;height:240px\" src=\"qr.png\"><p style=\"font-size:12px;color:#999;word-break:break-all;margin-top:16px\">'+u+'</p></body>');
" "$url"
echo "$url"
