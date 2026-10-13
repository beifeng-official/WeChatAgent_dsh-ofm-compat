/**
 * 运行时的契约自检。
 *
 * 为什么不声明 `@deepseek-ai/dsh*` 的 peerDependency 来做版本校验？
 *   1. 本插件**不 import 任何内核包**，只用结构化的 ctx 契约；
 *   2. DSH 的版本闸门（dsh-app-boot 的 `evaluatePluginCompatibility`）**只看**
 *      `peerDependencies` 里 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的条目 ——
 *      不声明就永远不会因为运行时版本漂移而被拒装；
 *   3. 版本号本来也证明不了「我用到的那几个方法签名没变」。真正有意义的是
 *      **在 apply 时直接检查方法是否存在**，缺了就给出一条指名道姓的日志。
 *
 * 所以这里做的是契约自检，而不是语义化版本比对。
 *
 * @module src/contract
 */

/** 我们真正会调用的 ctx.llm 方法。少一个就等于插件不可用。 */
export const REQUIRED_LLM_METHODS = Object.freeze([
  'registerAdapter', // 注册路由
  'listProviders', // 判断目标 provider 在不在
  'listModels', // 枚举候选模型
  'resolveModelInfo', // 取真实模型元数据
  'stream', // 转交真实调用
]);

/** 可选方法：缺了只降级，不影响路由。 */
export const OPTIONAL_LLM_METHODS = Object.freeze(['imageRequestPricing']);

/**
 * @param {unknown} llm 期望是 Cordis 的 llm 服务
 * @returns {{ok:boolean, missing:string[], optionalMissing:string[], reason:string}}
 */
export function checkLlmContract(llm) {
  if (llm === null || llm === undefined || (typeof llm !== 'object' && typeof llm !== 'function')) {
    return {
      ok: false,
      missing: [...REQUIRED_LLM_METHODS],
      optionalMissing: [...OPTIONAL_LLM_METHODS],
      reason: 'ctx.llm 不存在：DSH 内核没有提供 llm 服务（inject 未满足？）',
    };
  }
  const missing = REQUIRED_LLM_METHODS.filter((name) => typeof llm[name] !== 'function');
  const optionalMissing = OPTIONAL_LLM_METHODS.filter((name) => typeof llm[name] !== 'function');
  return {
    ok: missing.length === 0,
    missing,
    optionalMissing,
    reason:
      missing.length === 0
        ? ''
        : `ctx.llm 契约不匹配：缺少 ${missing.join('、')}。` +
          '这通常意味着 DSH 内核版本与插件不兼容；请升级插件或对该版本申请豁免。',
  };
}
