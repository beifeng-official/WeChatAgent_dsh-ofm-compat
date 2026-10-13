/**
 * `/probe` 的结束原因解析测试。
 *
 * 这组测试存在的直接原因：第一版 probe 把错误读成了 `finish.error`（实际是
 * `reason.failure`），又把成功判成 `kind === 'completed'`（实际是 `'stop'`），
 * 于是诊断工具报了个毫无信息量的 `"error"`。这类「诊断工具自己坏掉」的 bug
 * 必须有测试盯着，否则下次还会犯。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { OK_FINISH_KINDS, interpretFinish } from '../src/probe.js';

test('stop 是成功（不是 completed）', () => {
  const result = interpretFinish({ kind: 'stop' });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'stop');
  assert.equal(result.code, null);
  assert.equal(result.message, null);
});

test('tool-calls 与 max-tokens 也算正常产出', () => {
  assert.equal(interpretFinish({ kind: 'tool-calls' }).ok, true);
  assert.equal(interpretFinish({ kind: 'max-tokens' }).ok, true);
  assert.deepEqual([...OK_FINISH_KINDS], ['stop', 'tool-calls', 'max-tokens']);
});

test('error 从 failure 里取 code 与 message（关键修正）', () => {
  const result = interpretFinish({
    kind: 'error',
    failure: { code: 'ACCOUNT_SIGN_IN_REQUIRED', message: 'Sign in to DeepSeek to use the account provider.' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.equal(result.code, 'ACCOUNT_SIGN_IN_REQUIRED');
  assert.equal(result.message, 'Sign in to DeepSeek to use the account provider.');
});

test('aborted 也带 failure', () => {
  const result = interpretFinish({ kind: 'aborted', failure: { message: 'cancel requested' } });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'aborted');
  assert.equal(result.message, 'cancel requested');
});

test('failure 缺字段时不抛错，退化为 null', () => {
  assert.equal(interpretFinish({ kind: 'error' }).message, null);
  assert.equal(interpretFinish({ kind: 'error', failure: {} }).code, null);
  assert.equal(interpretFinish({ kind: 'error', failure: { code: 0 } }).code, '0');
});

test('没有 finish 分片不算成功', () => {
  for (const value of [null, undefined, {}, { kind: '' }, { kind: 42 }]) {
    const result = interpretFinish(value);
    assert.equal(result.ok, false, `输入 ${JSON.stringify(value)} 不该算成功`);
    assert.equal(result.kind, null);
  }
});

test('未知的 kind 不算成功（合并可扩展，但默认保守）', () => {
  const result = interpretFinish({ kind: 'something-new' });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'something-new');
});

test('非字符串的 code/message 会被转成字符串', () => {
  const result = interpretFinish({ kind: 'error', failure: { code: 429, message: 'rate limited' } });
  assert.equal(result.code, '429');
  assert.equal(typeof result.code, 'string');
});
