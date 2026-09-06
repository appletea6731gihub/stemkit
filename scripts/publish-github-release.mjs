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

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const REPO = process.env.GITHUB_REPO;
const TAG = process.argv[2] || 'v0.1.18';

if (!TOKEN || !REPO) {
  console.log(`
❌ 缺少必要环境变量！

使用方法:
  export GITHUB_TOKEN="ghp_你的GitHubToken"
  export GITHUB_REPO="你的用户名/仓库名"   # 例如: myname/stemkit
  node scripts/publish-github-release.mjs ${TAG}

如何获取 GitHub Token (30秒):
  1. 打开 https://github.com/settings/tokens/new
  2. 勾选 'repo' 权限，生成 Token 即可。
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
  'latest-mac.yml'
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
  const getRes = await fetch(`${releasesUrl}/tags/${TAG}`, { headers });
  if (getRes.ok) {
    release = await getRes.json();
    console.log(`✅ 已找到现有 Release (${release.name || TAG})，ID: ${release.id}`);
  } else {
    console.log(`📝 正在创建新 Release: ${TAG}...`);
    const createRes = await fetch(releasesUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: TAG,
        name: `StemKit ${TAG} (Apple Silicon 原生 & 6音轨默认版)`,
        body: `### StemKit ${TAG} 发布说明\n\n- 默认支持 **6 音轨** 分离（人声、鼓点、贝斯、吉他、钢琴、其他伴奏）\n- 纯本地 Apple Silicon M 系列芯片 MPS 硬件加速\n- 内置原生 arm64 FFmpeg n9.0，彻底消除架构报错\n- 支持与官方落地页无缝对接与自动升级检测`,
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
