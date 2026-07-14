#!/usr/bin/env node
// 一键 bump 项目所有 4 个版本号 + 可选 latest.json 内容
//
// 用法:
//   node scripts/bump-version.mjs 0.1.2                    只改版本号
//   node scripts/bump-version.mjs 0.1.2 --notes "修 Bug"   同时更新 latest.json 的 notes
//   node scripts/bump-version.mjs patch|minor|major        自动递增
//
// 会同步修改:
//   - package.json                      "version"
//   - src-tauri/Cargo.toml              version = "..."
//   - src-tauri/tauri.conf.json         "version"
//   - latest.json                       "version" / "notes" / 每个 platforms.*.url 里的文件名
//                                       (sha256 需要 build 完再回填，脚本会清空提醒)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const files = {
  pkg:  join(ROOT, 'package.json'),
  cargo: join(ROOT, 'src-tauri', 'Cargo.toml'),
  tauri: join(ROOT, 'src-tauri', 'tauri.conf.json'),
  latest: join(ROOT, 'latest.json'),
};

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('用法: node scripts/bump-version.mjs <版本号|patch|minor|major> [--notes "..."]');
  process.exit(1);
}

const notesIdx = args.indexOf('--notes');
const notes = notesIdx >= 0 ? args[notesIdx + 1] : null;
const target = args[0];

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`版本号格式非法: ${v}`);
  return [+m[1], +m[2], +m[3]];
}

function readCurrent() {
  const pkg = JSON.parse(readFileSync(files.pkg, 'utf8'));
  return pkg.version;
}

function resolveNextVersion(input) {
  if (['patch', 'minor', 'major'].includes(input)) {
    const [ma, mi, pa] = parseSemver(readCurrent());
    if (input === 'major') return `${ma + 1}.0.0`;
    if (input === 'minor') return `${ma}.${mi + 1}.0`;
    return `${ma}.${mi}.${pa + 1}`;
  }
  parseSemver(input); // 校验
  return input;
}

const nextVersion = resolveNextVersion(target);
const oldVersion = readCurrent();

console.log(`版本 ${oldVersion} → ${nextVersion}`);

// ---- package.json ----
{
  const j = JSON.parse(readFileSync(files.pkg, 'utf8'));
  j.version = nextVersion;
  writeFileSync(files.pkg, JSON.stringify(j, null, 2) + '\n');
  console.log('  ✔ package.json');
}

// ---- src-tauri/Cargo.toml ----
{
  const src = readFileSync(files.cargo, 'utf8');
  // 只替换文件顶部 [package] 段里的 version 行,避免误伤依赖版本
  const updated = src.replace(
    /^(version\s*=\s*)"[^"]+"/m,
    `$1"${nextVersion}"`,
  );
  if (updated === src) throw new Error('Cargo.toml 里没找到顶层 version 行');
  writeFileSync(files.cargo, updated);
  console.log('  ✔ src-tauri/Cargo.toml');
}

// ---- src-tauri/tauri.conf.json ----
{
  const j = JSON.parse(readFileSync(files.tauri, 'utf8'));
  j.version = nextVersion;
  writeFileSync(files.tauri, JSON.stringify(j, null, 2) + '\n');
  console.log('  ✔ src-tauri/tauri.conf.json');
}

// ---- latest.json (存在才改) ----
if (existsSync(files.latest)) {
  const j = JSON.parse(readFileSync(files.latest, 'utf8'));
  j.version = nextVersion;
  if (notes !== null) j.notes = notes;
  if (j.platforms && typeof j.platforms === 'object') {
    for (const [key, entry] of Object.entries(j.platforms)) {
      if (entry && typeof entry.url === 'string') {
        entry.url = entry.url.replace(
          new RegExp(oldVersion.replace(/\./g, '\\.'), 'g'),
          nextVersion,
        );
      }
      // sha256 必须 build 完新产物再回填
      if (entry && 'sha256' in entry) entry.sha256 = '';
    }
  }
  writeFileSync(files.latest, JSON.stringify(j, null, 4) + '\n');
  console.log('  ✔ latest.json (sha256 已清空,build 后回填)');
} else {
  console.log('  • latest.json 不存在,跳过');
}

console.log('\n下一步:');
console.log('  1. npm run tauri build');
console.log('  2. 用产物 sha256 回填 latest.json 各平台的 sha256 字段');
console.log(`  3. git commit -am "chore(release): v${nextVersion}"`);
console.log(`  4. git tag v${nextVersion}`);
console.log('  5. installer 和 latest.json 上传雨云');
