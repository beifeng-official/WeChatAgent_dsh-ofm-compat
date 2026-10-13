/**
 * 失败归因测试。
 *
 * 固件全部来自实测：
 *   · EAC 未授权 → { code: 'AUTHORIZATION_REQUIRED', detail: '需要 GitHub 授权：…star 仓库…' }
 *   · 地区封锁   → { message: 'This model is not available in your country' }
 *   · 账号未登录 → { code: 'ACCOUNT_SIGN_IN_REQUIRED', message: 'Sign in to DeepSeek to use the account provider…' }
 *
 * 前两条必须触发冷却，第三条**必须不触发** —— 账号问题是宿主的事，怪到模型头上
 * 只会让选型乱跳。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { LANE_FAILURE_CODES, classifyFailure, explainFailure } from '../src/failure.js';

test('EAC 未授权（实测原文）判定为渠道级', () => {
  const verdict = classifyFailure({
    code: 'AUTHORIZATION_REQUIRED',
    message: '需要 GitHub 授权：请在插件设置页用 GitHub 登录，并 star 仓库后使用 EAC 模型',
  });
  assert.equal(verdict.scope, 'lane');
  assert.equal(verdict.code, 'AUTHORIZATION_REQUIRED');
  assert.match(verdict.reason, /^(code:|keyword:)/);
});

test('渠道级错误码表覆盖常见授权失败', () => {
  for (const code of LANE_FAILURE_CODES) {
    assert.equal(classifyFailure({ code }).scope, 'lane', `${code} 应判定为渠道级`);
  }
});

test('错误码大小写不敏感', () => {
  assert.equal(classifyFailure({ code: 'authorization_required' }).scope, 'lane');
});

test('没有错误码时靠关键词兜底：GitHub / 授权 / 登录 / star', () => {
  assert.equal(classifyFailure({ message: 'Please sign in with GitHub first' }).scope, 'lane');
  assert.equal(classifyFailure({ message: '请先用 GitHub 登录' }).scope, 'lane');
  assert.equal(classifyFailure({ message: '需要授权后才能使用' }).scope, 'lane');
  assert.equal(classifyFailure({ message: 'You must star the repo to use EAC models' }).scope, 'lane');
});

test('地区封锁与弃用判定为模型级', () => {
  assert.equal(classifyFailure({ message: 'This model is not available in your country' }).scope, 'model');
  assert.equal(classifyFailure({ message: 'Model exo-free has been deprecated.' }).scope, 'model');
  assert.equal(classifyFailure({ message: "OpenCode's free tier can only be used from within OpenCode." }).scope, 'model');
  assert.equal(classifyFailure({ message: 'Upstream request failed: Model is unavailable.' }).scope, 'model');
  assert.equal(classifyFailure({ message: '该模型不可用' }).scope, 'model');
});

test('账号未登录必须判定为 none（不能怪模型）', () => {
  const verdict = classifyFailure({
    code: 'ACCOUNT_SIGN_IN_REQUIRED',
    message: 'Sign in to DeepSeek to use the account provider. The request destination must allow account authentication.',
  });
  assert.equal(verdict.scope, 'none');
});

test('参数/网络类错误判定为 none', () => {
  for (const message of [
    'Invalid reasoningEffort for this model',
    'ETIMEDOUT connecting to upstream',
    'SEARCH_MODEL_REQUEST_LIMIT',
    'request_too_large',
    '',
  ]) {
    assert.equal(classifyFailure({ message }).scope, 'none', `${message} 不该触发冷却`);
  }
});

test('缺字段不抛错', () => {
  assert.doesNotThrow(() => classifyFailure());
  assert.doesNotThrow(() => classifyFailure(null));
  assert.equal(classifyFailure().scope, 'none');
  assert.equal(classifyFailure({ code: 42 }).code, '42');
});

test('渠道级说明里给出可执行的修复方向', () => {
  const verdict = classifyFailure({ code: 'AUTHORIZATION_REQUIRED', message: '需要 GitHub 授权' });
  const text = explainFailure(verdict, 'eac');
  assert.match(text, /eac/);
  assert.match(text, /GitHub/);
  assert.match(text, /star/);
});

test('模型级说明指出只排除该模型', () => {
  const text = explainFailure(classifyFailure({ message: 'not available in your country' }), 'free');
  assert.match(text, /仅该模型/);
});

test('none 不产生说明', () => {
  assert.equal(explainFailure(classifyFailure({ code: 'ACCOUNT_SIGN_IN_REQUIRED' }), 'eac'), null);
  assert.equal(explainFailure(null, 'eac'), null);
});
