#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OS="$(uname -s)"
mkdir -p "$ROOT/extras"

if [[ "$OS" == "Darwin" ]]; then
  OUT="$ROOT/extras/ffmpeg-mac"
  if [[ -x "$OUT/ffmpeg" ]]; then
    echo "ffmpeg already present: $OUT/ffmpeg"
    "$OUT/ffmpeg" -version | head -1
    exit 0
  fi
  mkdir -p "$OUT"
  echo "downloading static ffmpeg for macOS..."
  curl -fsSL -o "$ROOT/extras/ffmpeg-mac.zip" "https://evermeet.cx/ffmpeg/get/ffmpeg/zip"
  unzip -oq "$ROOT/extras/ffmpeg-mac.zip" -d "$OUT"
  rm -f "$ROOT/extras/ffmpeg-mac.zip"
  chmod +x "$OUT/ffmpeg"
  "$OUT/ffmpeg" -version | head -1
  echo "saved to $OUT/ffmpeg"

  if [[ ! -x "$ROOT/extras/setfileicon" ]] && [[ -f "$ROOT/scripts/setfileicon.swift" ]]; then
    echo "compiling setfileicon..."
    swiftc -O "$ROOT/scripts/setfileicon.swift" -o "$ROOT/extras/setfileicon"
    chmod +x "$ROOT/extras/setfileicon"
  fi
elif [[ "$OS" == "MINGW"* || "$OS" == "MSYS"* || "$OS" == "CYGWIN"* ]]; then
  echo "on Windows, run instead: powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1"
  exit 1
else
  echo "unsupported OS: $OS"
  exit 1
fi
