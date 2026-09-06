#!/usr/bin/env node
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const IS_WIN = process.platform === 'win32'

function readRequiredMajor() {
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim()
    const major = parseInt(txt.split('.')[0], 10)
    if (!Number.isNaN(major)) return major
  } catch {}
  return 18
}

function cleanVersion(version) {
  return String(version).replace(/^v/, '')
}

function majorOf(version) {
  return parseInt(cleanVersion(version).split('.')[0], 10)
}

function cmpSemver(a, b) {
  const pa = cleanVersion(a).split('.').map(Number)
  const pb = cleanVersion(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

function findNode(requiredMajor) {
  const candidates = []
  if (IS_WIN) {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
    candidates.push(path.join(programFiles, 'nodejs', 'node.exe'))
    const nvmHome =
      process.env.NVM_HOME || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'nvm')
    try {
      for (const ver of fs.readdirSync(nvmHome)) {
        if (majorOf(ver) < requiredMajor) continue
        const nodeBin = path.join(nvmHome, ver, 'node.exe')
        if (fs.existsSync(nodeBin)) candidates.push(nodeBin)
      }
    } catch {}
  } else {
    candidates.push(process.execPath, '/opt/homebrew/bin/node', '/usr/local/bin/node')
    const nvmRoot = path.join(os.homedir(), '.nvm', 'versions', 'node')
    try {
      for (const ver of fs.readdirSync(nvmRoot)) {
        if (majorOf(ver) < requiredMajor) continue
        const nodeBin = path.join(nvmRoot, ver, 'bin', 'node')
        if (fs.existsSync(nodeBin)) candidates.push(nodeBin)
      }
    } catch {}
  }

  let best = null
  for (const nodeBin of candidates) {
    if (!fs.existsSync(nodeBin)) continue
    try {
      const out = spawnSync(nodeBin, ['-v'], { encoding: 'utf8' })
      const version = cleanVersion((out.stdout || '').trim())
      if (majorOf(version) < requiredMajor) continue
      if (!best || cmpSemver(version, best.version) > 0) best = { version, nodeBin }
    } catch {}
  }
  return best
}

const STEPS = {
  dev: [['electron-vite', 'dev']],
  build: [['electron-vite', 'build']],
  typecheck: [
    ['tsc', '--noEmit', '-p', 'tsconfig.node.json'],
    ['tsc', '--noEmit', '-p', 'tsconfig.web.json']
  ],
  'typecheck:node': [['tsc', '--noEmit', '-p', 'tsconfig.node.json']],
  'typecheck:web': [['tsc', '--noEmit', '-p', 'tsconfig.web.json']],
  dist: [['electron-vite', 'build'], ['electron-builder', '--mac']],
  'dist:win': [['electron-vite', 'build'], ['electron-builder', '--win']],
  'dist:all': [['electron-vite', 'build'], ['electron-builder', '--mac', '--win']]
}

function resolveBin(name) {
  const ext = IS_WIN ? '.cmd' : ''
  const local = path.join(ROOT, 'node_modules', '.bin', name + ext)
  if (fs.existsSync(local)) return local
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const suffix of IS_WIN ? ['.cmd', '.exe', ''] : ['']) {
      const candidate = path.join(dir, name + suffix)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  console.error(`Cannot find ${name} — run npm install first`)
  process.exit(1)
}

function runSteps(steps) {
  for (const [bin, ...args] of steps) {
    const resolved = resolveBin(bin)
    const useShell = IS_WIN && resolved.toLowerCase().endsWith('.cmd')
    const r = spawnSync(useShell ? `"${resolved}"` : resolved, args, {
      stdio: 'inherit',
      shell: useShell
    })
    if (r.status !== 0) process.exit(r.status ?? 1)
  }
}

function main() {
  const cmd = process.argv[2]
  const steps = STEPS[cmd]
  if (!steps) {
    console.error(`Unknown command: ${cmd}. Available: ${Object.keys(STEPS).join(', ')}`)
    process.exit(1)
  }

  const required = readRequiredMajor()
  if (majorOf(process.versions.node) < required) {
    const found = findNode(required)
    if (!found) {
      console.error(
        `StemKit needs Node ${required}+ but you have ${process.versions.node}, and no matching Node install was found.\nInstall Node ${required} or newer from https://nodejs.org`
      )
      process.exit(1)
    }
    console.log(
      `> StemKit needs Node ${required}+ (active: ${process.versions.node}) — using ${found.version} at ${found.nodeBin}`
    )
    const r = spawnSync(found.nodeBin, [__filename, ...process.argv.slice(2)], {
      stdio: 'inherit'
    })
    process.exit(r.status ?? 1)
  }

  runSteps(steps)
}

main()
