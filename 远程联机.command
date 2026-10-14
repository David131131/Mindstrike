#!/bin/bash
# ============================================================
#  Mindstrike 远程联机(公网隧道)· 一键启动 (macOS)
#  双击本文件: 自动启动游戏服务器 + Cloudflare 公网隧道,
#  网址生成后【自动复制到剪贴板】并高亮打印 —— 直接发给好友即可。
#  停止: 回到窗口按 Ctrl+C, 然后按回车关闭。
# ============================================================
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  ⚠️  未检测到 Node.js! 请先到 https://nodejs.org 安装后重试。"
  read -n 1 -s -r -p "  按任意键关闭…"
  exit 1
fi
if [ ! -x ./cloudflared ]; then
  echo ""
  echo "  ⚠️  缺少 cloudflared(公网隧道工具)。"
  echo "  请运行:  curl -fL -o cloudflared.tgz https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz"
  echo "           tar xzf cloudflared.tgz && chmod +x cloudflared"
  read -n 1 -s -r -p "  按任意键关闭…"
  exit 1
fi

echo ""
echo "  ⚔️  正在启动游戏服务器 + 公网隧道…(约 5~10 秒)"
echo ""

# 1) 游戏服务器(后台)
node server.js &
SERVER_PID=$!

# 2) 等待服务器就绪
for i in $(seq 1 40); do
  if curl -s -o /dev/null --max-time 1 http://127.0.0.1:8765; then break; fi
  sleep 0.25
done

# 3) 公网隧道(后台运行, 日志写入临时文件以便抓取网址)
LOG=/tmp/mindstrike-tunnel-$$.log
./cloudflared tunnel --url http://localhost:8765 --no-autoupdate > "$LOG" 2>&1 &
CF_PID=$!

# 4) 轮询日志, 直到出现 trycloudflare.com 网址
URL=""
for i in $(seq 1 90); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1)
  if [ -n "$URL" ]; then break; fi
  if ! kill -0 $CF_PID 2>/dev/null; then break; fi
  sleep 0.5
done

if [ -n "$URL" ]; then
  # 高亮提示 + 自动复制到剪贴板
  echo ""
  echo "  ================================================================"
  echo "    🎮  给好友的公网网址(已自动复制到剪贴板):"
  echo ""
  echo "      $URL"
  echo ""
  echo "    你自己玩: 浏览器打开  http://localhost:8765"
  echo "    把上面网址发给好友 → 好友打开后点「联机对战」加入即可"
  echo "  ================================================================"
  echo ""
  printf '%s' "$URL" | pbcopy 2>/dev/null && echo "  ✅ 网址已复制, 直接粘贴发送即可(Cmd+V)"
  echo ""
  echo "  (窗口会继续滚动隧道日志, 属正常现象; 不要关闭本窗口)"
else
  echo ""
  echo "  ⚠️  公网网址生成失败, 请看下面的日志找原因:"
  echo ""
  tail -n 20 "$LOG" 2>/dev/null
fi

# 5) 前台跟随日志; Ctrl+C 会同时停掉隧道与服务器
tail -f "$LOG" 2>/dev/null &
TAIL_PID=$!
wait $CF_PID 2>/dev/null
kill $TAIL_PID 2>/dev/null
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null

echo ""
echo "  服务器与隧道已停止。"
read -n 1 -s -r -p "  按任意键关闭窗口…"
