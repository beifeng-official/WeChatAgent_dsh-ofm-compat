/**
 * 代理型 LlmAdapter —— 本插件的核心。
 *
 * DSH 的 `ctx.llm.registerAdapter(providers, adapter)` 会**结构化校验**适配器
 * （逐个调方法，不做 instanceof 检查 —— dsh-our-free-model 用一个不继承 LlmAdapter 的
 * 普通 class 就能注册成功，这是现成的证据）。所以这里返回一个普通对象即可。
 *
 * 关键点：我们自己**不实现任何模型协议**。所有真实调用都通过 DSH 运行时的公开 API
 * 转交给真正拥有该路由的适配器（即 our-free-model）：
 *
 *   ctx.llm.listModels(provider)               → 枚举候选
 *   ctx.llm.resolveModelInfo(provider, model)  → 取真实模型的上下文/推理档位
 *   ctx.llm.stream({provider, model, …})       → 改写路由后转交
 *
 * 因此 WeChatAgent 只要固定用我们的路由 + 别名，就永远不会因为模型失效而需要重配。
 *
 * @module src/adapter
 */

import { availabilityIndex, egressOf, readOfmState } from './availability.js';
import { buildLaneIndex } from './lanes.js';
import { CONSERVATIVE_RETRY_POLICY, chooseRetryPolicy, inheritedPolicyCandidates } from './retry.js';
import { normalizeLanes, normalizePatterns, pickModel } from './select.js';

/** 明确说明失败原因，便于在会话日志里一眼定位。 */
export class OfmCompatError extends Error {
  constructor(code, message, detail = '') {
    super(`${code}: ${message}${detail ? ` (${detail})` : ''}`);
    this.name = 'OfmCompatError';
    this.code = code;
    this.detail = detail;
  }
}

/** 找不到任何可用模型时的兜底元数据，保证 resolveModel 不抛错。 */
const FALLBACK_INFO = Object.freeze({
  context: Object.freeze({ contextWindow: 131072 }),
  defaultMaxTokens: 8192,
});

/**
 * @param {object} deps
 * @param {object} deps.ctx Cordis 上下文（只需要 ctx.llm）
 * @param {object} deps.config 归一化后的插件配置
 * @param {object} deps.state 可变状态（current / lastDispatch / cooldowns / history）
 * @param {(message:string)=>void} [deps.log]
 */
export function createCompatAdapter({ ctx, config, state, log = () => {} }) {
  const prefer = normalizePatterns(config.prefer);
  const exclude = normalizePatterns(config.exclude);
  const preferLanes = normalizeLanes(config.preferLanes);
  const excludeLanes = normalizeLanes(config.excludeLanes);
  const alias = config.alias;

  // ── 重试策略：继承上游，绝不返回 undefined ──────────────────────────────────
  // 返回 undefined 会让 DSH 套用默认策略（重试 5 次、且把 RATE_LIMIT 当瞬态），
  // 而这正是 our-free-model 在源码里明确排除、并说明过会造成「同一 turn 付三次、
  // 到得更晚」的那套。实测代价：单次 turn 多等约 15.5 秒退避。
  let inheritedRetry = null; // 只有真正继承到才缓存；回退不缓存，允许下次再试
  let retryFallbackLogged = false;

  function resolveRetryPolicy() {
    if (inheritedRetry) return inheritedRetry;
    const candidates = inheritedPolicyCandidates({ llm: ctx.llm, providers: config.targetProviders });
    const policy = chooseRetryPolicy(candidates);
    if (policy !== CONSERVATIVE_RETRY_POLICY) {
      inheritedRetry = policy;
      log('ofm-compat: 已继承上游 our-free-model 的重试策略');
      return policy;
    }
    if (!retryFallbackLogged) {
      retryFallbackLogged = true;
      log(
        candidates.length > 0
          ? 'ofm-compat: 上游策略看起来是运行时的默认值，改用保守策略（重试 2 次、不含 RATE_LIMIT）'
          : 'ofm-compat: 暂未取到上游策略，先用保守策略（重试 2 次、不含 RATE_LIMIT）',
      );
    }
    return policy;
  }

  /**
   * 枚举所有目标 provider 当前 advertise 的模型，保持 provider 顺序与上游顺序。
   * 自己拥有的路由会被跳过，避免自引用导致无限递归。
   */
  async function collectAdvertised() {
    let known = [];
    try {
      known = (ctx.llm.listProviders?.() ?? []).map((entry) => String(entry?.id ?? entry ?? ''));
    } catch (error) {
      log(`ofm-compat: listProviders failed: ${error?.message ?? error}`);
      return [];
    }
    const out = [];
    for (const provider of config.targetProviders) {
      if (provider === config.route || !known.includes(provider)) continue;
      try {
        const models = await ctx.llm.listModels(provider);
        for (const model of models ?? []) {
          const id = String(model?.id ?? '');
          if (id !== '') out.push({ model: id, provider });
        }
      } catch (error) {
        log(`ofm-compat: listModels(${provider}) failed: ${error?.message ?? error}`);
      }
    }
    // 记下来给状态接口做渠道诊断用（对比 catalog 与实际 advertise）。
    state.lastAdvertised = out.map((row) => row.model);
    return out;
  }

  /** 读一次 our-free-model 的可用性状态。 */
  function readAvailability() {
    try {
      return readOfmState(config.dshHome);
    } catch {
      return { availability: null, catalog: null, settings: null, dir: '', readAt: Date.now() };
    }
  }

  /** 记录一条决策历史，供状态接口展示（只保留最近 20 条）。 */
  function remember(entry) {
    state.history.push(entry);
    if (state.history.length > 20) state.history.splice(0, state.history.length - 20);
  }

  /**
   * 选一次模型。每次调用都重新读可用性 —— 这样 our-free-model 后台刷新过一次
   * availability.json 后，我们下一轮就能自动跟上，不需要重启 DSH。
   */
  async function choose(trigger) {
    const advertised = await collectAdvertised();
    const snapshot = readAvailability();
    const availability = availabilityIndex(snapshot.availability);
    const laneIndex = buildLaneIndex(snapshot.catalog);
    const previousModel = state.current?.model ?? null;
    const now = Date.now();
    // 渠道级冷却与配置里的 excludeLanes 一起生效：授权门槛是整条渠道的属性，
    // 只排除单个模型会立刻换上同渠道的下一个，永远在失败模型之间打转。
    const cooledLanes = Object.entries(state.laneCooldowns ?? {})
      .filter(([, until]) => Number(until) > now)
      .map(([lane]) => lane);
    const decision = pickModel({
      advertised,
      availability,
      prefer,
      exclude,
      cooldowns: state.cooldowns,
      now,
      laneIndex,
      preferLanes,
      excludeLanes: [...excludeLanes, ...cooledLanes],
      previous: previousModel,
    });
    const egress = egressOf(snapshot.availability);

    if (decision.chosen === null) {
      state.lastDecision = {
        at: Date.now(),
        trigger,
        reason: decision.reason,
        model: null,
        provider: null,
        usableCount: 0,
        candidates: decision.ranked.length,
        egress,
      };
      remember(state.lastDecision);
      throw new OfmCompatError(
        'OFM_COMPAT_NO_MODEL',
        'our-free-model 当前没有可用模型',
        decision.reason,
      );
    }

    const chosen = decision.chosen;
    state.current = {
      provider: chosen.provider,
      model: chosen.model,
      lane: chosen.lane,
      at: Date.now(),
      reason: decision.reason,
      detail: chosen.detail,
    };
    state.lastDecision = {
      at: Date.now(),
      trigger,
      reason: decision.reason,
      model: chosen.model,
      provider: chosen.provider,
      lane: chosen.lane,
      usableCount: decision.usableCount,
      candidates: decision.ranked.length,
      // 候选按渠道计数，便于一眼看出白嫖渠道有没有货。
      byLane: decision.ranked.reduce((acc, row) => {
        acc[row.lane] = (acc[row.lane] ?? 0) + 1;
        return acc;
      }, Object.create(null)),
      egress,
    };
    remember(state.lastDecision);
    // 通知宿主刷新状态输出：每次决策后都写一次，排查时读到的永远是新鲜的。
    try {
      state.notify?.();
    } catch {
      /* 状态刷新失败绝不能影响选型 */
    }
    return state.current;
  }

  /** 把别名或真实 id 解析成真正要调用的 {provider, model}。 */
  async function targetFor(model, trigger) {
    const requested = String(model ?? '');
    if (requested !== '' && requested !== alias) {
      // 透传：调用方明确点名了一个真实模型，且它确实被 advertise 出来。
      const advertised = await collectAdvertised();
      const hit = advertised.find((row) => row.model === requested);
      if (hit) {
        state.current = { provider: hit.provider, model: hit.model, at: Date.now(), reason: 'passthrough', detail: '' };
        return state.current;
      }
      // 点名了一个我们无法提供的模型：退回自动选择，而不是直接失败。
      log(`ofm-compat: 透传模型 ${requested} 不在候选内，改为自动选择`);
    }
    if (state.current && trigger === 'sticky' && state.current.model) return state.current;
    return choose(trigger);
  }

  /** 记录一次实际派发，供 turn/end 失败归因使用（lane 决定冷却粒度）。 */  function noteDispatch(target) {
    state.lastDispatch = {
      provider: target.provider,
      model: target.model,
      lane: target.lane ?? state.current?.lane ?? 'unknown',
      at: Date.now(),
    };
  }

  /** 把派发记到某条会话上，便于错误归因更精确（拿得到 session id 时）。 */
  function noteDispatchFor(sessionId, target) {
    noteDispatch(target);
    state.sessionDispatch.set(String(sessionId), { ...state.lastDispatch });
    if (state.sessionDispatch.size > 50) {
      const oldest = state.sessionDispatch.keys().next().value;
      state.sessionDispatch.delete(oldest);
    }
  }

  /**
   * 构造暴露给 DSH 的模型元数据：上下文窗口/推理档位用真实模型的，
   * 但身份改写成我们的路由与调用方请求的 id，保证 DSH 的校验能对上。
   */
  async function describe(route, model, target, signal) {
    try {
      const info = await ctx.llm.resolveModelInfo(target.provider, target.model, signal);
      return { ...(info ?? {}), provider: route, id: model };
    } catch (error) {
      log(`ofm-compat: resolveModelInfo(${target.provider}/${target.model}) failed: ${error?.message ?? error}`);
      return { provider: route, id: model, name: model, ...FALLBACK_INFO };
    }
  }

  return {
    /** 适配器不需要 @deepseek-ai/* 依赖，只依赖结构化 ctx。 */
    __ofmCompat: true,

    providerInfo(route) {
      return { id: route, name: config.displayName };
    },

    /**
     * 继承 our-free-model 的重试策略；取不到时退回保守策略 —— **绝不返回 undefined**。
     * 详见 src/retry.js 里记录的实测回归。
     */
    providerRetryPolicy() {
      return resolveRetryPolicy();
    },

    /**
     * 按契约必须**同步**返回。这里只能给出「当前已选模型」的定价；
     * 还没选过时返回 undefined，让 token meter 走自己的中性估算。
     */
    imageRequestPricing(route, model) {
      const current = state.current;
      if (!current?.provider) return undefined;
      try {
        return ctx.llm.imageRequestPricing(current.provider, current.model);
      } catch {
        return undefined;
      }
    },

    /**
     * 只 advertise 一个稳定别名。这样 WeChatAgent 的模型选择器里永远只有一个选项，
     * 不会因为上游模型增减而让已保存的配置失效。
     */
    async listModels(route) {
      const current = state.current;
      const description = current?.model
        ? `自动选择（当前：${current.model}@${current.provider}）`
        : '自动选择（尚未解析，第一次调用时确定）';
      return [
        {
          provider: route,
          id: alias,
          name: 'Auto（OFM 自动选型）',
          description,
          inputModalities: ['text'],
        },
      ];
    },

    async resolveModel(route, model, signal) {
      // resolveModel 会被模型选择器之类的只读入口调用，契约上不该抛错：
      // 即使一个候选都没有，也返回兜底元数据，让界面还能渲染。
      try {
        const target = await targetFor(model, 'resolve');
        return await describe(route, model, target, signal);
      } catch (error) {
        log(`ofm-compat: resolveModel 回退到兜底元数据（${error?.message ?? error}）`);
        return { provider: route, id: model, name: model, ...FALLBACK_INFO };
      }
    },

    /**
     * 绑定「一次调用」到具体的上游模型。返回的 stream 闭包把这个绑定冻结下来，
     * 所以即使选型状态在中途变化，本次调用也不会串到另一个模型上。
     */
    async prepareCall(route, model, signal) {
      const target = await targetFor(model, 'prepare');
      noteDispatch(target);
      const info = await describe(route, model, target, signal);
      return {
        model: info,
        stream: (options) => ctx.llm.stream({ ...options, provider: target.provider, model: target.model }),
      };
    },

    /** 契约里唯一必须实现的方法；prepareCall 未覆盖时的兜底路径。 */
    async *stream(options) {
      const target = await targetFor(options?.model, 'stream');
      noteDispatch(target);
      yield* ctx.llm.stream({ ...options, provider: target.provider, model: target.model });
    },

    /** 供 index.js 的失败归因与状态接口使用。 */
    _internal: {
      choose,
      collectAdvertised,
      readAvailability,
      noteDispatch,
      noteDispatchFor,
      current: () => state.current,
    },
  };
}
