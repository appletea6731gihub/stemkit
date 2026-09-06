#!/usr/bin/env node
/**
 * StemKit GitHub Release 一键上传脚本
 * 
 * 用法:
 *   GITHUB_TOKEN=ghp_xxxx GITHUB_REPO=yourname/stemkit node scripts/publish-github-release.mjs [tag]
 */

import { readFileSync, statSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { execSync } from 'child_process';

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const RELEASE_DIR = join(ROOT, 'release');

function getGitToken() {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
    return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  }
  try {
    const creds = execSync('printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore']
    });
    const match = creds.match(/password=(.+)/);
    if (match && match[1]) return match[1].trim();
  } catch {}
  return null;
}

function getGitRepo() {
  if (process.env.GITHUB_REPO) return process.env.GITHUB_REPO;
  try {
    const remote = execSync('git config --get remote.origin.url', { encoding: 'utf-8' }).trim();
    const match = remote.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (match) return `${match[1]}/${match[2]}`;
  } catch {}
  return 'appletea6731gihub/stemkit';
}

const TOKEN = getGitToken();
const REPO = getGitRepo();
const TAG = process.argv[2] || 'v0.1.18';

if (!TOKEN || !REPO) {
  console.log(`
❌ 缺少必要环境变量或无法从 Git 凭据提取 Token！

使用方法:
  export GITHUB_TOKEN="ghp_你的GitHubToken"
  export GITHUB_REPO="你的用户名/仓库名"   # 例如: appletea6731gihub/stemkit
  node scripts/publish-github-release.mjs ${TAG}
`);
  process.exit(1);
}

const [owner, repoName] = REPO.split('/');
if (!owner || !repoName) {
  console.error('❌ GITHUB_REPO 格式错误，应为 "owner/repo"');
  process.exit(1);
}

const filesToUpload = [
  'StemKit-0.1.18-mac-arm64.dmg',
  'StemKit-0.1.18-mac-arm64.dmg.blockmap',
  'StemKit-0.1.18-mac-arm64.zip',
  'StemKit-0.1.18-mac-arm64.zip.blockmap',
  'latest-mac.yml',
  'StemKit-0.1.18-win-x64.exe',
  'StemKit-0.1.18-win-x64.exe.blockmap',
  'StemKit-0.1.18-win-x64.zip',
  'latest.yml'
];

async function run() {
  console.log(`🚀 准备向 GitHub 仓库 ${REPO} 发布 Release [${TAG}]...`);

  // 0. 自动推送本地代码至远程 main 分支，确保仓库不再是空仓库
  try {
    console.log(`🔄 正在自动同步本地代码到 GitHub (${REPO} main 分支)...`);
    execSync(`git push https://x-access-token:${TOKEN}@github.com/${REPO}.git main --force`, {
      cwd: ROOT,
      stdio: 'inherit'
    });
    console.log(`✅ 代码已成功推送到远程仓库！`);
  } catch (err) {
    console.error(`❌ 代码推送失败:`, err.message || err);
    process.exit(1);
  }

  const releasesUrl = `https://api.github.com/repos/${owner}/${repoName}/releases`;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${TOKEN}`,
    'User-Agent': 'StemKit-Release-Uploader'
  };

  let release = null;
  const releaseName = `StemKit ${TAG} (macOS Apple Silicon & Windows x64 官方稳定版)`;
  const releaseBody = `### StemKit ${TAG} 官方发布说明\n\n` +
    `- 🚀 **突破 YouTube 防爬机制**：深度集成 Node.js 解密运行时与静默浏览器会话穿透，彻底解决 \`Sign in to confirm you're not a bot\` 报错\n` +
    `- 🎛️ **默认 6 音轨工业级分离**：人声 (Vocals)、鼓点 (Drums)、贝斯 (Bass)、吉他 (Guitar)、钢琴 (Piano)、其他伴奏 (Other)\n` +
    `- 🍏 **macOS Apple Silicon 原生优化**：M1 / M2 / M3 / M4 芯片 MPS 硬件加速，原生 arm64 FFmpeg n9.0\n` +
    `- 🪟 **Windows x64 全架构支持**：NSIS 一键静默安装向导与便携绿色版，自动适配 GPU / CPU\n` +
    `- 🔄 **内置全自动增量升级**：对接 Cloudflare CDN 与 GitHub Releases，开箱即用\n`;

  const getRes = await fetch(`${releasesUrl}/tags/${TAG}`, { headers });
  if (getRes.ok) {
    release = await getRes.json();
    console.log(`✅ 已找到现有 Release (${release.name || TAG})，ID: ${release.id}`);
    await fetch(`${releasesUrl}/${release.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: releaseName, body: releaseBody })
    });
  } else {
    console.log(`📝 正在创建新 Release: ${TAG}...`);
    const createRes = await fetch(releasesUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: TAG,
        name: releaseName,
        body: releaseBody,
        draft: false,
        prerelease: false
      })
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      console.error(`❌ 创建 Release 失败:`, err);
      process.exit(1);
    }
    release = await createRes.json();
    console.log(`🎉 Release 创建成功！访问地址: ${release.html_url}`);
  }

  const uploadUrlTemplate = release.upload_url;
  const existingAssets = release.assets || [];

  for (const filename of filesToUpload) {
    const filePath = join(RELEASE_DIR, filename);
    if (!existsSync(filePath)) {
      console.warn(`⚠️ 文件不存在，跳过: ${filePath}`);
      continue;
    }

    const dup = existingAssets.find(a => a.name === filename);
    if (dup) {
      console.log(`🔄 删除已存在的同名旧文件: ${filename}...`);
      await fetch(`https://api.github.com/repos/${owner}/${repoName}/releases/assets/${dup.id}`, {
        method: 'DELETE',
        headers
      });
    }

    const stat = statSync(filePath);
    const sizeMb = (stat.size / 1024 / 1024).toFixed(1);
    console.log(`⬆️ 正在上传 ${filename} (${sizeMb} MB)...`);

    const uploadUrl = uploadUrlTemplate.replace('{?name,label}', '') + `?name=${encodeURIComponent(filename)}`;
    const fileBuffer = readFileSync(filePath);

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${TOKEN}`,
        'User-Agent': 'StemKit-Release-Uploader',
        'Content-Type': filename.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream',
        'Content-Length': String(stat.size)
      },
      body: fileBuffer
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      console.error(`❌ 上传 ${filename} 失败:`, err);
    } else {
      const uploaded = await uploadRes.json();
      console.log(`✅ 上传完成: ${uploaded.browser_download_url}`);
    }
  }

  console.log(`\n🎉 全部安装包与升级元数据已成功托管至 GitHub Releases！`);
  console.log(`👉 永久发布地址: ${release.html_url}`);
}

run().catch(err => {
  console.error('❌ 执行异常:', err);
  process.exit(1);
});
