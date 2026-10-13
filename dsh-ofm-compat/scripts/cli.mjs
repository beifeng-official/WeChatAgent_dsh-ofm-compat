#!/usr/bin/env node
/**
 * dsh-ofm-compat 的命令行工具 —— 一键安装 / 卸载 / 体检。
 *
 * 设计原则：**优先复用 DSH 官方的 `dsh plugin` 命令**，而不是自己手改 profile。
 * 官方的安装路径（@deepseek-ai/dsh-plugin-manager）会：
 *   · 用 pnpm 安装包；
 *   · 自动把包名加进 profile 的 `dsh.profile.bundles`；
 *   · 要求包声明 `dsh.bundle`，否则以 `not-bundle` 拒绝；
 *   · 安装失败 / 被取消 / 没有 bundle 时**回滚** package.json 与 pnpm-lock.yaml；
 *   · 处理 pnpm 构建脚本审批、原子写清单、与其他操作的锁竞争。
 * 这些都不是我该重新实现的，所以本 CLI 只在找不到 `dsh` 时才退回手工路径。
 *
 * 用法：
 *   dsh-ofm-compat install   [--profile desktop] [--spec <spec>] [--dsh-home <dir>] [--dry-run]
 *   dsh-ofm-compat uninstall [--profile desktop] [--dsh-home <dir>] [--dry-run]
 *   dsh-ofm-compat status    [--port 11231]
 *   dsh-ofm-compat doctor    [--profile desktop]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'dsh-ofm-compat';
const DEFAULT_PROFILE = 'desktop';
const SELF_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' }
  : { r: '', b: '', dim: '', cyan: '', green: '', yellow: '', red: '' };

const say = (m) => console.log(`${C.cyan}==>${C.r} ${m}`);
const ok = (m) => console.log(`  ${C.green}OK${C.r}  ${m}`);
const warn = (m) => console.log(`  ${C.yellow}!!${C.r}  ${m}`);
const err = (m) => console.log(`  ${C.red}XX${C.r}  ${m}`);

// ── 参数解析 ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { command: argv[0] ?? 'help', profile: DEFAULT_PROFILE, spec: '', dshHome: '', dryRun: false, forceManual: false, port: 11231 };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] ?? '';
    if (arg === '--profile') out.profile = next() || DEFAULT_PROFILE;
    else if (arg === '--spec') out.spec = next();
    else if (arg === '--dsh-home') out.dshHome = next();
    else if (arg === '--port') out.port = Number(next()) || 11231;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--force-manual') out.forceManual = true;
    else if (arg === '--help' || arg === '-h') out.command = 'help';
    else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);
  }
  return out;
}

// ── 环境定位 ─────────────────────────────────────────────────────────────────

function resolveDshHome(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME);
  return path.join(os.homedir(), '.dsh');
}

function resolveProfileDir(home, profile) {
  return path.join(home, 'profiles', profile.toLowerCase() === 'desktop' ? 'desktop' : profile);
}

/** 找一个能用的 dsh CLI。找不到就退回手工路径。 */
function findDshCli() {
  const candidates = [];
  const isWin = process.platform === 'win32';

  // 1) 扫描 PATH —— 刻意不用 spawnSync("where"/"which")：那需要捕获子进程输出，
  //    在受限沙箱里会因管道被禁而 EPERM。扫目录既无副作用也更快。
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of isWin ? ['dsh.cmd', 'dsh.exe', 'dsh.bat', 'dsh'] : ['dsh']) {
      candidates.push(path.join(dir, name));
    }
  }

  // 2) 全局 npm / pnpm
  const appData = process.env.APPDATA ?? '';
  const localAppData = process.env.LOCALAPPDATA ?? '';
  candidates.push(
    path.join(appData, 'npm', 'dsh.cmd'),
    path.join(localAppData, 'pnpm', 'dsh.cmd'),
    path.join(appData, 'npm', 'dsh'),
    '/usr/local/bin/dsh',
    '/opt/homebrew/bin/dsh',
  );

  // 3) 典型解包目录
  const roots = [
    path.join(os.homedir(), 'dsh-0.2.0-rc.2'),
    path.join(localAppData, 'Programs', 'DeepSeek Harness'),
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'DeepSeek Harness') : '',
    '/Applications/DeepSeek Harness.app/Contents/Resources/app',
  ].filter(Boolean);
  for (const root of roots) {
    candidates.push(
      path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'dist', 'bin.js'),
    );
  }

  // 4) WeChatAgent 自带运行时
  const runtimes = path.join(appData, 'WeChatAgent', 'runtimes');
  if (appData && fs.existsSync(runtimes)) {
    for (const entry of fs.readdirSync(runtimes, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      candidates.push(
        path.join(runtimes, entry.name, 'dsh', 'resources', 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
        path.join(runtimes, entry.name, 'dsh', 'resources', 'runtime', 'cli', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      );
    }
  }

  return candidates.find((file) => {
    if (!file) return false;
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  }) ?? '';
}

// ── 官方路径 ─────────────────────────────────────────────────────────────────

function runOfficial({ dshCli, profile, verb, target, dryRun }) {
  const args = dshCli.endsWith('.js') ? [dshCli, 'plugin'] : ['plugin'];
  const full = [...args, '--profile', profile, verb, target];
  say(`官方路径：${dshCli.endsWith('.js') ? 'node ' : ''}${full.join(' ')}`);
  if (dryRun) return 0;
  const result = spawnSync(dshCli.endsWith('.js') ? process.execPath : dshCli, full, { stdio: 'inherit' });
  return result.status ?? 1;
}

// ── 手工兜底路径 ─────────────────────────────────────────────────────────────

function writeJsonNoBom(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
}

function runManual({ profileDir, verb, target, dryRun }) {
  warn('手工路径：pnpm + 直接改 package.json（仅在官方 CLI 不可用时使用）');
  const manifestPath = path.join(profileDir, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    err(`缺少 ${manifestPath}`);
    return 1;
  }
  const backup = `${manifestPath}.bak-ofm-compat`;
  if (!fs.existsSync(backup) && !dryRun) {
    fs.copyFileSync(manifestPath, backup);
    ok(`已备份 package.json -> ${path.basename(backup)}`);
  }

  if (verb === 'add') {
    say(`pnpm add ${target}`);
    if (dryRun) {
      // 空转
    } else {
      const result = spawnSync('pnpm', ['add', target], { cwd: profileDir, stdio: 'inherit', shell: process.platform === 'win32' });
      if ((result.status ?? 1) !== 0) {
        err(`pnpm add 失败（退出码 ${result.status}）`);
        return 1;
      }
    }
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.dsh = manifest.dsh ?? {};
  manifest.dsh.profile = manifest.dsh.profile ?? {};
  let bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
  if (verb === 'add') {
    if (!bundles.includes(PACKAGE_NAME)) bundles = [...bundles, PACKAGE_NAME];
  } else {
    bundles = bundles.filter((name) => name !== PACKAGE_NAME);
    if (manifest.dependencies) delete manifest.dependencies[PACKAGE_NAME];
  }
  manifest.dsh.profile.bundles = bundles;
  if (!dryRun) {
    writeJsonNoBom(manifestPath, manifest);
    ok('package.json 已更新（UTF-8 无 BOM）');
  }
  return 0;
}

// ── 校验与提示 ───────────────────────────────────────────────────────────────

function verifyBundle(profileDir) {
  const manifestPath = path.join(profileDir, 'package.json');
  if (!fs.existsSync(manifestPath)) return { bundles: false, modules: false };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    err(`package.json 解析失败：${error.message}`);
    return { bundles: false, modules: false };
  }
  return {
    bundles: (manifest.dsh?.profile?.bundles ?? []).includes(PACKAGE_NAME),
    modules: fs.existsSync(path.join(profileDir, 'node_modules', PACKAGE_NAME)),
  };
}

function nextSteps() {
  console.log('');
  console.log(`${C.yellow}下一步（必须做，否则插件不会加载）：${C.r}`);
  console.log('  1) 从 DSH 托盘完整退出并重新打开');
  console.log('  2) WeChatAgent 控制台 → 连接设置 → 模型连接：');
  console.log(`       ${C.b}模型提供方标识${C.r} = wechatagent-free`);
  console.log(`       ${C.b}模型标识${C.r}       = auto`);
  console.log('  3) 工具页 → 准备项目配置 → 重启助手服务');
  console.log('  4) 验证：curl http://127.0.0.1:11231/status');
  console.log('');
}

// ── status / doctor ─────────────────────────────────────────────────────────

async function cmdStatus({ port }) {
  const url = `http://127.0.0.1:${port}/status`;
  say(`读取状态接口 ${url}`);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    console.log(JSON.stringify(body, null, 2));
    return 0;
  } catch (error) {
    err(`连不上：${error.message}`);
    warn('插件可能尚未随 DSH 启动，或 statusPort 被改为 0，或端口被改过。');
    warn('也可以直接看状态文件：%USERPROFILE%\\.dsh\\ofm-compat\\status.json');
    return 1;
  }
}

function cmdDoctor({ profile, dshHome }) {
  say('环境体检');
  const home = resolveDshHome(dshHome);
  const profileDir = resolveProfileDir(home, profile);
  console.log(`  DSH_HOME      ${home}`);
  console.log(`  profile       ${profile}`);
  console.log(`  profile 目录  ${profileDir}  ${fs.existsSync(profileDir) ? `${C.green}存在${C.r}` : `${C.red}缺失${C.r}`}`);

  const dshCli = findDshCli();
  console.log(`  dsh CLI       ${dshCli || `${C.yellow}未找到（将用手工路径）${C.r}`}`);

  const manifestPath = path.join(profileDir, 'package.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const bundles = manifest.dsh?.profile?.bundles ?? [];
    console.log(`  已装 bundles  ${bundles.length} 个`);
    for (const name of [PACKAGE_NAME, 'dsh-our-free-model', 'dsh-social-bridge-plugin']) {
      const installed = bundles.includes(name) || fs.existsSync(path.join(profileDir, 'node_modules', name));
      console.log(`    ${installed ? `${C.green}✓${C.r}` : `${C.red}✗${C.r}`} ${name}${bundles.includes(name) ? ' (bundle 已选)' : ''}`);
    }
    if (!bundles.includes('dsh-our-free-model')) {
      warn('our-free-model 不在这个 profile 里：本插件将没有任何候选模型。');
    }
  }

  const statusFile = path.join(home, 'ofm-compat', 'status.json');
  if (fs.existsSync(statusFile)) {
    const snapshot = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    console.log(`  状态文件      ${statusFile}`);
    console.log(`    插件已注册  ${snapshot.registered ? `${C.green}是${C.r}` : `${C.red}否${C.r}`}`);
    console.log(`    契约自检    ${snapshot.contract?.ok ? `${C.green}通过${C.r}` : `${C.red}失败：${(snapshot.contract?.missing ?? []).join('、')}${C.r}`}`);
    console.log(`    当前模型    ${snapshot.current?.model ?? '（尚未解析）'}`);
  } else {
    warn('还没有状态文件：DSH 尚未在本 profile 加载过本插件。');
  }
  return 0;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

function cmdInstallUninstall(args, verb) {
  const home = resolveDshHome(args.dshHome);
  const profileDir = resolveProfileDir(home, args.profile);
  const target = verb === 'add' ? args.spec || SELF_DIR : PACKAGE_NAME;

  say(`DSH_HOME = ${home}`);
  say(`profile  = ${args.profile}  (${profileDir})`);
  if (!fs.existsSync(profileDir)) {
    err(`profile 目录不存在：${profileDir}`);
    err('先让 DSH 用它启动过一次（例如打开 WeChatAgent），或检查 --profile。');
    return 2;
  }

  const dshCli = findDshCli();
  if (dshCli) ok(`找到 dsh CLI：${dshCli}`);
  else warn('没有找到 dsh CLI，将退回手工 pnpm 方式');

  let exit = 1;
  if (dshCli && !args.forceManual) {
    exit = runOfficial({ dshCli, profile: args.profile, verb, target, dryRun: args.dryRun });
    if (exit !== 0) {
      warn(`官方路径退出码 ${exit}，尝试手工路径…`);
      exit = runManual({ profileDir, verb, target, dryRun: args.dryRun });
    }
  } else {
    exit = runManual({ profileDir, verb, target, dryRun: args.dryRun });
  }

  say('校验安装结果');
  if (args.dryRun) {
    warn('dry-run：没有做任何实际改动，跳过校验');
    return 0;
  }
  const { bundles, modules } = verifyBundle(profileDir);
  if (verb === 'add') {
    if (bundles) ok('bundle 列表已包含 dsh-ofm-compat');
    else {
      err('bundle 列表里没有 dsh-ofm-compat');
      exit = 1;
    }
    if (modules) ok('node_modules 已就位');
    else warn('node_modules 里没有它（本地 link 安装时可能正常）');
    if (exit === 0 && bundles) nextSteps();
    return exit === 0 && bundles ? 0 : 1;
  }

  if (!bundles) ok('卸载完成');
  else {
    err('卸载未完成：bundle 列表里仍有它');
    exit = 1;
  }
  console.log('');
  console.log('接着把 WeChatAgent 的 provider/model 改回原值，并重开 DSH。');
  return exit;
}

function usage() {
  console.log(`${C.b}dsh-ofm-compat${C.r} —— WeChatAgent ↔ our-free-model 兼容包的工具

${C.b}用法${C.r}
  dsh-ofm-compat install   [选项]   安装（默认装当前这份源码）
  dsh-ofm-compat uninstall [选项]   卸载
  dsh-ofm-compat status    [选项]   读取运行状态接口
  dsh-ofm-compat doctor    [选项]   检查 DSH_HOME / profile / 依赖是否就位

${C.b}选项${C.r}
  --profile <名字>   目标 profile（默认 desktop，即 WeChatAgent 用的那个）
  --spec <包规格>    安装来源：本地路径 / 包名 / github:用户/仓库
  --dsh-home <目录>  覆盖 DSH_HOME（默认 ~/.dsh）
  --port <端口>      status 用的端口（默认 11231）
  --dry-run          只打印将要执行的命令
  --force-manual     跳过官方 dsh CLI，直接走 pnpm + 改 JSON
  -h, --help         显示本帮助

${C.b}推荐${C.r}
  优先让本工具调用 DSH 官方的 \`dsh plugin --profile desktop add <包>\`，
  它会自动登记 bundle，并在失败时回滚 package.json 与 pnpm-lock.yaml。
`);
  return 0;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    err(error.message);
    return 2;
  }
  switch (args.command) {
    case 'install':
      return cmdInstallUninstall(args, 'add');
    case 'uninstall':
    case 'remove':
      return cmdInstallUninstall(args, 'remove');
    case 'status':
      return cmdStatus(args);
    case 'doctor':
      return cmdDoctor(args);
    case 'help':
    default:
      return usage();
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  err(error?.stack ?? String(error));
  process.exit(1);
});
