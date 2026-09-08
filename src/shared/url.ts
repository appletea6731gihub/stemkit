/**
 * Multi-source URL and local file parser for StemKit.
 * Supports:
 * - YouTube: standard, short, embed, or 11-char ID
 * - Bilibili: BV id, b23.tv short link, bilibili.com/video/BV...
 * - SoundCloud: soundcloud.com/...
 * - Direct Web Audio/Video: .mp3, .wav, .flac, .m4a, .aac, .ogg, .mp4, .webm, .mkv
 * - Local Files: absolute/relative path with audio/video extensions, or file:// URL
 */

export type MediaSourceType = 'youtube' | 'bilibili' | 'soundcloud' | 'direct_url' | 'local_file'

export interface ParsedMediaSource {
  type: MediaSourceType
  id: string
  normalizedUrl: string
  isLocal: boolean
  originalInput: string
}

const AUDIO_EXTS = ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.alac', '.aiff']
const VIDEO_EXTS = ['.mp4', '.mkv', '.webm', '.mov', '.avi']
const SUPPORTED_EXTS = [...AUDIO_EXTS, ...VIDEO_EXTS]

/**
 * Generates a consistent 12-char alphanumeric hash for non-YouTube media
 */
function hashString(str: string): string {
  let hash = 0
  let hash2 = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash |= 0
    hash2 = (hash2 << 7) - hash2 + char
    hash2 |= 0
  }
  const part1 = Math.abs(hash).toString(36).padStart(6, '0').slice(0, 6)
  const part2 = Math.abs(hash2).toString(36).padStart(6, '0').slice(0, 6)
  return `${part1}${part2}`
}

export function parseMediaSource(input: string): ParsedMediaSource | null {
  if (!input) return null
  let t = input.trim()

  // 0. Handle file:// URI
  if (t.startsWith('file://')) {
    try {
      t = decodeURIComponent(t.replace(/^file:\/\//, ''))
      // On Windows file:///C:/path -> C:/path
      if (process.platform === 'win32' && t.startsWith('/')) {
        t = t.slice(1)
      }
    } catch {}
  }

  // 1. Check Local File Path (Absolute Windows/Unix path or file extension)
  const lower = t.toLowerCase()
  const hasExt = SUPPORTED_EXTS.some((ext) => lower.endsWith(ext) || lower.includes(`${ext}?`))

  const isWindowsPath = /^[a-zA-Z]:[\\/]/.test(t)
  const isUnixPath = t.startsWith('/') || t.startsWith('~/') || t.startsWith('./') || t.startsWith('../')

  if ((isWindowsPath || isUnixPath || hasExt) && !t.startsWith('http://') && !t.startsWith('https://')) {
    const hash = hashString(t)
    return {
      type: 'local_file',
      id: `loc_${hash}`,
      normalizedUrl: t,
      isLocal: true,
      originalInput: input
    }
  }

  // 2. YouTube Patterns
  const ytPatterns = [
    /(?:youtube\.com\/watch\?.*v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/,
    /(?:youtube\.com\/embed\/)([\w-]{11})/
  ]
  for (const re of ytPatterns) {
    const m = t.match(re)
    if (m) {
      return {
        type: 'youtube',
        id: m[1],
        normalizedUrl: `https://www.youtube.com/watch?v=${m[1]}`,
        isLocal: false,
        originalInput: input
      }
    }
  }

  // Raw 11-char YouTube ID
  if (/^[\w-]{11}$/.test(t)) {
    return {
      type: 'youtube',
      id: t,
      normalizedUrl: `https://www.youtube.com/watch?v=${t}`,
      isLocal: false,
      originalInput: input
    }
  }

  // 3. Bilibili (b23.tv or bilibili.com/video/BV... or BV...)
  const biliBvMatch = t.match(/(?:bilibili\.com\/video\/|b23\.tv\/)?(BV[a-zA-Z0-9]{10})/i)
  if (biliBvMatch) {
    const bvid = biliBvMatch[1]
    return {
      type: 'bilibili',
      id: `bi_${bvid}`,
      normalizedUrl: `https://www.bilibili.com/video/${bvid}`,
      isLocal: false,
      originalInput: input
    }
  }
  if (t.includes('b23.tv/')) {
    const hash = hashString(t)
    return {
      type: 'bilibili',
      id: `bi_${hash}`,
      normalizedUrl: t.startsWith('http') ? t : `https://${t}`,
      isLocal: false,
      originalInput: input
    }
  }

  // 4. SoundCloud
  if (t.includes('soundcloud.com/')) {
    const hash = hashString(t)
    return {
      type: 'soundcloud',
      id: `sc_${hash}`,
      normalizedUrl: t.startsWith('http') ? t : `https://${t}`,
      isLocal: false,
      originalInput: input
    }
  }

  // 5. Direct Web URL (HTTP/HTTPS with supported audio/video extension)
  if (t.startsWith('http://') || t.startsWith('https://')) {
    const hash = hashString(t)
    return {
      type: 'direct_url',
      id: `url_${hash}`,
      normalizedUrl: t,
      isLocal: false,
      originalInput: input
    }
  }

  return null
}

/**
 * Backward compatibility helper for legacy code expecting parseVideoId
 */
export function parseVideoId(input: string): string | null {
  const parsed = parseMediaSource(input)
  return parsed ? parsed.id : null
}
