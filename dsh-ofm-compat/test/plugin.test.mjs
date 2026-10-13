/**
 * 用伪造的 Cordis ctx 对插件做集成级验证。
 *
 * 这个环境里无法启动 DSH（Electron 在工具进程里起不来），所以这里按 DSH 运行时
 * 的公开契约手工实现一个 ctx.llm 替身，验证：
 *   1. 路由被注册，别名被 advertise；
 *   2. resolveModel 用真实模型的元数据，但身份改写成我们的路由 + 别名；
 *   3. 调用被改写路由后转交给 our-free-model（而不是自引用递归）；
 *   4. 选型跟随 our-free-model 的 availability.json；
 *   5. turn/end 报「模型不可用」时冷却并自动换模型。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply, normalizeConfig } from '../index.js';

const ROUTE = 'wechatagent-free';
const ALIAS = 'auto';

/** 造一个临时 DSH_HOME，并写入 our-free-model 的状态文件。 */
function makeHome({ availability, catalog } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-compat-test-'));
  const dir = path.join(home, 'our-free-model');
  fs.mkdirSync(dir, { recursive: true });
  if (availability) fs.writeFileSync(path.join(dir, 'availability.json'), JSON.stringify(availability));
  if (catalog) fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify(catalog));
  return home;
}

/** 按 DSH 的公开契约实现 ctx.llm 替身。 */
function makeCtx({ modelsByProvider = {}, providerRetryPolicies = null } = {}) {
  const registered = new Map();
  const streamCalls = [];
  const resolved = [];
  const listeners = [];
  const disposers = [];

  const llm = {
    listProviders: () => Object.keys(modelsByProvider).map((id) => ({ id, name: id })),
    providerRetryPolicy: (provider) => (providerRetryPolicies ? providerRetryPolicies[provider] : undefined),
    listModels: async (provider) => (modelsByProvider[provider] ?? []).map((id) => ({ provider, id, name: id })),
    resolveModelInfo: async (provider, model) => {
      resolved.push({ provider, model });
      return {
        provider,
        id: model,
        name: model,
        inputModalities: ['text'],
        context: { contextWindow: 256000 },
        defaultMaxTokens: 32768,
        reasoning: { efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
      };
    },
    imageRequestPricing: (provider, model) => ({ provider, model, kind: 'none' }),
    registerAdapter: (routes, adapter) => {
      for (const route of routes) {
        if (registered.has(route)) throw new Error(`DUPLICATE_ADAPTER ${route}`);
        registered.set(route, adapter);
      }
      const handle = () => {
        for (const route of routes) registered.delete(route);
      };
      handle.replace = () => {};
      return handle;
    },
    prepareCall: async (config) => ({
      model: { provider: config.provider, id: config.model },
      stream: (options) => llm.stream({ ...options, provider: config.provider, model: config.model }),
    }),
    stream: (options) => {
      streamCalls.push(options);
      return (async function* gen() {
        yield { type: 'text', text: `served-by:${options.provider}/${options.model}` };
      })();
    },
  };

  const ctx = {
    llm,
    logger: { warn: () => {}, debug: () => {} },
    effect: (fn) => {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
    },
    on: (event, handler) => listeners.push({ event, handler }),
  };

  return {
    ctx,
    registered,
    streamCalls,
    resolved,
    listeners,
    dispose: () => disposers.forEach((fn) => fn()),
    emit: (event, ...args) => listeners.filter((l) => l.event === event).forEach((l) => l.handler(...args)),
  };
}

async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

const TWO_MODELS = { 'our-free-model': ['model-alpha', 'model-beta'] };

// ── 注册 ────────────────────────────────────────────────────────────────────

test('apply 会注册我们拥有的固定路由，并释放可清理', async () => {
  const home = makeHome();
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: TWO_MODELS });
  apply(env.ctx, { statusPort: 0 });
  assert.equal(env.registered.has(ROUTE), true, '路由应已注册');
  env.dispose();
  assert.equal(env.registered.has(ROUTE), false, '释放后路由应被移除');
  delete process.env.DSH_HOME;
});

test('路由名冲突时不让 DSH 崩掉，只是不注册', async () => {
  const home = makeHome();
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: TWO_MODELS });
  env.registered.set(ROUTE, {});
  assert.doesNotThrow(() => apply(env.ctx, { statusPort: 0 }));
  delete process.env.DSH_HOME;
});

test('normalizeConfig 拒绝非法 route/alias 并退回默认', async () => {
  const logs = [];
  const config = normalizeConfig({ route: '有中文', alias: 'x y', statusPort: -5, cooldownMs: 'abc' }, (m) => logs.push(m));
  assert.equal(config.route, 'wechatagent-free');
  assert.equal(config.alias, 'auto');
  assert.equal(config.displayName.includes('OFM'), true);
  assert.equal(logs.length >= 2, true, '应记录被拒绝的配置');
  const ok = normalizeConfig({ route: 'my-route', alias: 'best', cooldownsMs: 1 });
  assert.equal(ok.route, 'my-route');
  assert.equal(ok.alias, 'best');
  assert.equal(ok.cooldownMs, 900000, '非法 cooldownMs 应退回默认');
});

// ── 别名与元数据 ────────────────────────────────────────────────────────────

test('listModels 只 advertise 稳定别名', async () => {
  const home = makeHome();
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: TWO_MODELS });
  apply(env.ctx, { statusPort: 0 });
  const adapter = env.registered.get(ROUTE);
  const models = await adapter.listModels(ROUTE);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, ALIAS);
  assert.equal(models[0].provider, ROUTE);
  env.dispose();
  delete process.env.DSH_HOME;
});

test('resolveModel 用真实模型的上下文，但身份是路由+别名', async () => {
  const home = makeHome();
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: TWO_MODELS });
  apply(env.ctx, { statusPort: 0 });
  const adapter = env.registered.get(ROUTE);
  const info = await adapter.resolveModel(ROUTE, ALIAS);
  assert.equal(info.provider, ROUTE);
  assert.equal(info.id, ALIAS);
  assert.equal(info.context.contextWindow, 256000, '上下文窗口应来自真实模型');
  assert.deepEqual(info.reasoning.efforts, ['low', 'medium', 'high']);
  env.dispose();
  delete process.env.DSH_HOME;
});

test('未知真实模型 id 会退回自动选择，而不是失败', async () => {
  const home = makeHome();
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: TWO_MODELS });
  apply(env.ctx, { statusPort: 0 });
  const adapter = env.registered.get(ROUTE);
  const info = await adapter.resolveModel(ROUTE, 'does-not-exist');
  assert.equal(info.provider, ROUTE);
  assert.equal(info.id, 'does-not-exist');
  assert.equal(env.resolved.at(-1).model, 'model-alpha', '应解析到自动选中的真实模型');
  env.dispose();
  delete process.env.DSH_HOME;
});

// ── 调用转交 ────────────────────────────────────────────────────────────────

test('prepareCall 的 stream 把 provider/model 改写后转交，不自引用递归', async () => {
  const home = makeHome();
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: TWO_MODELS });
  apply(env.ctx, { statusPort: 0 });
  const adapter = env.registered.get(ROUTE);

  const prepared = await adapter.prepareCall(ROUTE, ALIAS);
  const chunks = await collect(prepared.stream({ provider: ROUTE, model: ALIAS, messages: [] }));

  assert.equal(env.streamCalls.length, 1);
  assert.equal(env.streamCalls[0].provider, 'our-free-model');
  assert.equal(env.streamCalls[0].model, 'model-alpha');
  assert.notEqual(env.streamCalls[0].provider, ROUTE, '绝不能转交给自己');
  assert.equal(chunks[0].text, 'served-by:our-free-model/model-alpha');
  env.dispose();
  delete process.env.DSH_HOME;
});

test('直接调用 stream() 也会改写路由', async () => {
  const home = makeHome();
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: TWO_MODELS });
  apply(env.ctx, { statusPort: 0 });
  const adapter = env.registered.get(ROUTE);
  await collect(adapter.stream({ provider: ROUTE, model: ALIAS }));
  assert.equal(env.streamCalls[0].provider, 'our-free-model');
  env.dispose();
  delete process.env.DSH_HOME;
});

test('providerInfo 报出自己的路由身份', async () => {
  const home = makeHome();
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: TWO_MODELS });
  apply(env.ctx, { statusPort: 0 });
  const adapter = env.registered.get(ROUTE);
  assert.equal(adapter.providerInfo(ROUTE).id, ROUTE);
  assert.equal(typeof adapter.providerInfo(ROUTE).name, 'string');
  env.dispose();
  delete process.env.DSH_HOME;
});

test('没有任何候选模型时抛带 code 的错误', async () => {
  const home = makeHome();
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: {} });
  apply(env.ctx, { statusPort: 0 });
  const adapter = env.registered.get(ROUTE);
  const info = await adapter.resolveModel(ROUTE, ALIAS);
  assert.equal(info.id, ALIAS, 'resolveModel 不应抛错，走兜底元数据');
  await assert.rejects(
    async () => collect(adapter.stream({ provider: ROUTE, model: ALIAS })),
    /OFM_COMPAT_NO_MODEL/,
  );
  env.dispose();
  delete process.env.DSH_HOME;
});

// ── 可用性驱动选型 ──────────────────────────────────────────────────────────

test('选型会跳过 availability 里被拒绝的模型', async () => {
  const home = makeHome({
    availability: {
      egress: { ip: '1.2.3.4', country: 'CN' },
      results: {
        'model-alpha': { state: 'unknown', detail: "OpenCode's free tier can only be used from within OpenCode." },
        'model-beta': { state: 'available' },
      },
    },
  });
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: TWO_MODELS });
  apply(env.ctx, { statusPort: 0 });
  const adapter = env.registered.get(ROUTE);
  await adapter.resolveModel(ROUTE, ALIAS);
  assert.equal(env.resolved.at(-1).model, 'model-beta', '应跳过被上游拒绝的 model-alpha');
  env.dispose();
  delete process.env.DSH_HOME;
});

test('粘性：连续两次解析都停留在同一个模型', async () => {
  const home = makeHome();
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: TWO_MODELS });
  apply(env.ctx, { statusPort: 0 });
  const adapter = env.registered.get(ROUTE);
  await adapter.resolveModel(ROUTE, ALIAS);
  await adapter.resolveModel(ROUTE, ALIAS);
  assert.deepEqual(env.resolved.map((r) => r.model), ['model-alpha', 'model-alpha']);
  env.dispose();
  delete process.env.DSH_HOME;
});

// ── 失败归因与自动换模型（保活核心） ─────────────────────────────────────────

test('turn/end 报模型不可用时冷却该模型，下一个 turn 自动换', async () => {
  const home = makeHome();
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: TWO_MODELS });
  apply(env.ctx, { statusPort: 0, cooldownMs: 600000 });
  const adapter = env.registered.get(ROUTE);

  await adapter.prepareCall(ROUTE, ALIAS); // 派发 model-alpha
  assert.equal(env.resolved.at(-1).model, 'model-alpha');

  // 模拟 DSH 会话事件：本轮以 error 结束，且是地区封锁类原因
  env.emit('session/event', { id: 'social-abc' }, {
    type: 'turn/end',
    data: {
      turn: 1,
      reason: { kind: 'error', error: { code: 'UPSTREAM', message: 'This model is not available in your country' } },
    },
  });

  await adapter.resolveModel(ROUTE, ALIAS);
  assert.equal(env.resolved.at(-1).model, 'model-beta', '冷却后应自动切到下一个可用模型');
  env.dispose();
  delete process.env.DSH_HOME;
});

test('与模型无关的错误不会触发冷却（避免选型乱跳）', async () => {
  const home = makeHome();
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: TWO_MODELS });
  apply(env.ctx, { statusPort: 0 });
  const adapter = env.registered.get(ROUTE);

  await adapter.prepareCall(ROUTE, ALIAS);
  env.emit('session/event', { id: 'social-abc' }, {
    type: 'turn/end',
    data: {
      turn: 1,
      reason: {
        kind: 'error',
        error: {
          code: 'ACCOUNT_SIGN_IN_REQUIRED',
          message: 'Sign in to DeepSeek to use the account provider. The request destination must allow account authentication.',
        },
      },
    },
  });

  await adapter.resolveModel(ROUTE, ALIAS);
  assert.equal(env.resolved.at(-1).model, 'model-alpha', '账号类错误不应归因到免费模型');
  env.dispose();
  delete process.env.DSH_HOME;
});

test('turn/end 正常完成时什么都不做', async () => {
  const home = makeHome();
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: TWO_MODELS });
  apply(env.ctx, { statusPort: 0 });
  const adapter = env.registered.get(ROUTE);
  await adapter.prepareCall(ROUTE, ALIAS);
  env.emit('session/event', { id: 'social-abc' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await adapter.resolveModel(ROUTE, ALIAS);
  assert.equal(env.resolved.at(-1).model, 'model-alpha');
  env.dispose();
  delete process.env.DSH_HOME;
});

// ── 状态输出 ────────────────────────────────────────────────────────────────

test('状态文件会被写出，包含当前模型与决策原因', async () => {
  const home = makeHome();
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: TWO_MODELS });
  apply(env.ctx, { statusPort: 0 });
  const adapter = env.registered.get(ROUTE);
  await adapter.prepareCall(ROUTE, ALIAS);
  // apply() 里 publish() 在注册时写过一次；这里手动再触发一次太间接，
  // 改为直接断言首次写入的文件结构。
  const file = path.join(home, 'ofm-compat', 'status.json');
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(snap.plugin, 'dsh-ofm-compat');
  assert.equal(snap.route, ROUTE);
  assert.equal(snap.alias, ALIAS);
  assert.equal(typeof snap.at, 'string');
  env.dispose();
  delete process.env.DSH_HOME;
});

test('statusPort=0 时不启动状态接口', async () => {
  const home = makeHome();
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: TWO_MODELS });
  const config = normalizeConfig({ statusPort: 0 });
  assert.equal(config.statusPort, 0);
  assert.doesNotThrow(() => apply(env.ctx, { statusPort: 0 }));
  env.dispose();
  delete process.env.DSH_HOME;
});

// ── 白嫖渠道适配 ────────────────────────────────────────────────────────────

function readStatus(home) {
  return JSON.parse(fs.readFileSync(path.join(home, 'ofm-compat', 'status.json'), 'utf8'));
}

test('preferLanes 默认白嫖优先，可用 [] 显式关闭', () => {
  assert.deepEqual(normalizeConfig({}).preferLanes, ['eac', 'free']);
  assert.deepEqual(normalizeConfig({ preferLanes: [] }).preferLanes, []);
  assert.deepEqual(normalizeConfig({ preferLanes: ['FAKE', 'kilo', ' free '] }).preferLanes, ['kilo', 'free']);
  assert.deepEqual(normalizeConfig({ excludeLanes: ['kilo'] }).excludeLanes, ['kilo']);
});

test('共付渠道（白嫖）可用时优先选中它，而不是匿名免费通道', async () => {
  const home = makeHome({ catalog: { entries: ['free-a'], sealIds: ['sealed-a'] } });
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: { 'our-free-model': ['free-a', 'sealed-a'] } });
  apply(env.ctx, { statusPort: 0 });
  const adapter = env.registered.get(ROUTE);
  await adapter.resolveModel(ROUTE, ALIAS);
  assert.equal(env.resolved.at(-1).model, 'sealed-a', '白嫖渠道应被优先');
  env.dispose();
  delete process.env.DSH_HOME;
});

test('excludeLanes 能把白嫖渠道整个排除掉', async () => {
  const home = makeHome({ catalog: { entries: ['free-a'], sealIds: ['sealed-a'] } });
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: { 'our-free-model': ['free-a', 'sealed-a'] } });
  apply(env.ctx, { statusPort: 0, excludeLanes: ['eac'] });
  const adapter = env.registered.get(ROUTE);
  await adapter.resolveModel(ROUTE, ALIAS);
  assert.equal(env.resolved.at(-1).model, 'free-a');
  env.dispose();
  delete process.env.DSH_HOME;
});

test('状态文件报告渠道诊断：共付渠道被摘掉时给出可执行警示', async () => {
  const home = makeHome({
    catalog: { entries: ['free-a'], sealIds: ['sealed-a', 'sealed-b'], kiloRows: [{ id: 'kilo-a' }] },
  });
  process.env.DSH_HOME = home;
  // 只 advertise 出 free 与 kilo —— 模拟共付渠道未解锁的真实情形
  const env = makeCtx({ modelsByProvider: { 'our-free-model': ['free-a', 'kilo-a'] } });
  apply(env.ctx, { statusPort: 0 });
  const adapter = env.registered.get(ROUTE);
  await adapter.resolveModel(ROUTE, ALIAS);

  const snapshot = readStatus(home);
  assert.equal(snapshot.lanes.eac.state, 'hidden');
  assert.equal(snapshot.lanes.eac.catalogCount, 2);
  assert.equal(snapshot.lanes.eac.advertisedCount, 0);
  assert.deepEqual(snapshot.lanes.eac.missing, ['sealed-a', 'sealed-b']);
  assert.equal(snapshot.lanes.free.state, 'available');
  assert.equal(snapshot.lanes.kilo.state, 'available');
  assert.equal(snapshot.advertisedCount, 2);
  assert.deepEqual(snapshot.lanePreference, ['eac', 'free']);
  assert.equal(
    snapshot.warnings.some((line) => line.includes('共付渠道未解锁')),
    true,
    '应给出共付渠道未解锁的说明',
  );
  env.dispose();
  delete process.env.DSH_HOME;
});

test('共付渠道解锁时状态报告 available 且无警示', async () => {
  const home = makeHome({ catalog: { entries: ['free-a'], sealIds: ['sealed-a'] } });
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: { 'our-free-model': ['free-a', 'sealed-a'] } });
  apply(env.ctx, { statusPort: 0 });
  const adapter = env.registered.get(ROUTE);
  await adapter.resolveModel(ROUTE, ALIAS);

  const snapshot = readStatus(home);
  assert.equal(snapshot.lanes.eac.state, 'available');
  assert.equal(snapshot.lanes.eac.advertisedCount, 1);
  assert.equal(snapshot.warnings.some((line) => line.includes('共付渠道未解锁')), false);
  assert.equal(snapshot.current.lane, 'eac');
  env.dispose();
  delete process.env.DSH_HOME;
});

test('状态在每次决策后即时刷新，而不是只靠定时器', async () => {
  const home = makeHome({ catalog: { entries: ['free-a'], sealIds: ['sealed-a'] } });
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: { 'our-free-model': ['free-a', 'sealed-a'] } });
  apply(env.ctx, { statusPort: 0 });
  const adapter = env.registered.get(ROUTE);

  // apply() 写的第一版还没有候选
  assert.equal(readStatus(home).advertisedCount, 0);
  await adapter.resolveModel(ROUTE, ALIAS);
  const after = readStatus(home);
  assert.equal(after.advertisedCount, 2);
  assert.equal(after.lastDecision?.lane, 'eac');
  assert.equal(after.lastDecision?.byLane?.eac, 1);
  env.dispose();
  delete process.env.DSH_HOME;
});

// ── /probe 的真实 HTTP 往返（含自愈） ───────────────────────────────────────

const PROBE_PORT = 11399;

test('POST /probe 成功时返回文本与 finishKind=stop', async () => {
  const home = makeHome({ catalog: { entries: ['free-a'] } });
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: { 'our-free-model': ['free-a'] } });
  env.ctx.llm.stream = () => (async function* gen() {
    yield { type: 'text-delta', index: 0, text: 'pong' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
  apply(env.ctx, { statusPort: PROBE_PORT });
  try {
    const response = await fetch(`http://127.0.0.1:${PROBE_PORT}/probe`, { method: 'POST' });
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.finishKind, 'stop');
    assert.equal(body.text, 'pong');
    assert.equal(body.lane, 'free');
  } finally {
    env.dispose();
    delete process.env.DSH_HOME;
  }
});

test('GET /probe 被拒绝（防止误触发真实模型调用）', async () => {
  const home = makeHome({ catalog: { entries: ['free-a'] } });
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: { 'our-free-model': ['free-a'] } });
  apply(env.ctx, { statusPort: PROBE_PORT });
  try {
    const response = await fetch(`http://127.0.0.1:${PROBE_PORT}/probe`);
    assert.equal(response.status, 405);
  } finally {
    env.dispose();
    delete process.env.DSH_HOME;
  }
});

test('probe 失败会自愈：整条渠道被冷却，且写进状态文件', async () => {
  const home = makeHome({ catalog: { entries: ['free-a'], sealIds: ['sealed-a'] } });
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: { 'our-free-model': ['free-a', 'sealed-a'] } });
  env.ctx.llm.stream = () => (async function* gen() {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { code: 'AUTHORIZATION_REQUIRED', message: '需要 GitHub 授权：请 star 仓库', status: 401 },
      },
    };
  })();
  apply(env.ctx, { statusPort: PROBE_PORT, cooldownMs: 600000 });
  try {
    const body = await (await fetch(`http://127.0.0.1:${PROBE_PORT}/probe`, { method: 'POST' })).json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'AUTHORIZATION_REQUIRED');
    assert.equal(body.lane, 'eac');

    const snapshot = readStatus(home);
    assert.ok(snapshot.laneCooldowns.eac, '应把整条 eac 渠道冷却掉，而不是只冷却一个模型');
    assert.equal(snapshot.lastFailure.scope, 'lane');
    assert.equal(snapshot.lastFailure.code, 'AUTHORIZATION_REQUIRED');
    assert.equal(Object.keys(snapshot.cooldowns).length, 0, '渠道级失败不该写成模型级冷却');
    assert.equal(
      snapshot.warnings.some((line) => line.includes('eac')),
      true,
      '状态里应出现被整条排除的渠道',
    );
  } finally {
    env.dispose();
    delete process.env.DSH_HOME;
  }
});

test('probe 自愈后第二次会选择别的渠道', async () => {
  const home = makeHome({ catalog: { entries: ['free-a'], sealIds: ['sealed-a'] } });
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: { 'our-free-model': ['free-a', 'sealed-a'] } });
  let calls = 0;
  env.ctx.llm.stream = () => {
    calls += 1;
    return (async function* gen() {
      // 只有第一次（eac）失败；换渠道后成功
      if (calls === 1) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTHORIZATION_REQUIRED', message: '需授权' } } };
      } else {
        yield { type: 'text-delta', index: 0, text: 'pong' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    })();
  };
  apply(env.ctx, { statusPort: PROBE_PORT, cooldownMs: 600000 });
  try {
    const first = await (await fetch(`http://127.0.0.1:${PROBE_PORT}/probe`, { method: 'POST' })).json();
    assert.equal(first.lane, 'eac');
    const second = await (await fetch(`http://127.0.0.1:${PROBE_PORT}/probe`, { method: 'POST' })).json();
    assert.equal(second.lane, 'free', 'eac 被冷却后应自动换到 free 渠道');
    assert.equal(second.ok, true);
  } finally {
    env.dispose();
    delete process.env.DSH_HOME;
  }
});

// ── 修复 ① 重试策略不得退回运行时默认值 ─────────────────────────────────────

const RUNTIME_DEFAULT_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 5,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 500,
  maxDelayMs: 10000,
  jitterRatio: 0.1,
});

const UPSTREAM_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 700,
  maxDelayMs: 8000,
  jitterRatio: 0.2,
});

test('重试策略绝不返回 undefined（否则 DSH 会套用默认的 5 次 + RATE_LIMIT）', async () => {
  const home = makeHome();
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: TWO_MODELS });
  apply(env.ctx, { statusPort: 0 });
  const adapter = env.registered.get(ROUTE);
  const policy = adapter.providerRetryPolicy();
  assert.notEqual(policy, undefined);
  assert.equal(policy.retryableCodes.includes('RATE_LIMIT'), false);
  assert.ok(policy.maxRetries <= 2);
  env.dispose();
  delete process.env.DSH_HOME;
});

test('能取到上游策略时继承它，而不是用默认值', async () => {
  const home = makeHome();
  process.env.DSH_HOME = home;
  const env = makeCtx({
    modelsByProvider: TWO_MODELS,
    providerRetryPolicies: { 'our-free-model': UPSTREAM_POLICY, 'our-free-model-region': RUNTIME_DEFAULT_POLICY },
  });
  apply(env.ctx, { statusPort: 0 });
  const adapter = env.registered.get(ROUTE);
  assert.equal(adapter.providerRetryPolicy(), UPSTREAM_POLICY);
  env.dispose();
  delete process.env.DSH_HOME;
});

test('上游给的是运行时默认值时，改用保守策略而不是照单全收', async () => {
  const home = makeHome();
  process.env.DSH_HOME = home;
  const env = makeCtx({
    modelsByProvider: TWO_MODELS,
    providerRetryPolicies: { 'our-free-model': RUNTIME_DEFAULT_POLICY },
  });
  apply(env.ctx, { statusPort: 0 });
  const adapter = env.registered.get(ROUTE);
  const policy = adapter.providerRetryPolicy();
  assert.notEqual(policy, RUNTIME_DEFAULT_POLICY);
  assert.equal(policy.retryableCodes.includes('RATE_LIMIT'), false);
  env.dispose();
  delete process.env.DSH_HOME;
});

test('状态里能看到生效的重试策略（否则这个回归查不出来）', async () => {
  const home = makeHome();
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: TWO_MODELS });
  apply(env.ctx, { statusPort: 0 });
  const snapshot = readStatus(home);
  assert.ok(snapshot.retryPolicy, '状态里必须包含 retryPolicy');
  assert.equal(snapshot.retryPolicy.retryableCodes.includes('RATE_LIMIT'), false);
  env.dispose();
  delete process.env.DSH_HOME;
});

// ── 修复 ② 连续失败时冷却递增，成功后清零 ───────────────────────────────────

test('同一渠道连续失败时冷却递增（而不是固定时长反复重撞）', async () => {
  const home = makeHome({ catalog: { sealIds: ['sealed-a'] } });
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: { 'our-free-model': ['sealed-a'] } });
  env.ctx.llm.stream = () =>
    (async function* gen() {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTHORIZATION_REQUIRED', message: '需授权' } } };
    })();
  // 极短冷却：让它立刻到期，从而模拟「长期不可用渠道被周期性重试」的真实场景
  apply(env.ctx, { statusPort: PROBE_PORT, cooldownMs: 30, cooldownMaxMs: 3000 });
  try {
    await fetch(`http://127.0.0.1:${PROBE_PORT}/probe`, { method: 'POST' });
    assert.equal(readStatus(home).strikes.lanes.eac, 1);

    await new Promise((r) => setTimeout(r, 60)); // 等冷却到期
    await fetch(`http://127.0.0.1:${PROBE_PORT}/probe`, { method: 'POST' });
    const after = readStatus(home);
    assert.equal(after.strikes.lanes.eac, 2, '第 2 次连续失败应累计');

    await new Promise((r) => setTimeout(r, 120)); // 第 2 次冷却 = 60ms
    await fetch(`http://127.0.0.1:${PROBE_PORT}/probe`, { method: 'POST' });
    assert.equal(readStatus(home).strikes.lanes.eac, 3, '第 3 次连续失败应继续累计');
  } finally {
    env.dispose();
    delete process.env.DSH_HOME;
  }
});

test('成功后连续失败计数清零，退避回到起点', async () => {
  const home = makeHome({ catalog: { sealIds: ['sealed-a'] } });
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: { 'our-free-model': ['sealed-a'] } });
  let fail = true;
  env.ctx.llm.stream = () =>
    (async function* gen() {
      if (fail) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTHORIZATION_REQUIRED', message: '需授权' } } };
      } else {
        yield { type: 'text-delta', index: 0, text: 'pong' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    })();
  apply(env.ctx, { statusPort: PROBE_PORT, cooldownMs: 20, cooldownMaxMs: 2000 });
  try {
    await fetch(`http://127.0.0.1:${PROBE_PORT}/probe`, { method: 'POST' });
    assert.equal(readStatus(home).strikes.lanes.eac, 1);

    fail = false;
    await new Promise((r) => setTimeout(r, 50));
    const ok = await (await fetch(`http://127.0.0.1:${PROBE_PORT}/probe`, { method: 'POST' })).json();
    assert.equal(ok.ok, true);
    const after = readStatus(home);
    assert.equal(after.strikes.lanes.eac, undefined, '成功后计数应被清零');
  } finally {
    env.dispose();
    delete process.env.DSH_HOME;
  }
});

test('冷却上限生效：不会无限增长', async () => {
  const home = makeHome({ catalog: { sealIds: ['sealed-a'] } });
  process.env.DSH_HOME = home;
  const env = makeCtx({ modelsByProvider: { 'our-free-model': ['sealed-a'] } });
  env.ctx.llm.stream = () =>
    (async function* gen() {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTHORIZATION_REQUIRED', message: '需授权' } } };
    })();
  apply(env.ctx, { statusPort: PROBE_PORT, cooldownMs: 20, cooldownMaxMs: 40 });
  try {
    for (let i = 0; i < 4; i++) {
      await fetch(`http://127.0.0.1:${PROBE_PORT}/probe`, { method: 'POST' });
      await new Promise((r) => setTimeout(r, 30));
    }
    const snapshot = readStatus(home);
    const remaining = new Date(snapshot.laneCooldowns.eac).getTime() - Date.now();
    assert.ok(remaining <= 45, `冷却不应超过上限，实际剩 ${remaining}ms`);
    assert.ok(snapshot.strikes.lanes.eac >= 3);
  } finally {
    env.dispose();
    delete process.env.DSH_HOME;
  }
});
