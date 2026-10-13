/**
 * 冷却时长的递增退避。
 *
 * 原因是实测到的一段循环：共付渠道（eac）因为需要 GitHub 授权而整条冷却 15 分钟 →
 * 到期后适配器又选中它 → 又挂满 120 秒超时（会话日志里 chunks=0）→ 再冷却 15 分钟。
 * 固定时长意味着一个**长期不可用**的渠道会被周期性重试，每次都让用户等一次超时。
 *
 * 所以同一目标连续失败时冷却翻倍（15min → 30min → 1h 封顶）；一旦成功就清零。
 *
 * @module src/cooldown
 */

/**
 * 计算第 `strikes` 次连续失败应冷却多久。
 *
 * @param {number} baseMs 基础冷却
 * @param {number} strikes 连续失败次数（从 1 开始）
 * @param {number} maxMs 上限
 * @returns {number} 冷却毫秒数
 */
export function escalateCooldown(baseMs, strikes, maxMs) {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? Math.trunc(baseMs) : 0;
  const cap = Number.isFinite(maxMs) && maxMs > 0 ? Math.trunc(maxMs) : base;
  const n = Number.isFinite(strikes) && strikes >= 1 ? Math.trunc(strikes) : 1;
  if (base === 0) return 0;
  // 指数翻倍，但要防止 n 很大时 2**(n-1) 溢出成 Infinity
  const factor = n <= 32 ? 2 ** (n - 1) : Number.MAX_SAFE_INTEGER;
  const raw = base * factor;
  return Math.min(Number.isFinite(raw) ? raw : cap, Math.max(base, cap));
}

/** 记一次连续失败，返回新的次数。 */
export function bumpStrikes(map, key) {
  const next = (Number(map[key]) || 0) + 1;
  map[key] = next;
  return next;
}

/** 成功后清零。返回是否真的清过（用于日志）。 */
export function clearStrikes(map, key) {
  if (!map || map[key] === undefined) return false;
  delete map[key];
  return true;
}
