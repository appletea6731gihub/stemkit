import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { net } from 'electron'
import { userDataDir } from './env'

// mqdefault (320x180) covers every thumbnail slot in the app; library
// thumbnails come from this local cache instead of i.ytimg.com once the
// "hide video" setting is on
const YT_THUMB_URL = 'https://i.ytimg.com/vi/'

const memo = new Map<string, Promise<string | null>>()

function thumbsDir(): string {
  return join(userDataDir(), 'thumbs')
}

export function thumbPath(videoId: string): string {
  return join(thumbsDir(), `${videoId}.jpg`)
}

const VALID_ID = /^[\w-]{11}$/

function toDataUrl(buf: Buffer): string {
  return `data:image/jpeg;base64,${buf.toString('base64')}`
}

async function fetchBestThumb(videoId: string, customUrl?: string): Promise<Buffer | null> {
  const urls: string[] = []
  if (typeof customUrl === 'string' && /^https:\/\//.test(customUrl)) {
    urls.push(customUrl)
  }
  urls.push(
    `${YT_THUMB_URL}${videoId}/maxresdefault.jpg`,
    `${YT_THUMB_URL}${videoId}/hqdefault.jpg`,
    `${YT_THUMB_URL}${videoId}/mqdefault.jpg`
  )

  for (const url of urls) {
    try {
      const res = await net.fetch(url, { signal: AbortSignal.timeout(6000) })
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        // YouTube returns a 1097-byte transparent GIF for 404 on maxresdefault
        if (buf.length > 2000) return buf
      }
    } catch {}
  }
  return null
}

// called from the split pipeline (metadata stage) so the cache is warm
// before the song ever shows up in the library
export async function cacheThumbnail(videoId: string, url?: string): Promise<void> {
  if (!VALID_ID.test(videoId)) return
  const file = thumbPath(videoId)
  if (existsSync(file)) return
  const buf = await fetchBestThumb(videoId, url)
  if (!buf) return
  mkdirSync(thumbsDir(), { recursive: true })
  writeFileSync(file, buf)
  memo.delete(videoId)
}

// resolves to a data URL from the local cache or fetches online
export function getThumb(videoId: string): Promise<string | null> {
  if (!VALID_ID.test(videoId)) return Promise.resolve(null)
  let p = memo.get(videoId)
  if (p) return p
  p = (async (): Promise<string | null> => {
    const file = thumbPath(videoId)
    if (existsSync(file)) {
      try {
        return toDataUrl(readFileSync(file))
      } catch {}
    }
    const buf = await fetchBestThumb(videoId)
    if (!buf) return null
    mkdirSync(thumbsDir(), { recursive: true })
    writeFileSync(file, buf)
    return toDataUrl(buf)
  })()
  memo.set(videoId, p)
  return p
}

// hideVideo flipped: previously-returned nulls may now be servable and the
// other way around, so drop every cached resolution
export function clearThumbMemo(): void {
  memo.clear()
}