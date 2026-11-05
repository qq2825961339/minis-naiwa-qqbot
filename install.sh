#!/bin/sh
# 一键安装：解压离线依赖，不联网
set -e
cd "$(dirname "$0")"

echo "== 奶蛙安装 =="

# 1) Node 依赖
if [ ! -d node_modules ]; then
  if [ -f vendor/node_modules.tar.gz ]; then
    echo "[1/3] 解压 Node 依赖…"
    tar -xzf vendor/node_modules.tar.gz
  else
    echo "[1/3] 没有离线包，联网安装…"
    npm install --no-bin-links --ignore-scripts
  fi
else
  echo "[1/3] node_modules 已存在，跳过"
fi

# 2) Python 依赖（TTS 用的 edge-tts）
if command -v python3 >/dev/null 2>&1; then
  if ! python3 -c "import edge_tts" 2>/dev/null; then
    if [ -f vendor/py-deps.tar.gz ]; then
      echo "[2/3] 解压 TTS 依赖…"
      PYLIB=$(python3 -c "import sysconfig;print(sysconfig.get_paths()['purelib'])")
      tar -xzf vendor/py-deps.tar.gz -C "$PYLIB"
    else
      echo "[2/3] 没有离线包，联网安装 edge-tts…"
      pip install edge-tts 2>/dev/null || apk add py3-pip >/dev/null 2>&1 && pip install edge-tts
    fi
  else
    echo "[2/3] edge-tts 已装，跳过"
  fi
else
  echo "[2/3] 没有 python3，语音功能不可用"
fi

# 3) 检查 ffmpeg
if command -v ffmpeg >/dev/null 2>&1; then
  echo "[3/3] ffmpeg 就绪"
else
  echo "[3/3] 缺少 ffmpeg，语音音量调整会失败（apk add ffmpeg）"
fi

chmod +x *.sh 2>/dev/null
echo
echo "安装完成。接下来："
echo "  ./start.sh     启动（没绑定时自动生成二维码）"
