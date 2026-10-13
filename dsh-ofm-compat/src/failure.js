/**
 * 失败归因：决定一次 turn 失败应该怪到「整条渠道」还是「单个模型」头上。
 *
 * 为什么需要区分？实测拿到的这条错误说明了问题：
 *
 *   { code: 'AUTHORIZATION_REQUIRED',
 *     detail: '需要 GitHub 授权：请在插件设置页用 GitHub 登录，并 star 仓库后使用 EAC 模型' }
 *
 * 这是**整条 EAC 渠道**的门槛（要授权 + star），不是某一个模型坏了。如果只把
 * `deepseek-ai/deepseek-v4.1-flash` 冷却掉，适配器下一秒就会换 `moonshotai/kimi-k3`
 * —— 同一渠道、同样失败，于是永远在失败模型之间打转。所以必须能识别出
 * 「这条渠道现在不可用」，并按渠道冷却。
 *
 * 反过来也要克制：`ACCOUNT_SIGN_IN_REQUIRED`、参数校验失败、网络超时都**不是**模型的错，
 * 误冷却只会让选型乱跳。所以这里只认两类信号，其余一律 `none`。
 *
 * @module src/failure
 */

/**
 * 明确表示「宿主账号」问题、**绝不能**怪到模型或渠道头上的错误码。
 *
 * 为什么需要显式排除：账号未登录的原文是 "Sign in to DeepSeek to use the account
 * provider."，里面有 "Sign in" —— 而渠道授权也常说 sign in。光靠关键词分不开，
 * 所以先用这张表把宿主账号问题摘出去。
 */
export const NOT_MODEL_FAILURE_CODES = Object.freeze(['ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_CHANGED']);

/** 明确表示「整条渠道未授权」的错误码。 */
export const LANE_FAILURE_CODES = Object.freeze([
  'AUTHORIZATION_REQUIRED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'LANE_NOT_AUTHORIZED',
  'CHANNEL_NOT_AUTHORIZED',
  'LOGIN_REQUIRED',
  'AUTH_REQUIRED',
]);

/** 渠道级关键词（中英并蓄，因为上游会直接给中文）。 */
export const LANE_FAILURE_RE =
  /github|授权|authorization|authoriz|unauthorized|not authorized|sign ?in|log ?in|登录|star\s*(?:仓库|the repo|repo)|access denied/i;

/** 模型级不可用关键词 —— 保持英文原样，另外补上中文。 */
export const MODEL_FAILURE_RE =
  /not available in your country|region[- ]?block|has been deprecated|deprecated|model is unavailable|no longer available|only be used from within|unavailable|地区|已被弃用|不可用/i;

/**
 * @typedef {{scope:'lane'|'model'|'none', code:string|null, message:string, reason:string}} FailureVerdict
 */

/**
 * 判定一次失败该归到哪一层。
 * @param {{code?: unknown, message?: unknown}} failure
 * @returns {FailureVerdict}
 */
export function classifyFailure(failure = {}) {
  const code = failure?.code === undefined || failure?.code === null ? '' : String(failure.code);
  const message = failure?.message === undefined || failure?.message === null ? '' : String(failure.message);
  const haystack = `${code} ${message}`;

  // 宿主账号问题优先摘出去：它的措辞与渠道授权高度重合，不能用关键词判断。
  if (code !== '' && NOT_MODEL_FAILURE_CODES.includes(code.toUpperCase())) {
    return { scope: 'none', code, message, reason: 'host-account' };
  }
  if (code !== '' && LANE_FAILURE_CODES.includes(code.toUpperCase())) {
    return { scope: 'lane', code, message, reason: `code:${code}` };
  }
  if (LANE_FAILURE_RE.test(haystack)) {
    return { scope: 'lane', code: code || null, message, reason: 'keyword:authorization' };
  }
  if (MODEL_FAILURE_RE.test(haystack)) {
    return { scope: 'model', code: code || null, message, reason: 'keyword:unavailable' };
  }
  return { scope: 'none', code: code || null, message, reason: 'unrecognized' };
}

/** 给状态输出用的一句话说明。 */
export function explainFailure(verdict, lane) {
  if (!verdict || verdict.scope === 'none') return null;
  if (verdict.scope === 'lane') {
    return (
      `渠道 ${lane ?? '?'} 整条被判定为不可用（${verdict.reason}）：${verdict.message || verdict.code}。` +
      '该渠道的模型已全部暂时排除；如果是 EAC/共付渠道，需要在 dsh-our-free-model 的设置页' +
      '用 GitHub 登录并 star 仓库完成授权，之后自动恢复。'
    );
  }
  return `模型被判定为不可用（${verdict.reason}）：${verdict.message || verdict.code}。仅该模型被暂时排除。`;
}
