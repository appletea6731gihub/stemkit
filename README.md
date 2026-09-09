# StemKit (v0.2.0)

Split any song — from **YouTube, Bilibili, SoundCloud, or your local files** — into isolated stems (**vocals, drums, bass, guitar, piano** and more), running entirely offline on your computer.

Search online, paste a link, or drag and drop your local audio/video file. Play the result like a mini DAW: video/artwork on one side, every stem on its own fader, all perfectly in sync. Karaoke, acapellas and instrumentals are one click away.

Everything runs locally — no accounts, no cloud fees, no API keys.

![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-black) ![local](https://img.shields.io/badge/100%25-local-emerald) ![version](https://img.shields.io/badge/version-v0.2.0-blue)

<p align="center">
  <img src="docs/stemkit.png" alt="StemKit splitting Queen's Bohemian Rhapsody into six stems — video player, presets and color-coded waveform lanes" width="100%" />
</p>

## What's New in v0.2.0

- 📂 **Local Audio & Video Drag-and-Drop**: Drag any `MP3`, `WAV`, `FLAC`, `M4A`, `AAC`, `OGG`, `MP4`, `MKV` into StemKit for instant offline separation.
- ⚡ **Zero-Download Fastpath**: Local media skips the download phase completely — normalized via embedded FFmpeg and fed directly into the neural separation engine.
- 📺 **Multi-source Web Streaming**: In addition to YouTube, paste links from **Bilibili (b23.tv / BV...)**, **SoundCloud**, or direct audio URLs with automated anti-hotlinking headers.
- 📁 **Native File Picker**: Click the new `[本地文件]` button to choose files directly from your system file dialog.
- 🎛️ **Adaptive Player**: Intelligent provider badges (Bilibili quick-jump, Local Media indicator, YouTube iframe integration).

## Features

- **Multi-Source Ingestion**: YouTube, B站, SoundCloud, and local files (MP3/WAV/FLAC/M4A/etc.)
- **6-Stem Separation**: Pick your instruments individually (Vocals, Drums, Bass, Guitar, Piano, Other)
- **Tight Sync Playback**: Instant seek, interactive waveforms, per-stem mute/solo/volume
- **One-Click Presets**: All · Karaoke · Acapella · Drums + Bass
- **Flexible Stem Export**: Export individual stems or all stems as MP3 (320kbps), M4A (256kbps), or uncompressed WAV
- **Fully Offline**: Neural models run on Apple Silicon (MPS), NVIDIA GPUs (CUDA), or CPU

## Download (v0.2.0)

Grab the latest installers from [Releases](https://github.com/appletea6731gihub/stemkit/releases):
- **macOS** (Apple Silicon): `StemKit-0.2.0-mac-arm64.dmg`
- **Windows** (x64): `StemKit-0.2.0-win-x64.exe` (NSIS 一键安装包) 或便携 `.zip`

> First launch downloads the separation engine weights (~2 GB) one time. ffmpeg is bundled — nothing else to install.

### System Requirements
- **macOS 12+** (Apple Silicon M1/M2/M3/M4)
- **Windows 10/11** (x64)

## Develop

```bash
npm install
npm run dev
```

## Build Locally

```bash
bash scripts/fetch-ffmpeg.sh        # macOS (one time)
powershell scripts/fetch-ffmpeg.ps1 # Windows (one time)

npm run dist        # macOS dmg -> release/
npm run dist:win    # Windows nsis+zip -> release/
npm run dist:all    # Build matching current OS
```

## Architecture

```
[Input Source]
  ├─► Local File (MP3/WAV/FLAC/MP4) ──► Bundled FFmpeg (44.1kHz WAV Normalizer) ─┐
  └─► Web (YouTube / B站 / SoundCloud) ─► yt-dlp ──► Bundled FFmpeg ───────────────┤
                                                                                 ▼
                                                      ┌─── Mel-Band RoFormer (Studio Vocals)
                                                      └─── HTDemucs (Drums/Bass/Guitar/Piano/Other)
                                                                                 │
                                                                                 ▼
                                                                            stems/*.wav
                                                                                 │
Electron Renderer ◄────────── IPC Events ────────────────────────────────────────┘
Waveform Lanes + Multi-track Web Audio Mixer + Dynamic Visuals
```
