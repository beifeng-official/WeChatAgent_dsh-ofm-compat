import test from 'node:test';
import assert from 'node:assert/strict';

import { availabilityIndex, classifyOfmEntry, egressOf, resolveDshHome } from '../src/availability.js';
import {
  compareCandidates,
  matchesAny,
  normalizePatterns,
  pickModel,
  preferenceIndex,
  rankCandidates,
} from '../src/select.js';

// ── 真实数据固件 ──────────────────────────────────────────────────────────────
// 直接照抄本机 availability.json 的实测内容：10 个免费条目里 8 个被上游以
// “only be used from within OpenCode” 拒绝、2 个地区封锁，1 个曾经 available。
const REAL_AVAILABILITY = {
  version: 1,
  egress: { ip: '222.20.193.171', country: 'CN' },
  results: {
    'jev-1.13-free': { state: 'unknown', detail: "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building." },
    'muse-spark-1.2-contributor-free': { state: 'region-blocked', detail: 'This model is not available in your country' },
    'muse-spark-1.3-contributor-free': { state: 'region-blocked', detail: 'This model is not available in your country' },
    'space-bunny-free': { state: 'unknown', detail: "OpenCode's free tier can only be used from within OpenCode." },
    'longcat-2.5-preview-free': { state: 'unknown', detail: "OpenCode's free tier can only be used from within OpenCode." },
    'step-5-preview-free': { state: 'unknown', detail: "OpenCode's free tier can only be used from within OpenCode." },
    'ling-3.0-flash-fin-free': { state: 'unavailable', detail: 'Upstream request failed: Model is unavailable.' },
    'nemotron-3-ultra-free': { state: 'available', ttftMs: 1909, latencyMs: 3888 },
    'mimo-v2.6-flash-free': { state: 'unknown', detail: "OpenCode's free tier can only be used from within OpenCode." },
    'nemotron-3.5-lightning-free': { state: 'unknown', detail: "OpenCode's free tier can only be used from within OpenCode." },
    'ling-3.1-flash-free': { state: 'unknown', detail: "OpenCode's free tier can only be used from within OpenCode." },
    'cat-jam-free': { state: 'unknown', detail: "OpenCode's free tier can only be used from within OpenCode." },
  },
};

const REAL_CATALOG_ENTRIES = [
  'ling-3.1-flash-free',
  'cat-jam-free',
  'mimo-v2.6-flash-free',
  'muse-spark-1.2-contributor-free',
  'muse-spark-1.3-contributor-free',
  'nemotron-3.5-lightning-free',
  'jev-1.13-free',
  'step-5-preview-free',
  'longcat-2.5-preview-free',
  'space-bunny-free',
];

const asAdvertised = (ids) => ids.map((model) => ({ model, provider: 'our-free-model' }));

// ── availability.classifyOfmEntry ────────────────────────────────────────────

test('available 判定为 ok', () => {
  assert.equal(classifyOfmEntry({ state: 'available' }).level, 'ok');
});

test('region-blocked / unavailable 判定为 blocked', () => {
  assert.equal(classifyOfmEntry({ state: 'region-blocked', detail: 'not available in your country' }).level, 'blocked');
  assert.equal(classifyOfmEntry({ state: 'unavailable', detail: 'Model is unavailable.' }).level, 'blocked');
});

test('state=unknown 但 detail 含上游拒绝理由时判定为 blocked（关键修正）', () => {
  const verdict = classifyOfmEntry({
    state: 'unknown',
    detail: "OpenCode's free tier can only be used from within OpenCode.",
  });
  assert.equal(verdict.level, 'blocked');
});

test('deprecated 与 not available in your country 也算 blocked', () => {
  assert.equal(classifyOfmEntry({ state: 'unknown', detail: 'Model exo-free has been deprecated.' }).level, 'blocked');
  assert.equal(classifyOfmEntry({ state: 'unknown', detail: 'This model is not available in your country' }).level, 'blocked');
});

test('真正的未知（无 detail / 无害 detail）保持 unknown，仍然可用', () => {
  assert.equal(classifyOfmEntry({ state: 'unknown' }).level, 'unknown');
  assert.equal(classifyOfmEntry({ state: 'probing', detail: 'latency measured' }).level, 'unknown');
  assert.equal(classifyOfmEntry(undefined).level, 'unknown');
  assert.equal(classifyOfmEntry(null).level, 'unknown');
});

test('availabilityIndex 与 egressOf', () => {
  const index = availabilityIndex(REAL_AVAILABILITY);
  assert.equal(index['nemotron-3-ultra-free'].level, 'ok');
  assert.equal(index['cat-jam-free'].level, 'blocked');
  assert.deepEqual(egressOf(REAL_AVAILABILITY), { ip: '222.20.193.171', country: 'CN' });
  assert.deepEqual(egressOf(null), { ip: '', country: '' });
  // availabilityIndex 故意返回 null 原型对象（防御 __proto__/constructor 之类的模型 id），
  // 所以用键集合断言而不是 deepEqual({})。
  assert.equal(Object.getPrototypeOf(availabilityIndex(null)), null);
  assert.deepEqual(Object.keys(availabilityIndex(null)), []);
  assert.deepEqual(Object.keys(availabilityIndex(REAL_AVAILABILITY)).length, 12);
});

test('resolveDshHome 环境变量优先', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'C:\\custom' }), 'C:\\custom');
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }).endsWith('.dsh'), true);
});

// ── select 基础工具 ──────────────────────────────────────────────────────────

test('normalizePatterns 过滤空值并小写化', () => {
  assert.deepEqual(normalizePatterns([' Kimi ', '', null, 7, 'glm']), ['kimi', 'glm']);
  assert.deepEqual(normalizePatterns('nope'), []);
});

test('matchesAny 支持完全相等与包含', () => {
  assert.equal(matchesAny('moonshotai/kimi-k3', ['kimi']), true);
  assert.equal(matchesAny('KIMI-K3', ['kimi']), true);
  assert.equal(matchesAny('glm-5.3', ['kimi']), false);
});

test('preferenceIndex 返回最小命中下标', () => {
  assert.equal(preferenceIndex('moonshotai/kimi-k3', ['kimi', 'k3']), 0);
  assert.equal(preferenceIndex('glm-5.3', ['kimi', 'glm']), 1);
  assert.equal(preferenceIndex('other', ['kimi']), -1);
});

// ── 真实场景：只有一个模型真的可用 ───────────────────────────────────────────

test('真实场景：10 个被拒条目里挑出唯一 available 的模型', () => {
  const advertised = asAdvertised([...REAL_CATALOG_ENTRIES, 'nemotron-3-ultra-free']);
  const result = pickModel({
    advertised,
    availability: availabilityIndex(REAL_AVAILABILITY),
    now: 1_000_000,
  });
  assert.equal(result.chosen?.model, 'nemotron-3-ultra-free');
  assert.equal(result.reason, 'available');
  assert.equal(result.usableCount, 1);
});

test('真实场景：若 available 的模型从列表消失则整体不可用（不误选 blocked 的）', () => {
  const advertised = asAdvertised(REAL_CATALOG_ENTRIES);
  const result = pickModel({
    advertised,
    availability: availabilityIndex(REAL_AVAILABILITY),
    now: 1_000_000,
  });
  assert.equal(result.chosen, null);
  assert.match(result.reason, /^no_usable_model/);
  assert.equal(result.usableCount, 0);
});

test('完全未知的模型可用，但排序在 ok 之后', () => {
  const advertised = asAdvertised(['mystery-a', 'mystery-b', 'nemotron-3-ultra-free']);
  const result = pickModel({ advertised, availability: availabilityIndex(REAL_AVAILABILITY), now: 1 });
  assert.equal(result.chosen?.model, 'nemotron-3-ultra-free');
  assert.equal(result.usableCount, 3);
});

// ── 粘性 ────────────────────────────────────────────────────────────────────

test('粘性：当前模型仍健康就继续用（避免每轮换模型）', () => {
  const advertised = asAdvertised(['model-a', 'model-b']);
  const result = pickModel({ advertised, availability: {}, now: 1, previous: 'model-b' });
  assert.equal(result.chosen?.model, 'model-b');
  assert.equal(result.reason, 'sticky');
});

test('粘性：当前模型变 blocked 时自动切换', () => {
  const advertised = asAdvertised(['model-a', 'model-b']);
  const availability = { 'model-b': { level: 'blocked', detail: 'region-blocked' } };
  const result = pickModel({ advertised, availability, now: 1, previous: 'model-b' });
  assert.equal(result.chosen?.model, 'model-a');
  assert.notEqual(result.reason, 'sticky');
});

test('粘性让位于用户显式偏好', () => {
  const advertised = asAdvertised(['model-a', 'model-b']);
  const result = pickModel({ advertised, availability: {}, prefer: ['model-a'], now: 1, previous: 'model-b' });
  assert.equal(result.chosen?.model, 'model-a');
  assert.equal(result.reason, 'preferred');
});

test('sticky=false 时总是重新排序', () => {
  const advertised = asAdvertised(['model-a', 'model-b']);
  const result = pickModel({ advertised, availability: {}, now: 1, previous: 'model-b', sticky: false });
  assert.equal(result.chosen?.model, 'model-a');
});

// ── 冷却与排除 ──────────────────────────────────────────────────────────────

test('冷却期内的模型被跳过，到期后恢复', () => {
  const advertised = asAdvertised(['model-a', 'model-b']);
  const cooled = pickModel({ advertised, availability: {}, now: 1000, cooldowns: { 'model-a': 5000 } });
  assert.equal(cooled.chosen?.model, 'model-b');

  const expired = pickModel({ advertised, availability: {}, now: 6000, cooldowns: { 'model-a': 5000 } });
  assert.equal(expired.chosen?.model, 'model-a');
});

test('全部冷却时报告 no_usable_model 且说明原因', () => {
  const advertised = asAdvertised(['model-a', 'model-b']);
  const result = pickModel({ advertised, availability: {}, now: 1000, cooldowns: { 'model-a': 5000, 'model-b': 5000 } });
  assert.equal(result.chosen, null);
  assert.match(result.reason, /cooldown=2/);
});

test('exclude 模式优先于一切', () => {
  const advertised = asAdvertised(['kimi-k3', 'glm-5.3']);
  const result = pickModel({ advertised, availability: {}, exclude: ['kimi'], now: 1 });
  assert.equal(result.chosen?.model, 'glm-5.3');
  const allOut = pickModel({ advertised, availability: {}, exclude: ['kimi', 'glm'], now: 1 });
  assert.equal(allOut.chosen, null);
  assert.match(allOut.reason, /excluded=2/);
});

test('prefer 命中优先于可用性等级', () => {
  const advertised = asAdvertised(['model-ok', 'model-unknown']);
  const availability = { 'model-ok': { level: 'ok' }, 'model-unknown': { level: 'unknown' } };
  const byLevel = pickModel({ advertised, availability, now: 1 });
  assert.equal(byLevel.chosen?.model, 'model-ok');

  const byPrefer = pickModel({ advertised, availability, prefer: ['model-unknown'], now: 1 });
  assert.equal(byPrefer.chosen?.model, 'model-unknown');
});

// ── 边界与稳定性 ────────────────────────────────────────────────────────────

test('空候选列表返回 no_candidates', () => {
  const result = pickModel({ advertised: [], availability: {} });
  assert.equal(result.chosen, null);
  assert.equal(result.reason, 'no_candidates');
});

test('重复模型只保留第一次出现（provider 顺序即优先级）', () => {
  const advertised = [
    { model: 'dup', provider: 'our-free-model' },
    { model: 'dup', provider: 'our-free-model-region' },
    { model: 'other', provider: 'our-free-model' },
  ];
  const rows = rankCandidates({ advertised, now: 1 });
  assert.equal(rows.filter((row) => row.model === 'dup').length, 1);
  assert.equal(rows.find((row) => row.model === 'dup').provider, 'our-free-model');
});

test('排序在完全相同的输入下是确定的', () => {
  const advertised = asAdvertised(['b', 'a', 'c']);
  const rows = rankCandidates({ advertised, availability: {}, now: 1 }).filter((row) => row.rank !== 'blocked');
  const sorted = [...rows].sort(compareCandidates).map((row) => row.model);
  assert.deepEqual(sorted, ['b', 'a', 'c']); // 未命中 prefer 时按上游顺序，保持稳定
});

test('候选项缺字段不会导致抛错', () => {
  const advertised = [null, undefined, { model: '' }, {}, 'ok-model'];
  const result = pickModel({ advertised, availability: {}, now: 1 });
  assert.equal(result.chosen?.model, 'ok-model');
});
