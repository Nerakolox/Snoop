#!/usr/bin/env node
// 生成自更新清单 latest.json：按实际构建产物算 SHA256，供 CD 上传到雨云。
//
// 用法:
//   node scripts/make-release-manifest.mjs \
//     --version 0.2.4 --notes "本次更新说明" \
//     --mac release-assets/Snoop_0.2.4_universal.dmg \
//     --win release-assets/Snoop_0.2.4_x64-setup.exe \
//     --out latest.json
//
//   --mac-universal  文件名被改成 aarch64/x64 的通用包时，强制两个 darwin key 都写
//
// 平台映射规则:
//   - universal dmg（文件名含 universal 或传了 --mac-universal）
//                                        → darwin-aarch64 + darwin-x86_64 指向同一个 URL
//   - aarch64 / arm64 dmg               → 只写 darwin-aarch64
//   - x64 / x86_64 dmg                  → 只写 darwin-x86_64
//   - exe                               → windows-x86_64
// URL 写文件名（客户端会用 UPDATE_BASE_URL 拼出完整地址），和现有 updater.rs 一致。

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

function getArg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const version = getArg('version');
const notes = getArg('notes', '');
const mac = getArg('mac');
const macUniversal = process.argv.includes('--mac-universal');
const win = getArg('win');
const out = getArg('out', 'latest.json');

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('× --version 必须是 x.y.z（不带 v）');
  process.exit(1);
}
if (!mac && !win) {
  console.error('× 至少给一个产物：--mac <dmg> 或 --win <exe>');
  process.exit(1);
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function ensureVersionInName(path) {
  const name = basename(path);
  if (!name.includes(version)) {
    console.error(`× 产物文件名里没有版本号 ${version}: ${name}`);
    console.error('  （多半是 bump 没生效，或拿错了产物）');
    process.exit(1);
  }
  return name;
}

const platforms = {};
const seen = new Set();

function add(key, url, sha) {
  const id = `${key}:${url}`;
  if (seen.has(id)) return;
  seen.add(id);
  platforms[key] = { version, url, sha256: sha };
}

if (mac) {
  const url = ensureVersionInName(mac);
  const sha = await sha256(mac);
  const universal = macUniversal || /universal/i.test(url);
  const arm = /aarch64|arm64/i.test(url);
  const intel = /x86_64|x64|intel/i.test(url);

  if (universal || (!arm && !intel)) {
    add('darwin-aarch64', url, sha);
    add('darwin-x86_64', url, sha);
  } else if (arm) {
    add('darwin-aarch64', url, sha);
  } else {
    add('darwin-x86_64', url, sha);
  }
}

if (win) {
  const url = ensureVersionInName(win);
  add('windows-x86_64', url, await sha256(win));
}

const manifest = { version, notes, platforms };
await writeFile(out, JSON.stringify(manifest, null, 2) + '\n');

console.log(`✔ 已生成 ${out}`);
console.log(`  version: ${version}`);
for (const [key, value] of Object.entries(platforms)) {
  console.log(`  ${key}: ${value.url} (sha256 ${value.sha256.slice(0, 12)}…)`);
}
