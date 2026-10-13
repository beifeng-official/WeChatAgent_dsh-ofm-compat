import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONSERVATIVE_RETRY_POLICY,
  chooseRetryPolicy,
  inheritedPolicyCandidates,
  looksLikeRuntimeDefault,
} from '../src/retry.js';

/** 实测抓到的运行时默认策略：[mode, maxRetries, retryableCodes, initDelay, maxDelay, jitter] */
const RUNTIME_DEFAULT = {
  mode: 'normal',
  maxRetries: 5,
  retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  initialDelayMs: 500,
  maxDelayMs: 10000,
  jitterRatio: 0.1,
};

/** our-free-model 自己声明的策略 */
const UPSTREAM_POLICY = {
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: ['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  initialDelayMs: 700,
  maxDelayMs: 8000,
  jitterRatio: 0.2,
};

test('能识别出运行时默认策略（本轮回归的元凶）', () => {
  assert.equal(looksLikeRuntimeDefault(RUNTIME_DEFAULT), true);
});

test('识别默认策略要求「重试≥5」与「含 RATE_LIMIT」同时成立', () => {
  // 只有次数多、但不把限流当瞬态故障 —— 是合法策略，不该被判为默认
  assert.equal(looksLikeRuntimeDefault({ maxRetries: 5, retryableCodes: ['TIMEOUT'] }), false);
  // 含 RATE_LIMIT 但次数保守 —— 也是合法策略
  assert.equal(looksLikeRuntimeDefault({ maxRetries: 2, retryableCodes: ['RATE_LIMIT'] }), false);
  assert.equal(looksLikeRuntimeDefault(UPSTREAM_POLICY), false);
});

test('非对象输入不判为默认、也不抛错', () => {
  for (const value of [null, undefined, 42, 'x', []]) {
    assert.equal(looksLikeRuntimeDefault(value), false);
  }
});

test('优先继承上游策略，而不是运行时的默认值', () => {
  const picked = chooseRetryPolicy([RUNTIME_DEFAULT, UPSTREAM_POLICY]);
  assert.equal(picked, UPSTREAM_POLICY);
});

test('上游没给策略时退回保守策略（而不是 undefined）', () => {
  assert.equal(chooseRetryPolicy([]), CONSERVATIVE_RETRY_POLICY);
  assert.equal(chooseRetryPolicy([null, undefined, 7]), CONSERVATIVE_RETRY_POLICY);
  assert.equal(chooseRetryPolicy([RUNTIME_DEFAULT]), CONSERVATIVE_RETRY_POLICY);
});

test('保守策略本身不会退化成默认值的取向', () => {
  assert.equal(looksLikeRuntimeDefault(CONSERVATIVE_RETRY_POLICY), false);
  assert.equal(CONSERVATIVE_RETRY_POLICY.retryableCodes.includes('RATE_LIMIT'), false);
  assert.ok(CONSERVATIVE_RETRY_POLICY.maxRetries <= 2);
});

test('保守策略是冻结的，调用方改不动它', () => {
  assert.equal(Object.isFrozen(CONSERVATIVE_RETRY_POLICY), true);
  assert.equal(Object.isFrozen(CONSERVATIVE_RETRY_POLICY.retryableCodes), true);
});

// ── 从 ctx 取候选 ───────────────────────────────────────────────────────────

const fakeLlm = (overrides = {}) => ({
  listProviders: () => [{ id: 'our-free-model' }, { id: 'our-free-model-region' }],
  providerRetryPolicy: () => UPSTREAM_POLICY,
  ...overrides,
});

test('只从确实已注册的 provider 继承策略', () => {
  const candidates = inheritedPolicyCandidates({ llm: fakeLlm(), providers: ['our-free-model', 'not-registered'] });
  assert.equal(candidates.length, 1, '未注册的路由必须跳过 —— 它只会返回「已解析好的默认值」');
  assert.equal(candidates[0], UPSTREAM_POLICY);
});

test('listProviders 抛错时返回空候选（由调用方回退）', () => {
  const llm = fakeLlm({
    listProviders: () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(inheritedPolicyCandidates({ llm, providers: ['our-free-model'] }), []);
});

test('单个 provider 取策略失败不影响其他候选', () => {
  let call = 0;
  const llm = fakeLlm({
    providerRetryPolicy: () => {
      call += 1;
      if (call === 1) throw new Error('nope');
      return UPSTREAM_POLICY;
    },
  });
  const candidates = inheritedPolicyCandidates({ llm, providers: ['our-free-model', 'our-free-model-region'] });
  assert.deepEqual(candidates, [UPSTREAM_POLICY]);
});

test('llm 缺失时安全返回空', () => {
  assert.deepEqual(inheritedPolicyCandidates({ llm: undefined, providers: ['x'] }), []);
  assert.deepEqual(inheritedPolicyCandidates({ llm: null }), []);
});
