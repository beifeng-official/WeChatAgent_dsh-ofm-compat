/**
 * 读取 dsh-our-free-model 的本机状态。
 *
 * our-free-model 把目录与可用性写在 `<DSH_HOME>/our-free-model/` 下，同一台机器上
 * 所有 profile 共用（见它的 src/store.js 与 settings.json 的 catalogSyncedAt 字段）。
 * 我们只读这三份文件，不依赖它的任何内部 API —— 这样两边可以各自独立升级：
 *
 *   availability.json  { at, egress:{ip,country}, results:{ [modelId]: { state, detail, latencyMs, at } } }
 *   catalog.json       { entries:[id…], sealIds:[…], kiloRows:[{id,name,channel,…}], … }
 *   settings.json      { enabled, defaultMaxTokens, forward:{…}, … }
 *
 * 读不到、格式变了、权限不够，一律降级为 null / 空对象，绝不抛错：兼容包坏掉
 * 不应该让整个 DSH 起不来。
 *
 * @module src/availability
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** DSH_HOME 解析规则与 DSH 内核一致：环境变量优先，否则 ~/.dsh。 */
export function resolveDshHome(env = process.env) {
  const fromEnv = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), '.dsh');
}

/** our-free-model 自己的状态目录名，按上游 package name 推导。 */
export const OFM_STATE_DIRNAME = 'our-free-model';

export function ofmStateDir(home = resolveDshHome()) {
  return path.join(home, OFM_STATE_DIRNAME);
}

/** 宽容的 JSON 读取：去 BOM、失败返回 null。 */
export function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * 一次性读出我们关心的三份状态。
 *
 * 目录探测规则：优先 `<DSH_HOME>/our-free-model`；**仅当该目录根本不存在时**才回退到
 * `~/.dsh/our-free-model` —— 用于 DSH_HOME 被设成别处、而 our-free-model 仍写在默认
 * 位置的场景。刻意不用「主目录里没有文件就回退」，否则测试环境会读到真实机器的数据，
 * 断言就失去意义了。
 *
 * @param {string} [home] DSH_HOME
 * @returns {{dir:string, availability:object|null, catalog:object|null, settings:object|null, readAt:number}}
 */
export function readOfmState(home = resolveDshHome()) {
  const primary = ofmStateDir(home);
  const fallback = ofmStateDir(path.join(os.homedir(), '.dsh'));
  const dir =
    !fs.existsSync(primary) && fallback !== primary && fs.existsSync(fallback) ? fallback : primary;
  return {
    dir,
    availability: readJsonSafe(path.join(dir, 'availability.json')),
    catalog: readJsonSafe(path.join(dir, 'catalog.json')),
    settings: readJsonSafe(path.join(dir, 'settings.json')),
    readAt: Date.now(),
  };
}

/** 上游把「解析不出来」也算 unknown，这些状态直接视为不可用。 */
export const BLOCKED_STATES = new Set(['region-blocked', 'unavailable', 'deprecated', 'blocked']);

/**
 * our-free-model 在 detail 里用自然语言写原因，`state` 常常只是模棱两可的 `unknown`。
 * 这里按关键词把「明确不可用」和「只是未知」区分开 —— 这个区分正是自动选型的关键：
 * 实测数据里 10 个免费条目有 8 个是 `unknown` + “only be used from within OpenCode”，
 * 如果只看 state 就会把它们当成可用模型选出来，然后每一轮都失败。
 */
export const BLOCKED_DETAIL_RE =
  /deprecated|has been deprecated|not available in your country|region|only be used from within|no longer available|model is unavailable|unavailable in/i;

/**
 * @typedef {{level:'ok'|'unknown'|'blocked', detail:string, state:string}} OfmAvailabilityVerdict
 */

/**
 * 判定单个模型的本机可用性。
 * @param {{state?:string, detail?:string}|undefined|null} entry availability.json 里的一项
 * @returns {OfmAvailabilityVerdict}
 */
export function classifyOfmEntry(entry) {
  if (entry === null || typeof entry !== 'object') return { level: 'unknown', detail: '', state: '' };
  const state = String(entry.state ?? '').toLowerCase();
  const detail = String(entry.detail ?? '');
  if (state === 'available' || state === 'ok') return { level: 'ok', detail, state };
  if (BLOCKED_STATES.has(state)) return { level: 'blocked', detail, state };
  if (BLOCKED_DETAIL_RE.test(detail)) return { level: 'blocked', detail, state };
  return { level: 'unknown', detail, state };
}

/**
 * 把 availability.json 压成 `{ [modelId]: verdict }`。
 * @param {object|null} availability
 */
export function availabilityIndex(availability) {
  const results = availability?.results;
  const out = Object.create(null);
  if (results === null || typeof results !== 'object') return out;
  for (const [id, entry] of Object.entries(results)) out[id] = classifyOfmEntry(entry);
  return out;
}

/** 当前出口信息，用于状态展示（地区封锁时这行最有解释力）。 */
export function egressOf(availability) {
  const ip = availability?.egress?.ip;
  const country = availability?.egress?.country;
  return { ip: typeof ip === 'string' ? ip : '', country: typeof country === 'string' ? country : '' };
}
