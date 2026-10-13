#!/usr/bin/env node
/**
 * dsh-ofm-compat 一键自检。
 *
 * 把「不需要动 DSH 就能验证」的部分全部自动化，分四段：
 *
 *   A. 静态检查   —— 模块能否 import、是否违反设计约束、package.json/补丁文件是否完整
 *   B. 单元与集成 —— 跑 test/ 下的四套测试（进程内、无子进程管道）
 *   C. 环境检查   —— DSH_HOME、目标 profile、依赖是否就位、dsh CLI 能否找到
 *   D. 现场检查   —— 若插件已在运行，读它的 /status（渠道、当前模型、警示）
 *
 * D 段失败不代表有问题：插件还没装、或 DSH 还没重开时它本来就该连不上。
 *
 * 用法：
 *   node scripts/selftest.mjs [--profile desktop] [--port 11231] [--skip-live]
 *
 * 退出码：0 通过 / 1 有失败 / 2 环境问题
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEST_FILES = [
  'test/select.test.mjs',
  'test/lanes.test.mjs',
  'test/failure.test.mjs',
  'test/retry.test.mjs',
  'test/cooldown.test.mjs',
  'test/probe.test.mjs',
  'test/surface.test.mjs',
  'test/plugin.test.mjs',
  'test/contract.test.mjs',
];
const PACKAGE_NAME = 'dsh-ofm-compat';

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' }
  : { r: '', b: '', dim: '', cyan: '', green: '', yellow: '', red: '' };

const results = [];
function record(name, ok, note = '') {
  results.push({ name, ok, note });
  const tag = ok ? `${C.green}PASS${C.r}` : `${C.red}FAIL${C.r}`;
  console.log(`  [${tag}] ${name}${note ? `  ${C.dim}${note}${C.r}` : ''}`);
}
function section(title) {
  console.log(`\n${C.cyan}${C.b}${title}${C.r}`);
}

// ── 参数 ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const profile = argValue('--profile', 'desktop');
const port = Number(argValue('--port', '11231')) || 11231;
const skipLive = argv.includes('--skip-live');
const dshHome = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh');
const profileDir = path.join(dshHome, 'profiles', profile);

// ── A. 静态检查 ──────────────────────────────────────────────────────────────
section('A. 静态检查');

let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  record('package.json 可解析', true, `${pkg.name}@${pkg.version}`);
} catch (error) {
  record('package.json 可解析', false, error.message);
}

record('声明 dsh.bundle（官方安装器的硬性要求）', pkg?.dsh?.bundle?.patch !== undefined, pkg?.dsh?.bundle?.patch ?? '');
record('声明 bin 入口', typeof pkg?.bin?.[PACKAGE_NAME] === 'string', pkg?.bin?.[PACKAGE_NAME] ?? '');
record(
  '不声明 @deepseek-ai/dsh* peerDependency（不受版本闸门限制）',
  !Object.keys(pkg?.peerDependencies ?? {}).some((n) => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-')),
);

try {
  const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
  record('cordis.patch.yml 可读且无 BOM', !patch.startsWith('\uFEFF'));
  record('补丁文件含 insert 块', /-\s*insert:/.test(patch));
} catch (error) {
  record('cordis.patch.yml 可读', false, error.message);
}

const MODULES = ['index.js', 'src/lanes.js', 'src/select.js', 'src/availability.js', 'src/adapter.js', 'src/status.js', 'src/contract.js'];
for (const rel of MODULES) {
  try {
    await import(new URL(`../${rel}`, import.meta.url).href);
    record(`import ${rel}`, true);
  } catch (error) {
    record(`import ${rel}`, false, error.message);
  }
}

// 设计约束：源码里不得有 import/require 指向 @deepseek-ai
let violation = '';
for (const rel of [...MODULES, 'scripts/cli.mjs']) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const match = text.match(/(?:import|require)\s*\(?\s*['"]@deepseek-ai/);
  if (match) violation = `${rel}: ${match[0]}`;
}
record('源码零 @deepseek-ai import/require', violation === '', violation);

// ── B. 测试 ─────────────────────────────────────────────────────────────────
section('B. 单元与集成测试');
let testTotal = 0;
let testFail = 0;
for (const rel of TEST_FILES) {
  const result = spawnSync(process.execPath, [path.join(ROOT, rel)], { stdio: 'inherit', cwd: ROOT });
  if ((result.status ?? 1) !== 0) testFail += 1;
  testTotal += 1;
}
record(`${TEST_FILES.length} 套测试全部通过`, testFail === 0, testFail ? `${testFail} 套失败` : '');

// ── C. 环境检查 ──────────────────────────────────────────────────────────────
section('C. 环境检查');
console.log(`  ${C.dim}DSH_HOME = ${dshHome}${C.r}`);
console.log(`  ${C.dim}profile  = ${profile}  (${profileDir})${C.r}`);

const profileExists = fs.existsSync(profileDir);
record('目标 profile 目录存在', profileExists, profileExists ? '' : '先让 DSH 用它启动过一次');

let bundles = [];
if (profileExists) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    bundles = manifest.dsh?.profile?.bundles ?? [];
    record('profile package.json 可解析', true, `bundles=${bundles.length}`);
  } catch (error) {
    record('profile package.json 可解析', false, error.message);
  }
}
record('our-free-model 已装进该 profile（没有它就没有候选模型）', bundles.includes('dsh-our-free-model') || fs.existsSync(path.join(profileDir, 'node_modules', 'dsh-our-free-model')));
record('本插件已装进该 profile', bundles.includes(PACKAGE_NAME), bundles.includes(PACKAGE_NAME) ? '' : '跑 install 即可');

// 渠道静态分布：直接读真实 catalog，确认白嫖渠道的模型清单拿得到
try {
  const { buildLaneIndex } = await import(new URL('../src/lanes.js', import.meta.url).href);
  const catalogPath = path.join(dshHome, 'our-free-model', 'catalog.json');
  if (fs.existsSync(catalogPath)) {
    const counts = buildLaneIndex(JSON.parse(fs.readFileSync(catalogPath, 'utf8'))).counts;
    record('能读到 our-free-model 的 catalog', true, `eac=${counts.eac} free=${counts.free} kilo=${counts.kilo} unknown=${counts.unknown}`);
  } else {
    record('能读到 our-free-model 的 catalog', false, `缺少 ${catalogPath}（our-free-model 还没在本机跑过）`);
  }
} catch (error) {
  record('渠道静态分布', false, error.message);
}

// ── D. 现场检查 ──────────────────────────────────────────────────────────────
if (!skipLive) {
  section('D. 现场检查（插件是否已在运行）');
  const statusFile = path.join(dshHome, 'ofm-compat', 'status.json');
  let snapshot = null;
  if (fs.existsSync(statusFile)) {
    try {
      snapshot = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      record('状态文件存在', true, statusFile);
    } catch (error) {
      record('状态文件可解析', false, error.message);
    }
  } else {
    record('状态文件存在', false, 'DSH 还没在本 profile 加载过本插件（装完并重开 DSH 才会有）');
  }

  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(3000) });
    snapshot = await response.json();
    record(`/status 可达（127.0.0.1:${port}）`, true);
  } catch {
    record(`/status 可达（127.0.0.1:${port}）`, false, '插件未运行、端口被改，或 statusPort=0');
  }

  if (snapshot) {
    console.log(`\n  ${C.b}现场状态${C.r}`);
    console.log(`    registered      ${snapshot.registered ? `${C.green}是${C.r}` : `${C.red}否${C.r}`}`);
    console.log(`    contract.ok     ${snapshot.contract?.ok ? `${C.green}通过${C.r}` : `${C.red}失败：${(snapshot.contract?.missing ?? []).join('、')}${C.r}`}`);
    console.log(`    advertised      ${snapshot.advertisedCount ?? '?'} 个候选`);
    for (const [lane, info] of Object.entries(snapshot.lanes ?? {})) {
      const color = info.state === 'available' ? C.green : info.state === 'hidden' ? C.yellow : C.dim;
      console.log(`    lane ${lane.padEnd(5)} ${color}${info.state}${C.r}  catalog=${info.catalogCount} advertised=${info.advertisedCount}  ${C.dim}${info.label}${C.r}`);
    }
    console.log(`    current         ${snapshot.current ? `${snapshot.current.model}  (lane=${snapshot.current.lane}, reason=${snapshot.current.reason})` : '（尚未解析）'}`);
    for (const line of snapshot.warnings ?? []) console.log(`    ${C.yellow}警示${C.r}  ${line}`);
  }
}

// ── 总结 ────────────────────────────────────────────────────────────────────
const failed = results.filter((item) => !item.ok);
console.log(`\n${C.b}总结${C.r}  共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length > 0) {
  console.log(`${C.red}未通过项：${C.r}`);
  for (const item of failed) console.log(`  - ${item.name}${item.note ? `  (${item.note})` : ''}`);
}
console.log('');
console.log(`${C.dim}A/B 段必须全绿；C 段里「本插件已装」「our-free-model 已装」在安装前为红属正常；D 段在重开 DSH 前为红属正常。${C.r}`);

process.exit(failed.length === 0 ? 0 : 1);
