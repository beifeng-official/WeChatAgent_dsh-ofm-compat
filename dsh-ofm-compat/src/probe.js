/**
 * 把 DSH 的 `FinishReason` 翻译成人能读的结果。
 *
 * 抽成独立模块是有原因的：`/probe` 的第一版把错误字段读成了 `finish.error`，
 * 而 DSH 用的是 `reason.failure`（见 dsh-llm 的 `FinishReasonMap`），
 * 结果诊断工具自己报了个没用的 `"error"` —— 诊断工具读不出诊断信息是最糟的失败模式。
 * 所以这段逻辑单独出来，并且有测试盯着。
 *
 * FinishReasonMap 的完整取值：
 *   { kind: 'stop' }                    ← 正常结束
 *   { kind: 'tool-calls' }              ← 请求工具
 *   { kind: 'max-tokens' }              ← 撞到输出上限
 *   { kind: 'aborted', failure }        ← 被取消
 *   { kind: 'error',   failure }        ← 失败（failure 里才有 code / message）
 *
 * @module src/probe
 */

/** 视为「正常产出」的结束原因。 */
export const OK_FINISH_KINDS = Object.freeze(['stop', 'tool-calls', 'max-tokens']);

/**
 * @param {{kind?: string, failure?: {code?: unknown, message?: unknown}}|null|undefined} reason
 * @returns {{kind: string|null, ok: boolean, code: string|null, message: string|null}}
 */
export function interpretFinish(reason) {
  const kind = typeof reason?.kind === 'string' && reason.kind !== '' ? reason.kind : null;
  const failure = reason?.failure ?? null;
  const code = failure?.code === undefined || failure?.code === null ? null : String(failure.code);
  const message = failure?.message === undefined || failure?.message === null ? null : String(failure.message);
  return {
    kind,
    // 没拿到 finish 分片（kind 为 null）不算成功：那说明流被中断了。
    ok: kind !== null && OK_FINISH_KINDS.includes(kind),
    code,
    message,
  };
}
