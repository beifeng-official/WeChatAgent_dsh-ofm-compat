/**
 * 依赖面守卫。
 *
 * 这个文件回答一个具体问题：**WeChatAgent 改接口之后，本插件还能不能用？**
 *
 * 结论是「不会坏」，理由是它压根不依赖 WeChatAgent 的代码 —— 只在文案里提到那个名字。
 * 但「结论」会随着后续提交腐化：某天有人顺手 `import` 一个 WeChatAgent 的模块，
 * 或者换掉内核服务名，这个性质就悄悄没了。
 *
 * 所以这里用测试把依赖面钉死：
 *   ① 只允许 Node 内置模块与自身相对模块；
 *   ② 只允许 4 个 ctx 服务（llm / effect / on / logger）；
 *   ③ 绝不 import 任何 WeChatAgent 相关模块；
 *   ④ 全项目只有 status.js 会写文件（插件绝不改别人的东西）。
 *
 * 任何一条被破坏，这里立刻红。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCES = [
  'index.js',
  'src/adapter.js',
  'src/availability.js',
  'src/contract.js',
  'src/failure.js',
  'src/lanes.js',
  'src/probe.js',
  'src/select.js',
  'src/status.js',
];

/** 允许依赖的 Node 内置模块 —— 加新的一行都要先想清楚为什么。 */
const ALLOWED_BUILTINS = new Set(['node:fs', 'node:os', 'node:path', 'node:http']);

/** 允许使用的内核服务 —— 这就是本插件对 DSH 的全部依赖。 */
const ALLOWED_CTX = new Set(['ctx.llm', 'ctx.effect', 'ctx.on', 'ctx.logger']);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('① 外部依赖只有白名单里的 Node 内置模块', () => {
  const offenders = [];
  for (const rel of SOURCES) {
    for (const match of read(rel).matchAll(/import\s+[^;]*?from\s+['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      if (spec.startsWith('.')) continue;
      if (ALLOWED_BUILTINS.has(spec)) continue;
      offenders.push(`${rel} → ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], `出现未列入白名单的依赖：\n${offenders.join('\n')}`);
});

test('①b 没有任何 require()（插件是纯 ESM）', () => {
  const offenders = [];
  for (const rel of SOURCES) {
    const text = read(rel).replace(/^\s*(\*|\/\/).*$/gm, ''); // 剥掉注释行
    if (/(?:^|[^\w.])require\s*\(/.test(text)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `这些文件里有 require()：${offenders.join(', ')}`);
});

test('② 只使用 4 个白名单 ctx 服务', () => {
  const used = new Map();
  for (const rel of SOURCES) {
    for (const match of read(rel).matchAll(/ctx\.[A-Za-z_$][\w$]*/g)) {
      used.set(match[0], (used.get(match[0]) ?? 0) + 1);
    }
  }
  const unexpected = [...used.keys()].filter((name) => !ALLOWED_CTX.has(name));
  assert.deepEqual(
    unexpected,
    [],
    `出现了未列入白名单的 ctx 服务：${unexpected.join(', ')}。` +
      '新增服务等于扩大对内核的依赖面，需要同时更新 src/contract.js 的自检与本文档。',
  );
  // 反向检查：白名单里的服务确实在被用，避免文档与代码脱节
  for (const name of ALLOWED_CTX) {
    assert.equal(used.has(name), true, `${name} 在代码里已不再使用，请从白名单移除`);
  }
});

test('③ 绝不 import 任何 WeChatAgent 相关模块', () => {
  const banned = /wechatagent|wechat-|qq-bridge|social-bridge|native-context|dsh-social/i;
  const offenders = [];
  for (const rel of SOURCES) {
    for (const match of read(rel).matchAll(/import\s+[^;]*?from\s+['"]([^'"]+)['"]/g)) {
      if (banned.test(match[1])) offenders.push(`${rel} → ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, [], `插件不得依赖 WeChatAgent 的模块：\n${offenders.join('\n')}`);
});

test('③b 也不 import 任何 @deepseek-ai/* 包（不锁内核版本）', () => {
  const offenders = [];
  for (const rel of SOURCES) {
    for (const match of read(rel).matchAll(/import\s+[^;]*?from\s+['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('@deepseek-ai/')) offenders.push(`${rel} → ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, [], `不得直接依赖内核包：\n${offenders.join('\n')}`);
});

test('④ 全项目只有 status.js 会写文件（插件不改别人的东西）', () => {
  const writers = SOURCES.filter((rel) => /(writeFileSync|mkdirSync|renameSync|unlinkSync|copyFileSync|createWriteStream)/.test(read(rel)));
  assert.deepEqual(writers, ['src/status.js'], `除了状态文件，插件不该写任何东西；实际写入者：${writers.join(', ')}`);
});

test('④b 插件写入路径只落在自己的目录下', () => {
  const status = read('src/status.js');
  // writeStatusFile 的调用方传入的路径由 index.js 决定，这里检查默认值形态
  const index = read('index.js');
  const match = index.match(/config\.statusFile\s*\|\|\s*`([^`]+)`/);
  assert.ok(match, 'index.js 里应能定位到状态文件的默认路径');
  assert.match(match[1], /ofm-compat/, '状态文件默认路径必须在 ofm-compat 目录下');
});

test('依赖面清单与 README 描述一致（防止文档腐化）', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  for (const name of ALLOWED_CTX) {
    assert.match(readme, new RegExp(name.replace('.', '\\.')), `README 应说明用到了 ${name}`);
  }
  assert.match(readme, /不依赖 WeChatAgent|零引用|不 import/, 'README 应说明与 WeChatAgent 的解耦关系');
});
