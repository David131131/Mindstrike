#!/bin/bash
# ============================================================
#  Mindstrike 联机服务器 · 一键启动 (macOS)
#  双击本文件即可: 自动启动服务器并打开浏览器, 无需手动敲命令
#  停止方法: 回到弹出的终端窗口, 按 Ctrl+C 后关窗(或直接关窗)
# ============================================================
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  ⚠️  未检测到 Node.js!"
  echo "  请先到 https://nodejs.org 下载安装(LTS 版), 装好后重新双击本文件。"
  echo ""
  read -n 1 -s -r -p "  按任意键关闭…"
  exit 1
fi

export MS_OPEN=1
echo ""
echo "  Mindstrike 联机服务器启动中…(就绪后会自动打开浏览器)"
echo ""
node server.js
echo ""
echo "  服务器已停止。"
read -n 1 -s -r -p "  按任意键关闭窗口…"
