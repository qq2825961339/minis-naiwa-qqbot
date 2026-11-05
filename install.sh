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
  PYLIB=$(python3 -c "import sysconfig;print(sysconfig.get_paths()['purelib'])" 2>/dev/null)

  # 2a) edge-tts 本体：先试离线包
  if ! python3 -c "import edge_tts" 2>/dev/null; then
    if [ -f vendor/py-deps.tar.gz ]; then
      echo "[2/3] 解压 edge-tts 离线包…"
      tar -xzf vendor/py-deps.tar.gz -C "$PYLIB" 2>/dev/null
    fi
  fi

  # 2b) 系统级依赖 aiohttp / certifi：离线包带不动，缺了就从 apk 装
  MISS=""
  python3 -c "import aiohttp" 2>/dev/null || MISS="$MISS aiohttp"
  python3 -c "import certifi" 2>/dev/null || MISS="$MISS certifi"
  if [ -n "$MISS" ]; then
    echo "[2/3] 缺少$MISS，从 apk 安装…"
    apk add --no-cache py3-aiohttp py3-certifi >/dev/null 2>&1 \
      || apk add --no-cache aiohttp certifi >/dev/null 2>&1 \
      || echo "    ⚠️ apk 安装失败，试着用 pip"
  fi

  # 2c) 最终兜底：pip
  if ! python3 -c "import edge_tts" 2>/dev/null; then
    echo "[2/3] 离线包无效，联网安装…"
    (pip install --no-deps edge-tts 2>/dev/null || pip install edge-tts 2>/dev/null) \
      && echo "    ✅ pip 安装成功" \
      || echo "    ❌ 安装失败：语音功能不可用（其他功能不受影响）"
  fi

  if python3 -c "import edge_tts" 2>/dev/null; then
    # 端到端验一次，别只看 import
    if python3 -c "import edge_tts, asyncio; asyncio.run(edge_tts.Communicate('你好', 'zh-CN-YunxiaNeural').save('/tmp/.ttscheck.mp3'))" 2>/dev/null && [ -s /tmp/.ttscheck.mp3 ]; then
      echo "[2/3] edge-tts 就绪（已实测合成）"
      rm -f /tmp/.ttscheck.mp3
    else
      echo "[2/3] edge-tts 已装，但合成失败（可能没网或接口变动）"
    fi
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
