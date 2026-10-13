/**
 * 候选模型排序与选取 —— 纯函数，不碰文件系统、不碰 ctx，方便单测。
 *
 * 设计目标（"保活" + "白嫖优先"）：
 *   1. 永不选中已知不可用的模型；
 *   2. 粘性优先：当前模型只要还健康就继续用，避免每轮换模型导致人格/语气漂移；
 *   3. 当前模型不健康时，按「点名偏好 > 渠道偏好 > 可用性 > 上游顺序」挑下一个；
 *   4. 冷却：刚刚失败的模型在一段时间内不再被选中。
 *
 * 两个偏好轴的先后是刻意的：用户点名了具体模型（prefer）时就不该被渠道偏好顶掉；
 * 只有用户没点名时，才让「白嫖渠道优先」起作用。
 *
 * @module src/select
 */

import { LANE_UNKNOWN, laneOf, normalizeLane } from './lanes.js';

/** @typedef {'ok'|'unknown'|'blocked'} Level */
/** @typedef {'excluded'|'cooldown'|'blocked'|Level} Rank */

/**
 * 把用户配置的 prefer / exclude 统一成小写字符串数组（支持包含匹配）。
 */
export function normalizePatterns(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim().toLowerCase());
}

/** 渠道列表归一化：丢掉无法识别的名字，保留顺序。 */
export function normalizeLanes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const lane = normalizeLane(item);
    if (lane && lane !== LANE_UNKNOWN && !out.includes(lane)) out.push(lane);
  }
  return out;
}

/** 模式匹配：完全相等或包含，都算命中。 */
export function matchesAny(id, patterns) {
  const needle = String(id ?? '').toLowerCase();
  if (needle === '') return false;
  return patterns.some((pattern) => needle === pattern || needle.includes(pattern));
}

/** 命中优先级：下标越小越优先；未命中返回 -1（排序时视为 Infinity）。 */
export function preferenceIndex(id, prefer) {
  const needle = String(id ?? '').toLowerCase();
  for (let i = 0; i < prefer.length; i += 1) {
    const pattern = prefer[i];
    if (needle === pattern || needle.includes(pattern)) return i;
  }
  return -1;
}

/** 渠道偏好下标：越靠前越优先；未列入返回 -1（排序时视为 Infinity）。 */
export function lanePreferenceIndex(lane, preferLanes) {
  if (!Array.isArray(preferLanes) || preferLanes.length === 0) return -1;
  const index = preferLanes.indexOf(lane);
  return index;
}

const LEVEL_WEIGHT = { ok: 0, unknown: 1 };

/**
 * @typedef {object} Candidate
 * @property {string} model  模型 id
 * @property {string} provider 拥有该模型的 provider 路由
 * @property {string} lane   所属渠道（eac / free / kilo / unknown）
 * @property {number} index  上游给出的顺序，用于稳定排序
 * @property {Rank} rank
 * @property {number} prefer 命中 prefer 的下标，-1 表示未命中
 * @property {number} lanePref 命中 preferLanes 的下标，-1 表示未列入
 * @property {number} coolingUntil 冷却截止时间戳，0 表示不冷却
 * @property {string} detail 不可用原因（用于状态展示）
 */

/**
 * 给候选打上 rank / prefer / 渠道 / 冷却信息。
 * @param {object} input
 * @param {Array<{model:string, provider:string}>} input.advertised 上游 advertise 的顺序
 * @param {Record<string, {level:Level, detail?:string}>} [input.availability] availabilityIndex() 的结果
 * @param {string[]} [input.prefer]
 * @param {string[]} [input.exclude]
 * @param {Record<string, number>} [input.cooldowns] modelId -> 冷却截止时间戳
 * @param {number} [input.now]
 * @param {object|null} [input.laneIndex] buildLaneIndex() 的结果
 * @param {string[]} [input.preferLanes]
 * @param {string[]} [input.excludeLanes]
 * @returns {Candidate[]}
 */
export function rankCandidates({
  advertised,
  availability = {},
  prefer = [],
  exclude = [],
  cooldowns = {},
  now = Date.now(),
  laneIndex = null,
  preferLanes = [],
  excludeLanes = [],
} = {}) {
  const rows = [];
  const seen = new Set();
  const list = Array.isArray(advertised) ? advertised : [];
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    const model = typeof item === 'string' ? item : String(item?.model ?? '');
    if (model === '' || seen.has(model)) continue;
    seen.add(model);
    const provider = typeof item === 'string' ? '' : String(item?.provider ?? '');
    const lane = laneIndex ? laneOf(model, laneIndex) : LANE_UNKNOWN;
    const patternHit = matchesAny(model, exclude);
    const laneHit = excludeLanes.includes(lane);
    const coolingUntil = Number(cooldowns?.[model] ?? 0);
    const verdict = availability?.[model] ?? { level: 'unknown', detail: '' };
    let rank;
    if (patternHit) rank = 'excluded';
    else if (laneHit) rank = 'excluded';
    else if (Number.isFinite(coolingUntil) && coolingUntil > now) rank = 'cooldown';
    else rank = verdict.level ?? 'unknown';
    rows.push({
      model,
      provider,
      lane,
      index,
      rank,
      prefer: preferenceIndex(model, prefer),
      lanePref: lanePreferenceIndex(lane, preferLanes),
      coolingUntil: Number.isFinite(coolingUntil) ? coolingUntil : 0,
      detail: String(verdict.detail ?? ''),
    });
  }
  return rows;
}

/** 只有这些 rank 才允许被选中。 */
export function isUsable(row) {
  return row.rank === 'ok' || row.rank === 'unknown';
}

/** 排序：点名偏好 > 渠道偏好 > 可用性 > 上游顺序。 */
export function compareCandidates(a, b) {
  const preferA = a.prefer < 0 ? Number.POSITIVE_INFINITY : a.prefer;
  const preferB = b.prefer < 0 ? Number.POSITIVE_INFINITY : b.prefer;
  if (preferA !== preferB) return preferA - preferB;

  const laneA = (a.lanePref ?? -1) < 0 ? Number.POSITIVE_INFINITY : a.lanePref;
  const laneB = (b.lanePref ?? -1) < 0 ? Number.POSITIVE_INFINITY : b.lanePref;
  if (laneA !== laneB) return laneA - laneB;

  const weightA = LEVEL_WEIGHT[a.rank] ?? 2;
  const weightB = LEVEL_WEIGHT[b.rank] ?? 2;
  if (weightA !== weightB) return weightA - weightB;
  return a.index - b.index;
}

/**
 * 选取本轮使用的模型。
 * @param {object} input 见 rankCandidates，另有下面几项
 * @param {string|null} [input.previous] 上一次实际选中的模型（粘性）
 * @param {boolean} [input.sticky] 是否启用粘性，默认 true
 * @returns {{chosen: Candidate|null, reason: string, ranked: Candidate[], usableCount: number}}
 */
export function pickModel({
  advertised,
  availability = {},
  prefer = [],
  exclude = [],
  cooldowns = {},
  now = Date.now(),
  laneIndex = null,
  preferLanes = [],
  excludeLanes = [],
  previous = null,
  sticky = true,
} = {}) {
  const ranked = rankCandidates({
    advertised,
    availability,
    prefer,
    exclude,
    cooldowns,
    now,
    laneIndex,
    preferLanes,
    excludeLanes,
  });
  const usable = ranked.filter(isUsable).sort(compareCandidates);
  if (usable.length === 0) {
    const blocked = ranked.filter((row) => row.rank === 'blocked').length;
    const cooled = ranked.filter((row) => row.rank === 'cooldown').length;
    const excluded = ranked.filter((row) => row.rank === 'excluded').length;
    return {
      chosen: null,
      reason: ranked.length === 0 ? 'no_candidates' : `no_usable_model(blocked=${blocked},cooldown=${cooled},excluded=${excluded})`,
      ranked,
      usableCount: 0,
    };
  }

  if (sticky && typeof previous === 'string' && previous !== '') {
    const kept = usable.find((row) => row.model === previous);
    // 粘性只在「当前模型没有更差」时生效。若用户点名了别的模型，或点名模型所属渠道
    // 更优先，则让偏好胜出 —— 否则用户设了偏好却永远切不过去。
    if (kept) {
      const better = usable[0];
      const preferWins = better.prefer >= 0 && kept.prefer < 0;
      const laneWins = better.lanePref >= 0 && kept.lanePref < 0;
      if (!preferWins && !laneWins) {
        return { chosen: kept, reason: 'sticky', ranked, usableCount: usable.length };
      }
    }
  }

  const best = usable[0];
  const reason =
    best.prefer >= 0
      ? 'preferred'
      : best.lanePref >= 0
        ? `lane:${best.lane}`
        : best.rank === 'ok'
          ? 'available'
          : 'fallback_unknown';
  return { chosen: best, reason, ranked, usableCount: usable.length };
}
