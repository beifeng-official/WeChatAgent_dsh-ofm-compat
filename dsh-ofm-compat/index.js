/**
 * dsh-ofm-compat —— WeChatAgent ↔ dsh-our-free-model 兼容包。
 *
 * 解决的具体问题：
 *   WeChatAgent 把 `dsh.provider` / `dsh.model` 写在 config/wechatagent.json 里，
 *   由 dsh-social-bridge-plugin 在**创建 agent 时绑定**（native-context.mjs:213-215），
 *   之后无法更改 —— 换模型必须「完整退出并重开 DSH」。
 *   而 our-free-model 的可用模型会随地区封锁、上游下线而失效（本机实测：10 个免费
 *   条目里 8 个被上游拒绝、2 个地区封锁），所以写死一个模型必然烂掉。
 *
 * 本插件的做法：
 *   向 DSH 注册一条**我们拥有的**固定路由（默认 `wechatagent-free`），只 advertise
 *   一个固定别名（默认 `auto`）。每次真实调用时，我们通过 DSH 运行时的公开 API 把
 *   调用转交给 our-free-model 当下真正可用的模型。于是 WeChatAgent 只需要配置一次：
 *
 *       dsh.provider = "wechatagent-free"
 *       dsh.model    = "auto"
 *
 *   模型失效时我们自动换下一个，WeChatAgent 侧无感，**不需要再重开 DSH**。
 *
 * 依赖说明：本文件与 src/ 下所有模块都**不 import 任何 @deepseek-ai/* 包**，
 * 只使用结构化的 ctx 契约（与 dsh-our-free-model 的 adapter/kernel.js 同一纪律）。
 *
 * @module dsh-ofm-compat
 */

import { createCompatAdapter, OfmCompatError } from './src/adapter.js';
import { resolveDshHome } from './src/availability.js';
import { checkLlmContract } from './src/contract.js';
import { bumpStrikes, clearStrikes, escalateCooldown } from './src/cooldown.js';
import { classifyFailure, explainFailure } from './src/failure.js';
import { SEALED_HIDDEN_HINT, laneDiagnostics } from './src/lanes.js';
import { interpretFinish } from './src/probe.js';
import { normalizeLanes } from './src/select.js';
import { createStatusServer, writeStatusFile } from './src/status.js';

export const name = 'ofm-compat';

/** 我们只依赖 llm 服务。 */
export const inject = ['llm'];

const DEFAULTS = Object.freeze({
  targetProviders: ['our-free-model', 'our-free-model-region'],
  route: 'wechatagent-free',
  alias: 'auto',
  displayName: 'OFM Auto（WeChatAgent 兼容）',
  prefer: [],
  exclude: [],
  // 「白嫖优先」的默认表达：先共付渠道（eac），再匿名免费通道（free）。
  // Kilo 与未分类渠道不列入，因此不因此被惩罚，只在可用性上竞争。
  preferLanes: ['eac', 'free'],
  excludeLanes: [],
  cooldownMs: 900000,
  // 连续失败时的冷却上限。同一目标反复失败会翻倍到顶，成功后立刻清零 ——
  // 否则一个长期不可用的渠道会被周期性重试，每次都让用户等一次超时。
  cooldownMaxMs: 3600000,
  statusPort: 11231,
  statusFile: '',
});

/** 校验并补全配置。非法值退回默认，绝不让 DSH 因为配置写错而起不来。 */
export function normalizeConfig(input = {}, log = () => {}) {
  const config = { ...DEFAULTS };
  const strings = (value, fallback) =>
    Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim() !== '') : fallback;

  config.targetProviders = strings(input.targetProviders, DEFAULTS.targetProviders)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (config.targetProviders.length === 0) config.targetProviders = [...DEFAULTS.targetProviders];

  if (typeof input.route === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(input.route.trim())) {
    config.route = input.route.trim();
  } else if (input.route !== undefined) {
    log(`ofm-compat: 非法 route ${JSON.stringify(input.route)}，使用默认 ${DEFAULTS.route}`);
  }

  if (typeof input.alias === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(input.alias.trim())) {
    config.alias = input.alias.trim();
  } else if (input.alias !== undefined) {
    log(`ofm-compat: 非法 alias ${JSON.stringify(input.alias)}，使用默认 ${DEFAULTS.alias}`);
  }

  if (typeof input.displayName === 'string' && input.displayName.trim() !== '') config.displayName = input.displayName.trim();
  config.prefer = strings(input.prefer, []);
  config.exclude = strings(input.exclude, []);
  // 显式传 [] 表示关闭渠道偏好；不传则用默认的白嫖优先。
  config.preferLanes = normalizeLanes(input.preferLanes === undefined ? DEFAULTS.preferLanes : input.preferLanes);
  config.excludeLanes = normalizeLanes(input.excludeLanes ?? []);

  const cooldown = Number(input.cooldownMs);
  config.cooldownMs = Number.isFinite(cooldown) && cooldown >= 0 ? Math.trunc(cooldown) : DEFAULTS.cooldownMs;
  const cooldownMax = Number(input.cooldownMaxMs);
  config.cooldownMaxMs =
    Number.isFinite(cooldownMax) && cooldownMax >= config.cooldownMs ? Math.trunc(cooldownMax) : Math.max(DEFAULTS.cooldownMaxMs, config.cooldownMs);

  const port = input.statusPort === undefined ? DEFAULTS.statusPort : Number(input.statusPort);
  config.statusPort = Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULTS.statusPort;

  config.statusFile = typeof input.statusFile === 'string' && input.statusFile.trim() !== '' ? input.statusFile.trim() : '';
  config.dshHome = resolveDshHome();
  return config;
}

/**
 * @param {object} ctx Cordis 上下文
 * @param {object} [rawConfig] cordis.patch.yml 里的 config
 */
export function apply(ctx, rawConfig = {}) {
  const log = (message) => {
    try {
      ctx.logger?.warn?.(message);
    } catch {
      /* 日志失败不致命 */
    }
  };
  const config = normalizeConfig(rawConfig, log);

  const state = {
    current: null,
    lastDecision: null,
    lastDispatch: null,
    cooldowns: Object.create(null),
    // 渠道级冷却：授权这类门槛是整条渠道的属性，只冷却单个模型会一直失败。
    laneCooldowns: Object.create(null),
    // 连续失败计数：冷却时长按它递增，成功后清零。
    laneStrikes: Object.create(null),
    modelStrikes: Object.create(null),
    lastFailure: null,
    laneFailureHint: null,
    lastAdvertised: [],
    sessionDispatch: new Map(),
    history: [],
    registeredAt: Date.now(),
  };

  const adapter = createCompatAdapter({ ctx, config, state, log });

  // ── 契约自检 ────────────────────────────────────────────────────────────────
  // 本插件不声明 @deepseek-ai/dsh* 的 peerDependency（因此不受版本闸门限制），
  // 代价是必须自己在运行时确认用到的 ctx.llm 方法真的存在。缺了就明确报出来，
  // 而不是等第一次调用时抛一个看不懂的错。
  const contract = checkLlmContract(ctx.llm);
  if (!contract.ok) log(`ofm-compat: ${contract.reason}`);

  // ── 注册路由 ────────────────────────────────────────────────────────────────
  // 与其他适配器撞路由会抛 DUPLICATE_ADAPTER。这里吞掉并给出可执行的提示，
  // 因为「兼容包没挂上」不应该等于「整个 DSH 起不来」。
  let registration = null;
  if (contract.ok) {
    try {
      registration = ctx.llm.registerAdapter([config.route], adapter);
    } catch (error) {
      log(
        `ofm-compat: 注册路由 ${config.route} 失败（${error?.message ?? error}）。` +
          '请把 cordis.patch.yml 里的 route 改成别的名字，或卸载冲突插件。',
      );
    }
  }
  if (registration) {
    ctx.effect?.(() => () => {
      try {
        registration();
      } catch {
        /* ignore */
      }
    });
  }

  /**
   * 记下一次失败，并按归因粒度冷却。真实 turn 与 /probe **共用这一条路径**：
   * probe 的职责是「踢一脚轮胎」，它踢出来的结论当然也该让选型学到东西 ——
   * 否则 probe 报完错，下一轮真实对话还会去撞同一个坑。
   */
  function recordFailure(verdict, target, source) {
    state.lastFailure = {
      at: Date.now(),
      source,
      code: verdict.code,
      message: verdict.message.slice(0, 300),
      scope: verdict.scope,
      reason: verdict.reason,
    };
    if (verdict.scope === 'none' || !target?.model) {
      try {
        state.notify?.();
      } catch {
        /* 状态刷新失败不影响任何判断 */
      }
      return;
    }
    if (verdict.scope === 'lane') {
      const lane = target.lane ?? 'unknown';
      const strikes = bumpStrikes(state.laneStrikes, lane);
      const duration = escalateCooldown(config.cooldownMs, strikes, config.cooldownMaxMs);
      state.laneCooldowns[lane] = Date.now() + duration;
      state.laneFailureHint = explainFailure(verdict, lane);
      log(
        `ofm-compat: [${source}] 渠道 ${lane} 判定不可用（${verdict.reason}），第 ${strikes} 次连续失败，` +
          `整条冷却 ${Math.round(duration / 60000)} 分钟至 ${new Date(Date.now() + duration).toLocaleString('zh-CN')}。`,
      );
    } else {
      const strikes = bumpStrikes(state.modelStrikes, target.model);
      const duration = escalateCooldown(config.cooldownMs, strikes, config.cooldownMaxMs);
      state.cooldowns[target.model] = Date.now() + duration;
      log(
        `ofm-compat: [${source}] 模型 ${target.model} 判定不可用（${verdict.reason}），第 ${strikes} 次连续失败，` +
          `冷却 ${Math.round(duration / 60000)} 分钟至 ${new Date(Date.now() + duration).toLocaleString('zh-CN')}。`,
      );
    }
    if (state.current?.model === target.model) state.current = null; // 下一轮重新选
    try {
      state.notify?.();
    } catch {
      /* 同上 */
    }
  }

  /**
   * 成功一次就把该目标的连续失败计数清零，让退避回到起点。
   * 不这么做的话，退避只会单调上升到上限 —— 一个偶尔抖动的渠道会被永久惩罚。
   */
  function resetStrikes(target) {
    if (!target) return false;
    let cleared = false;
    if (target.lane && target.lane !== 'unknown') cleared = clearStrikes(state.laneStrikes, target.lane) || cleared;
    if (target.model) cleared = clearStrikes(state.modelStrikes, target.model) || cleared;
    if (cleared) {
      log(`ofm-compat: ${target.model ?? '?'} 调用成功，连续失败计数已清零`);
      try {
        state.notify?.(); // 必须重新发布，否则状态文件里还留着旧的计数
      } catch {
        /* 状态刷新失败不影响任何判断 */
      }
    }
    return cleared;
  }

  // ── 失败归因 ────────────────────────────────────────────────────────────────
  // 两种归因粒度，实测都需要：
  //   · 渠道级（如 EAC 需要 GitHub 授权）—— 只冷却单个模型会立刻换上同渠道的下一个，
  //     于是永远在失败模型之间打转；
  //   · 模型级（地区封锁、已弃用）—— 只该换掉那一个。
  // 认不出来的失败一律不动，避免误冷却导致选型乱跳。
  ctx.on?.('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return;
    const reason = event?.data?.reason;
    const sessionId = String(session?.id ?? '');
    const target = state.sessionDispatch.get(sessionId) ?? state.lastDispatch;
    state.sessionDispatch.delete(sessionId);

    if (reason?.kind !== 'error') {
      resetStrikes(target);
      return;
    }
    const verdict = classifyFailure(reason?.error ?? {});
    recordFailure(verdict, target, 'turn');
  });

  // ── 状态输出 ────────────────────────────────────────────────────────────────
  const statusFile = config.statusFile || `${config.dshHome}/ofm-compat/status.json`;
  const snapshot = () => {
    // 每次输出都重新读 our-free-model 的 catalog：渠道解不解锁是动态的，
    // 缓存这份判断反而会误导排查。
    let ofm = { catalog: null };
    try {
      ofm = adapter._internal.readAvailability();
    } catch {
      /* 读不到就退化为「无渠道信息」，不影响其他字段 */
    }
    const advertised = Array.isArray(state.lastAdvertised) ? state.lastAdvertised : [];
    const lanes = laneDiagnostics(ofm.catalog, advertised);
    const warnings = [];
    if (lanes.eac && lanes.eac.state === 'hidden') warnings.push(SEALED_HIDDEN_HINT);
    if (lanes.free && lanes.free.state === 'hidden') {
      warnings.push('匿名免费通道的模型全部未被 advertise：通常是出口地区被拒（见 lastDecision.egress）。');
    }
    if (advertised.length === 0) {
      warnings.push('尚未枚举到任何候选：our-free-model 未安装/未启用，或还没同步过 catalog。');
    }
    // 渠道级失败提示优先于「已 advertise」的乐观判断：能列出不等于能用
    // （实测：EAC 的 6 个模型都会 advertise，但未授权时每次调用都失败）。
    if (state.laneFailureHint) warnings.push(state.laneFailureHint);
    const now = Date.now();
    const cooledLanes = Object.entries(state.laneCooldowns)
      .filter(([, until]) => until > now)
      .map(([lane]) => lane);
    if (cooledLanes.length > 0) {
      warnings.push(`当前被整条排除的渠道：${cooledLanes.join('、')}（原因见 lastFailure）。`);
    }
    return {
      plugin: 'dsh-ofm-compat',
      at: new Date().toISOString(),
      registered: registration !== null,
      contract: { ok: contract.ok, missing: contract.missing, optionalMissing: contract.optionalMissing },
      route: config.route,
      alias: config.alias,
      targetProviders: config.targetProviders,
      lanePreference: config.preferLanes,
      laneExcluded: config.excludeLanes,
      lanes,
      advertisedCount: advertised.length,
      current: state.current,
      lastDecision: state.lastDecision,
      lastDispatch: state.lastDispatch,
      lastFailure: state.lastFailure,
      cooldowns: Object.fromEntries(
        Object.entries(state.cooldowns).map(([model, until]) => [model, new Date(until).toISOString()]),
      ),
      laneCooldowns: Object.fromEntries(
        Object.entries(state.laneCooldowns).map(([lane, until]) => [lane, new Date(until).toISOString()]),
      ),
      // 连续失败次数：冷却时长由它递增，成功后清零。
      strikes: { lanes: { ...state.laneStrikes }, models: { ...state.modelStrikes } },
      // 生效的重试策略。**必须能从状态里看到它** —— 实测的回归正是「默认策略
      // （重试 5 次、含 RATE_LIMIT）被静默套用到本路由」，看不见就查不出来。
      retryPolicy: adapter.providerRetryPolicy(),
      warnings,
      history: state.history,
      registeredAt: new Date(state.registeredAt).toISOString(),
    };
  };

  /**
   * 真实跑一次最小模型调用，把「适配器通不通」从推断变成实测。
   * 这是唯一会消耗模型额度的端点，因此只挂在 POST /probe 上。
   */
  const probe = async () => {
    if (!registration) return { ok: false, error: 'plugin_not_registered' };
    const started = Date.now();
    let target;
    try {
      target = await adapter._internal.choose('probe');
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), ms: Date.now() - started };
    }
    let text = '';
    let reason = null;
    let thrown = null;
    try {
      const stream = ctx.llm.stream({
        provider: target.provider,
        model: target.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        maxTokens: 16,
      });
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta') text += String(chunk.text ?? '');
        else if (chunk?.type === 'finish') reason = chunk.reason ?? null;
        if (text.length >= 200) break;
      }
    } catch (error) {
      thrown = String(error?.message ?? error);
    }
    const finish = interpretFinish(reason);
    // 让 probe 的结论也进入选型：诊断完就自愈，不必等下一次真实对话去撞同一个坑。
    if (thrown !== null) recordFailure(classifyFailure({ message: thrown }), target, 'probe');
    else if (!finish.ok) recordFailure(classifyFailure({ code: finish.code, message: finish.message }), target, 'probe');
    else resetStrikes(target);
    return {
      ok: thrown === null && finish.ok && text.trim() !== '',
      provider: target.provider,
      model: target.model,
      lane: target.lane,
      ms: Date.now() - started,
      finishKind: finish.kind,
      code: finish.code,
      error: thrown ?? finish.message,
      // 原始 finish 原因一并给出：诊断工具不该替调用方隐藏证据。
      reasonRaw: reason,
      text: text.slice(0, 400),
    };
  };

  const server = createStatusServer({ port: config.statusPort, snapshot, probe, log });
  ctx.effect?.(() => () => server.close());

  const publish = () => writeStatusFile(statusFile, snapshot());
  publish();
  // 适配器每次决策完都会回调这里，让状态文件与 /status 保持即时。
  state.notify = publish;
  const timer = setInterval(publish, 30000);
  timer.unref?.();
  ctx.effect?.(() => () => clearInterval(timer));

  log(`ofm-compat: 路由 ${config.route} 已注册，别名 ${config.alias}；状态文件 ${statusFile}`);
}

export { OfmCompatError };
