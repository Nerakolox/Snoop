#!/usr/bin/env node
// 发版前的产物校验 + SHA256 回填。
//
// 用法:
//   node scripts/verify-release.mjs               校验 + 回填 sha256
//   node scripts/verify-release.mjs --check       仅校验，不改文件（CI 友好）
//
// 做的事:
//   1. 读 latest.json 里每个 platforms.* 条目
//   2. 从 url 字段抽出文件名,在本地已知构建目录里找那个文件
//   3. 找到就算 SHA256:
//        - 条目 sha256 为空 → 回填
//        - 条目 sha256 已有且一致 → 保持
//        - 条目 sha256 已有但对不上 → 报错(可能是文件被换过或 latest.json 陈旧)
//   4. 找不到就报错并汇总,退出码非 0
//
// 存在的意义:
//   bump-version 只改版本号字符串,不检查文件存不存在。Mac 侧 sha256 客户端不校验,
//   更容易发一个 url 指向根本没构建出来的 dmg 的 latest.json。这个脚本就是那道闸。

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LATEST = join(ROOT, 'latest.json');
const BUNDLE_ROOT = join(ROOT, 'src-tauri', 'target');

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');

if (!existsSync(LATEST)) {
  console.error(`× 找不到 ${LATEST}`);
  console.error('  先跑 npm run bump <版本> 生成/更新 latest.json');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(LATEST, 'utf8'));
if (!manifest.platforms || typeof manifest.platforms !== 'object') {
  console.error('× latest.json 里没有 platforms 段');
  process.exit(1);
}

// 一个平台条目可能对应的所有本地路径。按平台 key 展开构建产物在 tauri target
// 里的分布 —— 原生构建走 release/bundle,交叉构建走 <target-triple>/release/bundle。
function candidatePaths(platformKey, filename) {
  const dmgNative  = join(BUNDLE_ROOT, 'release', 'bundle', 'dmg', filename);
  const nsisNative = join(BUNDLE_ROOT, 'release', 'bundle', 'nsis', filename);

  if (platformKey === 'windows-x86_64') {
    return [
      nsisNative,
      join(BUNDLE_ROOT, 'x86_64-pc-windows-msvc', 'release', 'bundle', 'nsis', filename),
    ];
  }
  if (platformKey === 'darwin-x86_64') {
    return [
      dmgNative,
      join(BUNDLE_ROOT, 'x86_64-apple-darwin', 'release', 'bundle', 'dmg', filename),
    ];
  }
  if (platformKey === 'darwin-aarch64') {
    return [
      dmgNative,
      join(BUNDLE_ROOT, 'aarch64-apple-darwin', 'release', 'bundle', 'dmg', filename),
    ];
  }
  return [dmgNative, nsisNative];
}

function sha256Of(path) {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const problems = [];
const mutations = []; // {key, oldSha, newSha}
let changed = false;

console.log(`校验 latest.json (version=${manifest.version})\n`);

for (const [key, entry] of Object.entries(manifest.platforms)) {
  if (!entry || typeof entry.url !== 'string' || entry.url === '') {
    problems.push(`${key}: url 字段缺失或为空`);
    console.log(`  ✘ ${key}: url 缺失`);
    continue;
  }

  // url 字段可能是相对文件名,也可能是完整 URL,取最后一段当文件名
  const filename = basename(entry.url.replace(/[?#].*$/, ''));
  const candidates = candidatePaths(key, filename);
  const found = candidates.find((p) => existsSync(p));

  if (!found) {
    problems.push(`${key}: 找不到本地产物 ${filename}`);
    console.log(`  ✘ ${key}: 找不到 ${filename}`);
    console.log(`      查找过:`);
    for (const p of candidates) console.log(`        - ${p}`);
    continue;
  }

  const size = statSync(found).size;
  const actual = sha256Of(found);
  const existing = typeof entry.sha256 === 'string' ? entry.sha256.toLowerCase() : '';

  if (existing === '') {
    if (!CHECK_ONLY) {
      entry.sha256 = actual;
      changed = true;
      mutations.push({ key, oldSha: '(空)', newSha: actual });
    }
    console.log(`  ✔ ${key}: ${filename} (${humanSize(size)})`);
    console.log(`      sha256 ${CHECK_ONLY ? '待回填' : '已回填'} = ${actual}`);
  } else if (existing === actual.toLowerCase()) {
    console.log(`  ✔ ${key}: ${filename} (${humanSize(size)})`);
    console.log(`      sha256 一致 = ${actual}`);
  } else {
    problems.push(
      `${key}: sha256 不匹配\n    latest.json = ${existing}\n    本地文件    = ${actual}\n    本地文件    = ${found}`,
    );
    console.log(`  ✘ ${key}: sha256 对不上`);
    console.log(`      latest.json = ${existing}`);
    console.log(`      本地文件    = ${actual}`);
    console.log(`      本地文件    = ${found}`);
  }
}

if (changed && !CHECK_ONLY) {
  writeFileSync(LATEST, JSON.stringify(manifest, null, 4) + '\n');
  console.log(`\n已回填 ${mutations.length} 处 sha256 到 latest.json`);
}

console.log('');
if (problems.length > 0) {
  console.error(`× 有 ${problems.length} 个问题:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\n修一下再上传:');
  console.error('  - 缺产物 → 跑对应平台的 npm run tauri build');
  console.error('  - sha 不一致 → 确认本地文件是本次要发的那份,再删掉 latest.json 里的旧 sha256 重跑本脚本');
  process.exit(1);
}

console.log('✓ 所有平台产物齐备,sha256 已核对');
console.log('  下一步: 把 installer/dmg 和 latest.json 上传到雨云 (先包后清单)');
