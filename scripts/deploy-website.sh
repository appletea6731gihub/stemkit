#!/usr/bin/env bash
# ==============================================================================
# StemKit 官网落地页一键部署与预览脚本
# ==============================================================================

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

ACTION="${1:-preview}"
PORT="${2:-5188}"

case "$ACTION" in
  preview)
    echo "🌐 正在启动 StemKit 官网本地生产预览 (端口: $PORT)..."
    echo "👉 浏览器打开: http://localhost:$PORT"
    echo "💡 按 Ctrl+C 停止预览"
    python3 -m http.server "$PORT" --directory website
    ;;
  cloudflare)
    echo "☁️ 准备静态网站资产 (排除 >25MB 本地安装包)..."
    TMP_DIR="$(mktemp -d)"
    rsync -a --exclude="downloads" website/ "$TMP_DIR/"
    echo "☁️ 正在通过 Cloudflare Wrangler 将 website 部署到 Cloudflare Pages..."
    npx -y wrangler pages deploy "$TMP_DIR" --project-name=stemkit
    RES=$?
    rm -rf "$TMP_DIR"
    exit $RES
    ;;
  help|*)
    echo "用法: ./scripts/deploy-website.sh [preview|cloudflare]"
    echo ""
    echo "  preview [端口] - 本地启动官网 HTTP 服务进行效果预览 (默认端口 5188)"
    echo "  cloudflare     - 一键部署到 Cloudflare Pages 免费全球 CDN (需登录CF)"
    echo ""
    echo "其他部署渠道说明:"
    echo "  - Vercel: 执行 npx vercel website --prod"
    echo "  - GitHub Pages: 将 website 目录推送到 gh-pages 分支或根目录 docs"
    ;;
esac
