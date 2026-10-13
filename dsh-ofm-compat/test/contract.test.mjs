/**
 * 契约自检测试。
 *
 * 本插件刻意不声明 `@deepseek-ai/dsh*` 的 peerDependency（因此不受 DSH 的
 * evaluatePluginCompatibility 版本闸门限制），代价是必须自己在运行时确认
 * 用到的 ctx.llm 方法真的存在。这个文件就是那条保险丝。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../index.js';
import { REQUIRED_LLM_METHODS, OPTIONAL_LLM_METHODS, checkLlmContract } from '../src/contract.js';

function fullLlm() {
  const llm = {};
  for (const name of [...REQUIRED_LLM_METHODS, ...OPTIONAL_LLM_METHODS]) llm[name] = () => undefined;
  llm.listModels = async () => [];
  llm.resolveModelInfo = async () => ({});
  llm.listProviders = () => [];
  llm.registerAdapter = () => {
    const handle = () => {};
    handle.replace = () => {};
    return handle;
  };
  llm.stream = () => (async function* gen() {})();
  return llm;
}

test('完整的 ctx.llm 通过自检', () => {
  const result = checkLlmContract(fullLlm());
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.optionalMissing, []);
  assert.equal(result.reason, '');
});

test('缺少 registerAdapter 时自检失败并指名道姓', () => {
  const llm = fullLlm();
  delete llm.registerAdapter;
  const result = checkLlmContract(llm);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['registerAdapter']);
  assert.match(result.reason, /registerAdapter/);
  assert.match(result.reason, /契约不匹配/);
});

test('缺少多个必需方法时全部列出', () => {
  const llm = fullLlm();
  delete llm.listModels;
  delete llm.stream;
  const result = checkLlmContract(llm);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing.sort(), ['listModels', 'stream']);
});

test('缺少可选方法只记录，不算失败', () => {
  const llm = fullLlm();
  delete llm.imageRequestPricing;
  const result = checkLlmContract(llm);
  assert.equal(result.ok, true);
  assert.deepEqual(result.optionalMissing, ['imageRequestPricing']);
});

test('ctx.llm 不存在时给出可读原因', () => {
  for (const value of [undefined, null]) {
    const result = checkLlmContract(value);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, [...REQUIRED_LLM_METHODS]);
    assert.match(result.reason, /llm 服务/);
  }
});

test('方法存在但不是函数也算缺失', () => {
  const llm = fullLlm();
  llm.stream = 'not a function';
  assert.deepEqual(checkLlmContract(llm).missing, ['stream']);
});

// ── 端到端：ctx.llm 坏掉时插件必须安静降级，而不是拖垮 DSH ───────────────────

test('ctx.llm 不完整时 apply 不抛错、不注册，状态文件如实报告', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-contract-'));
  process.env.DSH_HOME = home;

  let registered = 0;
  const logs = [];
  const ctx = {
    llm: { listProviders: () => [] }, // 故意缺 registerAdapter / listModels / resolveModelInfo / stream
    logger: { warn: (m) => logs.push(m) },
    effect: () => {},
    on: () => {},
  };

  assert.doesNotThrow(() => apply(ctx, { statusPort: 0 }));
  assert.equal(registered, 0);
  assert.equal(logs.some((line) => /契约不匹配/.test(line)), true, '应有一条明确的契约诊断日志');

  const snapshot = JSON.parse(fs.readFileSync(path.join(home, 'ofm-compat', 'status.json'), 'utf8'));
  assert.equal(snapshot.registered, false);
  assert.equal(snapshot.contract.ok, false);
  assert.deepEqual(snapshot.contract.missing.sort(), ['listModels', 'registerAdapter', 'resolveModelInfo', 'stream']);

  delete process.env.DSH_HOME;
});

test('ctx.llm 完整时 apply 正常注册且状态报告 ok', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-contract-'));
  process.env.DSH_HOME = home;

  const registeredRoutes = [];
  const llm = fullLlm();
  llm.registerAdapter = (routes) => {
    registeredRoutes.push(...routes);
    const handle = () => {};
    handle.replace = () => {};
    return handle;
  };
  const ctx = { llm, logger: { warn: () => {} }, effect: () => {}, on: () => {} };

  apply(ctx, { statusPort: 0 });
  assert.deepEqual(registeredRoutes, ['wechatagent-free']);

  const snapshot = JSON.parse(fs.readFileSync(path.join(home, 'ofm-compat', 'status.json'), 'utf8'));
  assert.equal(snapshot.registered, true);
  assert.equal(snapshot.contract.ok, true);

  delete process.env.DSH_HOME;
});
