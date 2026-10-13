/**
 * 重试策略的继承与回退。
 *
 * 这是一个**实测确认的回归**：代理型适配器如果 `providerRetryPolicy()` 返回 `undefined`，
 * DSH 就会套用它的默认策略，而默认策略是「重试 5 次、且把 RATE_LIMIT 当瞬态故障」。
 *
 * our-free-model 自己声明的是刻意更保守的一套，并在源码里写明了原因：
 *
 *   "A regional refusal is a property of the egress, not a transient fault; retrying it
 *    only spends quota. It is deliberately absent here. So is RATE_LIMIT: this lane's 429
 *    carries a *growing* retry-after, and the two automatic retries turned every quota wall
 *    into three walls — the same turn, paid thrice, arriving later (issue #13)."
 *
 * 实测后果：一次 turn 因默认策略重试 5 次，退避 0.5+1+2+4+8 ≈ **15.5 秒纯等待**。
 * 我的路由只服务 our-free-model，却把它调好的策略换成了它明确排除过的那套 —— 必须修。
 *
 * @module src/retry
 */

/**
 * 保守回退策略。取值直接对齐 our-free-model 的取向（而不是猜）：
 * 只重试真正的瞬态故障，**刻意不含 RATE_LIMIT**。
 */
export const CONSERVATIVE_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 700,
  maxDelayMs: 8000,
  jitterRatio: 0.2,
});

/**
 * 判断一个策略是不是**运行时的默认值**（也就是我们要摆脱的那个）。
 *
 * 判据取自实测到的默认策略序列化：`["normal",5,[…,"RATE_LIMIT",…],500,10000,0.1]`
 * —— 同时满足「重试 ≥5 次」与「把 RATE_LIMIT 当瞬态」才算默认，用 AND 而非 OR，
 * 避免把一个合法的上游策略误判掉。
 *
 * @param {unknown} policy
 * @returns {boolean}
 */
export function looksLikeRuntimeDefault(policy) {
  if (!policy || typeof policy !== 'object') return false;
  const codes = Array.isArray(policy.retryableCodes) ? policy.retryableCodes : [];
  const retries = Number(policy.maxRetries);
  return Number.isFinite(retries) && retries >= 5 && codes.includes('RATE_LIMIT');
}

/**
 * 从若干候选策略里挑一个可接受的；都不行就用保守回退。
 *
 * @param {unknown[]} candidates 按优先级排列（通常来自 targetProviders）
 * @returns {object} 可用的重试策略（永不返回 undefined）
 */
export function chooseRetryPolicy(candidates = []) {
  for (const policy of candidates) {
    if (!policy || typeof policy !== 'object') continue;
    if (looksLikeRuntimeDefault(policy)) continue; // 正是要摆脱的东西
    return policy;
  }
  return CONSERVATIVE_RETRY_POLICY;
}

/**
 * 带 ctx 的薄封装：只从**确实已注册**的目标 provider 继承策略。
 *
 * 为什么必须先查 `listProviders()`：`ctx.llm.providerRetryPolicy(provider)` 对未注册的
 * 路由会返回「已解析好的默认值」，直接拿来用等于什么都没改。
 *
 * @param {object} options
 * @param {object} options.llm Cordis 的 llm 服务
 * @param {string[]} options.providers 目标 provider 路由
 * @returns {unknown[]} 候选策略（交给 chooseRetryPolicy 决策）
 */
export function inheritedPolicyCandidates({ llm, providers = [] }) {
  let known;
  try {
    known = new Set((llm?.listProviders?.() ?? []).map((entry) => String(entry?.id ?? entry)));
  } catch {
    return [];
  }
  const out = [];
  for (const provider of providers) {
    if (!known.has(provider)) continue;
    try {
      const policy = llm?.providerRetryPolicy?.(provider);
      if (policy) out.push(policy);
    } catch {
      /* 单个 provider 取不到就跳过，不影响其他候选 */
    }
  }
  return out;
}
