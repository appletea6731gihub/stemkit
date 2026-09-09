import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { readdirSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join, basename, extname } from 'path'
import { BrowserWindow } from 'electron'
import {
  venvPython,
  venvYtDlp,
  separateScript,
  roformerScript,
  modelsDir,
  ensureEngineDeps,
  ensureVocalsEngine,
  ensureFtWeights,
  ensureGpuEngine,
  getStatus,
  ytDlpRuntimeArgs
} from './env'
import { loadSettings } from './settings'
import {
  songDir,
  stemsDir,
  stemsPresent,
  stemsFor,
  mixWavPath,
  rawDownloadPath,
  upsertSong,
  loadSongs
} from './library'
import type { JobEvent, JobStage } from '../shared/types'
import { MODEL_DEFAULT, MODEL_EXTENDED, MODEL_STUDIO, DEFAULT_STEMS } from '../shared/types'
import { parseMediaSource, parseVideoId } from '../shared/url'
import { track } from './analytics'
import { cacheThumbnail } from './thumbs'

interface ActiveJob {
  videoId: string
  title?: string
  model: string
  cancelled: boolean
  proc?: ChildProcess
}

const jobs = new Map<string, ActiveJob>()

const MAX_CONCURRENT_SEPARATIONS = 2
let activeSeparations = 0
const separationWaiters: Array<() => void> = []

function acquireSeparation(): Promise<() => void> {
  if (activeSeparations < MAX_CONCURRENT_SEPARATIONS) {
    activeSeparations++
    return Promise.resolve(releaseSeparation)
  }
  return new Promise((resolve) => {
    separationWaiters.push(() => {
      activeSeparations++
      resolve(releaseSeparation)
    })
  })
}

function releaseSeparation(): void {
  activeSeparations--
  separationWaiters.shift()?.()
}

function send(ev: JobEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('job:event', ev)
  }
}

function progress(
  job: ActiveJob,
  stage: JobStage,
  pct: number,
  message?: string
): void {
  if (!jobs.has(job.videoId) || job.cancelled) return
  send({
    kind: 'progress',
    data: { videoId: job.videoId, stage, pct, message, title: job.title, model: job.model }
  })
}

export function extractVideoId(url: string): string | null {
  return parseVideoId(url)
}

export async function startJob(
  rawUrl: string,
  requestedModel = MODEL_DEFAULT,
  stems?: string[]
): Promise<void> {
  const url = rawUrl.trim()
  const parsedSource = parseMediaSource(url)
  const videoId = parsedSource?.id ?? parseVideoId(url)
  if (!videoId || !parsedSource) {
    send({ kind: 'failed', data: { videoId: '', message: '无法解析输入内容，支持 YouTube/B站/SoundCloud 链接或本地音视频文件' } })
    return
  }
  if (jobs.has(videoId)) {
    send({ kind: 'failed', data: { videoId, message: '该曲目正在处理中，请稍候' } })
    return
  }

  // engine resolution from settings: roformer vocals when opted in (runs on
  // CPU too — no GPU fallback by design), otherwise htdemucs / htdemucs_ft.
  // The stored model tag encodes the variant so the cache below re-splits
  // whenever the effective engine changes. Suffixes are appended only when
  // non-default, so tags written by older versions stay cache-compatible
  const settings = loadSettings()
  const wantsVocals = !stems?.length || stems.includes('vocals')
  const wantsExtended = stems?.some((s) => s === 'guitar' || s === 'piano')
  let engine: string
  if (requestedModel === MODEL_EXTENDED || requestedModel === 'htdemucs_6s' || wantsExtended) {
    engine = MODEL_EXTENDED
  } else if ((requestedModel === MODEL_STUDIO || requestedModel === 'roformer_hybrid') && settings.roformerVocals && wantsVocals) {
    engine = MODEL_STUDIO
  } else {
    engine = settings.htdemucsFt ? 'htdemucs_ft' : 'htdemucs'
  }
  const modelTag =
    engine +
    (settings.htdemucsFt && engine !== MODEL_EXTENDED ? '-ft' : '') +
    (settings.shifts === 2 ? '@s2' : '')

  // windows honors the GPU toggle: 'cpu' is passed explicitly because
  // roformer.py's 'auto' prefers CUDA whenever the venv's torch supports it.
  // macOS keeps 'auto' (MPS when available)
  const useGpu = settings.gpuSplit && process.platform === 'win32'
  const deviceArg = (): string => {
    if (process.platform === 'win32') return useGpu ? 'cuda' : 'cpu'
    return 'auto'
  }

  const job: ActiveJob = { videoId, model: modelTag, cancelled: false }
  jobs.set(videoId, job)
  const startedAt = Date.now()

  const bail = (message: string): never => {
    throw Object.assign(new Error(message), { videoId })
  }

  try {
    const existing = loadSongs().find((s) => s.videoId === videoId)
    const covered =
      existing &&
      existing.model === modelTag &&
      !!existing.stems?.length &&
      (stems?.length ? stems.every((s) => existing.stems!.includes(s)) : true)
    if (covered && stemsPresent(videoId, stemsFor(existing))) {
      send({ kind: 'done', data: { videoId, song: existing } })
      return
    }
    if (existing && (existing.model !== modelTag || !stemsPresent(videoId, stemsFor(existing)))) {
      rmSync(songDir(videoId), { recursive: true, force: true })
    }

    track('split_started', {
      model: modelTag,
      stems: stems?.length ?? DEFAULT_STEMS.length,
      gpu: useGpu
    })
    mkdirSync(songDir(videoId), { recursive: true })

    const ffmpeg = getStatus().ffmpeg.path
    if (!ffmpeg) bail('内置音视频处理工具 (ffmpeg) 缺失，请检查或重新安装 StemKit。')

    let meta: { title: string; duration: number } = { title: '未知曲目', duration: 0 }

    if (parsedSource.isLocal) {
      // Local audio/video fast-path: bypass yt-dlp download entirely
      const localPath = parsedSource.normalizedUrl
      if (!existsSync(localPath)) {
        bail(`本地文件不存在或无法访问: ${localPath}`)
      }
      const fileName = basename(localPath, extname(localPath))
      meta.title = fileName || '本地曲目'
      job.title = meta.title
      progress(job, 'metadata', 100, job.title)

      progress(job, 'convert', 0, '正在将本地媒体规格化转换为 WAV 格式…')
      // Run ffmpeg directly on local file to produce mix.wav
      await runProcess(job, ffmpeg as string, [
        '-y',
        '-i',
        localPath,
        '-af',
        'aresample=44100',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-c:a',
        'pcm_s16le',
        mixWavPath(videoId)
      ])
      if (job.cancelled || !jobs.has(videoId)) return
      progress(job, 'convert', 100)
    } else {
      // Remote URL pipeline (YouTube, Bilibili, SoundCloud, Direct URL)
      progress(job, 'metadata', 0, '正在读取媒体元数据…')

      const extraYtDlpArgs: string[] = []
      if (parsedSource.type === 'bilibili') {
        extraYtDlpArgs.push('--referer', 'https://www.bilibili.com')
        extraYtDlpArgs.push('--user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
      }

      let raw = ''
      try {
        await runProcess(job, venvYtDlp(), [...ytDlpRuntimeArgs(), ...extraYtDlpArgs, '-J', '--no-playlist', '--skip-download', parsedSource.normalizedUrl], {
          onStdout: (chunk) => {
            raw += chunk
          }
        })
      } catch (err) {
        const args = ytDlpRuntimeArgs()
        const cookieIdx = args.indexOf('--cookies-from-browser')
        if (cookieIdx !== -1) {
          raw = ''
          const fallbackArgs = args.filter((_, i) => i !== cookieIdx && i !== cookieIdx + 1)
          await runProcess(job, venvYtDlp(), [...fallbackArgs, ...extraYtDlpArgs, '-J', '--no-playlist', '--skip-download', parsedSource.normalizedUrl], {
            onStdout: (chunk) => {
              raw += chunk
            }
          })
        } else {
          throw err
        }
      }
      try {
        const parsed = JSON.parse(raw)
        meta = {
          title: typeof parsed.title === 'string' ? parsed.title : '未知曲目',
          duration: typeof parsed.duration === 'number' ? Math.round(parsed.duration) : 0
        }
        // warm the thumbnail cache for offline library browsing
        void cacheThumbnail(videoId, typeof parsed.thumbnail === 'string' ? parsed.thumbnail : undefined)
      } catch {
        bail('无法读取媒体元数据，请检查网络或链接是否有效')
      }
      if (job.cancelled || !jobs.has(videoId)) return
      job.title = meta.title
      progress(job, 'metadata', 100, meta.title)

      progress(job, 'download', 0, '正在下载音频流…')
      let maxPct = 0
      const executeDownload = async (runtimeArgs: string[]): Promise<void> => {
        await runProcess(
          job,
          venvYtDlp(),
          [
            ...runtimeArgs,
            ...extraYtDlpArgs,
            '-f',
            'bestaudio/best',
            '--no-playlist',
            '-o',
            rawDownloadPath(videoId),
            parsedSource.normalizedUrl
          ],
          {
            onStdout: (chunk) => {
              for (const piece of chunk.split(/[\r\n]/)) {
                const m = piece.match(/(\d+(?:\.\d+)?)%/)
                if (m) {
                  const pct = parseFloat(m[1])
                  if (pct > maxPct && pct <= 100) {
                    maxPct = pct
                    progress(job, 'download', pct)
                  }
                }
              }
            }
          }
        )
      }

      try {
        await executeDownload(ytDlpRuntimeArgs())
      } catch (err) {
        const args = ytDlpRuntimeArgs()
        const cookieIdx = args.indexOf('--cookies-from-browser')
        if (cookieIdx !== -1) {
          const fallbackArgs = args.filter((_, i) => i !== cookieIdx && i !== cookieIdx + 1)
          await executeDownload(fallbackArgs)
        } else {
          throw err
        }
      }
      if (job.cancelled || !jobs.has(videoId)) return

      const dir = songDir(videoId)
      const rawFile = readdirSync(dir).find((f) => f.startsWith('raw.'))
      if (!rawFile) bail('媒体下载未能生成有效文件')
      const rawPath = join(dir, rawFile as string)

      progress(job, 'convert', 0, '正在将音频规格化转换为 44.1kHz WAV 格式…')
      await runProcess(job, ffmpeg as string, [
        '-y',
        '-i',
        rawPath,
        '-af',
        'aresample=44100',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-c:a',
        'pcm_s16le',
        mixWavPath(videoId)
      ])
      rmSync(rawPath, { force: true })
      if (job.cancelled || !jobs.has(videoId)) return
      progress(job, 'convert', 100)
    }

    mkdirSync(stemsDir(videoId), { recursive: true })
    progress(job, 'separate', 0, 'Waiting for a free engine slot…')

    const release = await acquireSeparation()
    try {
      if (job.cancelled || !jobs.has(videoId)) return
      // self-heal the GPU engine: the toggle may be on before the CUDA torch
      // download has run (fresh setting, or a failed earlier attempt)
      if (useGpu) {
        if (
          !(await ensureGpuEngine(
            (pct) => progress(job, 'separate', 0, `Downloading GPU engine: ${pct}%`),
            true
          ))
        ) {
          bail('Could not prepare the GPU engine — switch back to CPU in Settings and try again')
        }
      }
      let scriptError: string | null = null
      const producedStems: string[] = []

      const lineParsers = (mapPct: (pct: number, msg?: string) => number) => {
        // the separate stage must never move backwards: scripts can emit
        // multiple internal sweeps, and message-only events (pct 0) update
        // the status text without touching the bar
        let lastPct = 0
        return {
          onLine: (line: string): void => {
            let parsed: Record<string, unknown>
            try {
              parsed = JSON.parse(line)
            } catch {
              return
            }
            if (parsed.type === 'progress') {
              const pct = Number(parsed.pct ?? 0)
              const message =
                typeof parsed.message === 'string' ? parsed.message : undefined
              if (message && pct === 0) {
                progress(job, 'separate', lastPct, message)
                return
              }
              const mapped = Math.max(lastPct, mapPct(pct, message))
              lastPct = mapped
              progress(job, 'separate', mapped, message)
            } else if (parsed.type === 'error') {
              scriptError = `Separation failed: ${String(parsed.message)}`
            } else if (parsed.type === 'done' && Array.isArray(parsed.stems)) {
              producedStems.push(...(parsed.stems as unknown[]).map(String))
            }
          }
        }
      }

      if (engine === MODEL_EXTENDED) {
        progress(job, 'separate', 0, 'Separating stems')
        await runProcess(
          job,
          venvPython(),
          [
            separateScript(),
            '--input',
            mixWavPath(videoId),
            '--out',
            stemsDir(videoId),
            '--model',
            MODEL_EXTENDED,
            '--device',
            deviceArg(),
            '--shifts',
            String(settings.shifts),
            ...(stems?.length ? ['--only', stems.join(',')] : [])
          ],
          lineParsers((pct) => pct)
        )
      } else if (engine === MODEL_STUDIO || engine === 'roformer_hybrid') {
        const otherStems = (
          stems?.length ? stems : ['drums', 'bass', 'other', 'vocals']
        ).filter((s) => s !== 'vocals')
        // the demucs phase takes roughly twice as long as the vocals pass,
        // so the bar reflects that split
        const roformerSpan = otherStems.length > 0 ? 35 : 100
        // the first slice of the vocals phase is the engine download, when
        // one is needed; awaiting it here means roformer.py never races
        // the background fetch on the same checkpoint file
        const downloadSpan = Math.round(roformerSpan * 0.3)
        if (wantsVocals) {
          if (!(await ensureEngineDeps())) {
            bail('Could not prepare the engine components for vocal separation')
          }
          await ensureVocalsEngine((pct) =>
            progress(
              job,
              'separate',
              Math.round((pct / 100) * downloadSpan),
              `Downloading vocals engine (913MB): ${pct}%`
            )
          )
          const vocalsBase = downloadSpan
          progress(job, 'separate', vocalsBase, 'Separating vocals')
          await runProcess(
            job,
            venvPython(),
            [
              roformerScript(),
              '--input',
              mixWavPath(videoId),
              '--out',
              stemsDir(videoId),
              '--ckpt-dir',
              modelsDir(),
              '--device',
              deviceArg()
            ],
            lineParsers((pct) =>
              vocalsBase + Math.round((pct / 100) * (roformerSpan - vocalsBase))
            )
          )
        }
        if (otherStems.length > 0) {
          if (settings.htdemucsFt) {
            if (
              !(await ensureFtWeights((pct) =>
                progress(
                  job,
                  'separate',
                  wantsVocals ? roformerSpan : 0,
                  `Downloading fine-tuned engine (~320MB): ${pct}%`
                )
              ))
            ) {
              bail('Could not download the fine-tuned engine weights')
            }
          }
          progress(
            job,
            'separate',
            wantsVocals ? roformerSpan : 0,
            `Separating ${otherStems.join(', ')}`
          )
          await runProcess(
            job,
            venvPython(),
            [
              separateScript(),
              '--input',
              mixWavPath(videoId),
              '--out',
              stemsDir(videoId),
              '--model',
              settings.htdemucsFt ? 'htdemucs_ft' : 'htdemucs',
              '--device',
              deviceArg(),
              '--shifts',
              String(settings.shifts),
              '--only',
              otherStems.join(',')
            ],
            lineParsers((pct, msg) =>
              wantsVocals && !msg
                ? roformerSpan + Math.round((pct / 100) * (100 - roformerSpan))
                : pct
            )
          )
        }
      } else {
        progress(job, 'separate', 0, 'Separating stems')
        if (settings.htdemucsFt) {
          if (
            !(await ensureFtWeights((pct) =>
              progress(job, 'separate', 0, `Downloading fine-tuned engine (~320MB): ${pct}%`)
            ))
          ) {
            bail('Could not download the fine-tuned engine weights')
          }
        }
        await runProcess(
          job,
          venvPython(),
          [
            separateScript(),
            '--input',
            mixWavPath(videoId),
            '--out',
            stemsDir(videoId),
            '--model',
            engine,
            '--device',
            deviceArg(),
            '--shifts',
            String(settings.shifts),
            ...(stems?.length ? ['--only', stems.join(',')] : [])
          ],
          lineParsers((pct) => pct)
        )
      }

      if (job.cancelled || !jobs.has(videoId)) return
      if (scriptError) bail(scriptError)

      if (!stemsPresent(videoId, producedStems)) bail('Separation finished but stem files are missing')

      progress(job, 'finalize', 100, 'Adding to library')
      const took = Math.round((Date.now() - startedAt) / 1000)
      const songs = upsertSong({
        videoId,
        title: meta!.title,
        duration: meta!.duration,
        addedAt: existing?.addedAt ?? Date.now(),
        model: job.model,
        stems: producedStems,
        took
      })
      track('split_completed', { model: job.model, stems: producedStems.length, took })
      send({ kind: 'done', data: { videoId, song: songs[0] } })
    } finally {
      release()
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message !== 'cancelled') {
      track('split_failed', { model: job.model })
      send({ kind: 'failed', data: { videoId, message } })
    }
  } finally {
    jobs.delete(videoId)
  }
}

function runProcess(
  job: ActiveJob,
  cmd: string,
  args: string[],
  opts: { onStdout?: (chunk: string) => void; onLine?: (line: string) => void } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (job.cancelled || !jobs.has(job.videoId)) return reject(new Error('cancelled'))
    const child = spawn(cmd, args, { env: { ...process.env, PYTORCH_ENABLE_MPS_FALLBACK: '1' } })
    job.proc = child

    let stdoutTail = ''
    let stderrTail = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdoutTail = (stdoutTail + text).slice(-2000)
      opts.onStdout?.(text)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })

    if (opts.onLine && child.stdout) {
      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line) => opts.onLine?.(line))
    }

    child.on('error', reject)
    child.on('close', (code) => {
      if (job.cancelled || !jobs.has(job.videoId)) return reject(new Error('cancelled'))
      if (code === 0) return resolve()
      const detail =
        stderrTail.split('\n').filter(Boolean).slice(-2).join(' — ') ||
        stdoutTail.split('\n').filter(Boolean).slice(-1).join('')
      reject(
        new Error(
          detail
            ? `${cmd.split('/').pop()} exited (${code}): ${detail}`
            : `${cmd.split('/').pop()} exited with code ${code}`
        )
      )
    })
  })
}

export async function searchYouTube(query: string): Promise<
  Array<{ videoId: string; title: string; channel?: string; duration?: number }>
> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const results = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      venvYtDlp(),
      [
        ...ytDlpRuntimeArgs(),
        '--no-warnings',
        '-J',
        '--flat-playlist',
        '--no-playlist',
        `ytsearch15:${trimmed}`
      ],
      { env: { ...process.env } }
    )
    let out = ''
    let err = ''
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString()
    })
    child.stderr?.on('data', (c: Buffer) => {
      err = (err + c.toString()).slice(-1000)
    })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      reject(new Error('Search timed out'))
    }, 30000)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(err.split('\n').filter(Boolean).slice(-1).join('') || `search exited ${code}`))
    })
  })

  try {
    const data = JSON.parse(results)
    const entries = Array.isArray(data.entries) ? data.entries : []
    const mapped = entries
      .filter((e: Record<string, unknown>) => typeof e.id === 'string' && typeof e.title === 'string')
      .map((e: Record<string, unknown>) => ({
        videoId: e.id as string,
        title: e.title as string,
        channel:
          typeof e.uploader === 'string'
            ? e.uploader
            : typeof e.channel === 'string'
              ? e.channel
              : undefined,
        duration: typeof e.duration === 'number' ? Math.round(e.duration) : undefined
      }))
    track('search', { results: mapped.length })
    return mapped
  } catch {
    return []
  }
}

function killTree(proc: ChildProcess): void {
  if (!proc.pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'])
    } catch {}
  } else {
    try {
      proc.kill('SIGKILL')
    } catch {}
  }
}

export function cancelJob(videoId?: string): void {
  const targets = videoId
    ? ([jobs.get(videoId)].filter(Boolean) as ActiveJob[])
    : Array.from(jobs.values())
  for (const job of targets) {
    job.cancelled = true
    killTree(job.proc as ChildProcess)
    jobs.delete(job.videoId)
    rmSync(songDir(job.videoId), { recursive: true, force: true })
    send({ kind: 'failed', data: { videoId: job.videoId, message: 'Cancelled' } })
  }
}

export function isBusy(): boolean {
  return jobs.size > 0
}
