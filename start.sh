#!/usr/bin/env bash
# ==============================================================================
# StemKit 快捷控制脚本 (macOS)
# ==============================================================================

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

ACTION="${1:-app}"

case "$ACTION" in
  app)
    echo "🚀 正在启动已安装的 StemKit 桌面客户端..."
    if [ -d "/Applications/StemKit.app" ]; then
      open /Applications/StemKit.app
    elif [ -d "$DIR/release/mac-arm64/StemKit.app" ]; then
      open "$DIR/release/mac-arm64/StemKit.app"
    else
      echo "未检测到已安装的 StemKit.app，正在启动开发模式..."
      npm run dev
    fi
    ;;
  dev)
    echo "🛠️ 正在启动 StemKit 本地开发模式 (Vite + Electron)..."
    npm run dev
    ;;
  build)
    echo "📦 正在执行 TypeScript 类型检查并编译前端与 Electron 主进程..."
    npm run typecheck
    npm run build
    ;;
  dist)
    echo "🔨 正在打包 macOS 原生 DMG 与 ZIP 安装包..."
    npm run dist
    ;;
  test-engine)
    echo "🧪 正在测试本地 Demucs AI 分离引擎与 Apple Silicon MPS 加速..."
    "$HOME/Library/Application Support/StemKit/venv/bin/python" -c "import torch; print('PyTorch Version:', torch.__version__); print('MPS GPU 加速可用:', torch.backends.mps.is_available())"
    "$HOME/Library/Application Support/StemKit/venv/bin/python" python/separate.py --help
    ;;
  *)
    echo "用法: ./start.sh [app|dev|build|dist|test-engine]"
    echo "  app         - 打开 macOS 原生 StemKit 桌面应用 (默认)"
    echo "  dev         - 启动本地开发与热重载模式 (npm run dev)"
    echo "  build       - 编译前端与 Electron 产物"
    echo "  dist        - 打包生成发布版 DMG"
    echo "  test-engine - 测试底层 AI 引擎环境"
    ;;
esac
