/**
 * 渠道（lane）识别与「白嫖优先」的测试。
 *
 * 用真实的 catalog.json 结构做固件：`sealIds` 是共付渠道（白嫖）的模型清单，
 * `entries` 是匿名免费通道，`kiloRows` 是 Kilo 渠道。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LANE_FREE,
  LANE_KILO,
  LANE_LABELS,
  LANE_SEALED,
  LANE_UNKNOWN,
  buildLaneIndex,
  laneDiagnostics,
  laneOf,
  normalizeLane,
} from '../src/lanes.js';
import { compareCandidates, normalizeLanes, pickModel, rankCandidates } from '../src/select.js';

// 照抄本机 catalog.json 的结构
const REAL_CATALOG = {
  version: 1,
  entries: [
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
  ],
  sealIds: [
    'deepseek-ai/deepseek-v4.1-flash',
    'moonshotai/kimi-k2.6',
    'moonshotai/kimi-k3',
    'openai/gpt-oss-20b',
    'z-ai/glm-5.3',
    'z-ai/glm-5.3-flash',
  ],
  kiloRows: [
    { id: 'kilo-auto/free', channel: 'kilo' },
    { id: 'stepfun/step-5-preview-free', channel: 'kilo' },
    { id: 'stealth/glyph-cluster', channel: 'kilo' },
  ],
};

const asAdvertised = (ids) => ids.map((model) => ({ model, provider: 'our-free-model' }));

// ── buildLaneIndex / laneOf ─────────────────────────────────────────────────

test('三条渠道都被正确识别', () => {
  const index = buildLaneIndex(REAL_CATALOG);
  assert.equal(laneOf('moonshotai/kimi-k3', index), LANE_SEALED);
  assert.equal(laneOf('ling-3.1-flash-free', index), LANE_FREE);
  assert.equal(laneOf('kilo-auto/free', index), LANE_KILO);
  assert.equal(laneOf('完全不认识的模型', index), LANE_UNKNOWN);
});

test('渠道计数正确', () => {
  const { counts } = buildLaneIndex(REAL_CATALOG);
  assert.equal(counts[LANE_SEALED], 6);
  assert.equal(counts[LANE_FREE], 10);
  assert.equal(counts[LANE_KILO], 3);
});

test('同一 id 出现在多处时以先命中者为准（共付 > 免费）', () => {
  const index = buildLaneIndex({
    sealIds: ['dual-model'],
    entries: ['dual-model', 'only-free'],
  });
  assert.equal(laneOf('dual-model', index), LANE_SEALED);
  assert.equal(laneOf('only-free', index), LANE_FREE);
});

test('catalog 残缺/为 null 时不抛错', () => {
  for (const value of [null, undefined, {}, { entries: 'nope' }, { kiloRows: [null, 42, {}] }]) {
    assert.doesNotThrow(() => buildLaneIndex(value));
  }
  assert.equal(laneOf('x', buildLaneIndex(null)), LANE_UNKNOWN);
  assert.equal(laneOf('x', null), LANE_UNKNOWN);
});

test('normalizeLane 只接受已知渠道', () => {
  assert.equal(normalizeLane('EAC'), LANE_SEALED);
  assert.equal(normalizeLane(' free '), LANE_FREE);
  assert.equal(normalizeLane('bogus'), '');
  assert.equal(normalizeLane(undefined), '');
});

test('normalizeLanes 去重、保序、丢弃非法值', () => {
  assert.deepEqual(normalizeLanes(['free', 'eac', 'free', 'bogus', '', 'kilo']), ['free', 'eac', 'kilo']);
  assert.deepEqual(normalizeLanes('nope'), []);
});

test('渠道有中文标签', () => {
  assert.match(LANE_LABELS[LANE_SEALED], /白嫖|共付/);
  assert.match(LANE_LABELS[LANE_FREE], /免费/);
});

// ── laneDiagnostics：白嫖渠道到底解开了没有 ─────────────────────────────────

test('共付渠道被解锁时报告 available', () => {
  const advertised = [...REAL_CATALOG.sealIds, 'ling-3.1-flash-free'];
  const lanes = laneDiagnostics(REAL_CATALOG, advertised);
  assert.equal(lanes.eac.state, 'available');
  assert.equal(lanes.eac.advertisedCount, 6);
  assert.equal(lanes.eac.catalogCount, 6);
  assert.deepEqual(lanes.eac.missing, []);
});

test('共付渠道未解锁时报告 hidden 并列出被摘掉的模型（关键场景）', () => {
  const advertised = ['ling-3.1-flash-free', 'cat-jam-free'];
  const lanes = laneDiagnostics(REAL_CATALOG, advertised);
  assert.equal(lanes.eac.state, 'hidden');
  assert.equal(lanes.eac.advertisedCount, 0);
  assert.equal(lanes.eac.missing.length, 6);
  assert.equal(lanes.free.state, 'available');
});

test('catalog 里本就没有的渠道报告 absent', () => {
  const lanes = laneDiagnostics({ entries: ['a'] }, ['a']);
  assert.equal(lanes.eac.state, 'absent');
  assert.equal(lanes.kilo.state, 'absent');
});

test('诊断不依赖 advertise 的顺序，也不受重复项影响', () => {
  const advertised = ['z-ai/glm-5.3', 'z-ai/glm-5.3', 'ling-3.1-flash-free'];
  const lanes = laneDiagnostics(REAL_CATALOG, advertised);
  assert.equal(lanes.eac.advertisedCount, 1);
  assert.equal(lanes.eac.state, 'available');
});

// ── 渠道偏好进入选型 ────────────────────────────────────────────────────────

test('白嫖优先：共付渠道模型压过匿名免费通道', () => {
  const laneIndex = buildLaneIndex(REAL_CATALOG);
  const advertised = asAdvertised(['ling-3.1-flash-free', 'moonshotai/kimi-k3']);
  const withPreference = pickModel({ advertised, laneIndex, preferLanes: [LANE_SEALED, LANE_FREE], now: 1 });
  assert.equal(withPreference.chosen?.model, 'moonshotai/kimi-k3');
  assert.equal(withPreference.reason, 'lane:eac');

  const withoutPreference = pickModel({ advertised, laneIndex, preferLanes: [], now: 1 });
  assert.equal(withoutPreference.chosen?.model, 'ling-3.1-flash-free', '关闭渠道偏好时保持上游顺序');
});

test('excludeLanes 把整条渠道摘掉', () => {
  const laneIndex = buildLaneIndex(REAL_CATALOG);
  const advertised = asAdvertised(['moonshotai/kimi-k3', 'ling-3.1-flash-free']);
  const result = pickModel({ advertised, laneIndex, excludeLanes: [LANE_SEALED], now: 1 });
  assert.equal(result.chosen?.model, 'ling-3.1-flash-free');
});

test('点名偏好压过渠道偏好', () => {
  const laneIndex = buildLaneIndex(REAL_CATALOG);
  const advertised = asAdvertised(['moonshotai/kimi-k3', 'ling-3.1-flash-free']);
  const result = pickModel({
    advertised,
    laneIndex,
    prefer: ['ling'],
    preferLanes: [LANE_SEALED],
    now: 1,
  });
  assert.equal(result.chosen?.model, 'ling-3.1-flash-free');
  assert.equal(result.reason, 'preferred');
});

test('粘性让位于渠道偏好：当前模型不是白嫖渠道时会被换掉', () => {
  const laneIndex = buildLaneIndex(REAL_CATALOG);
  const advertised = asAdvertised(['ling-3.1-flash-free', 'moonshotai/kimi-k3']);
  const result = pickModel({
    advertised,
    laneIndex,
    preferLanes: [LANE_SEALED],
    now: 1,
    previous: 'ling-3.1-flash-free',
  });
  assert.equal(result.chosen?.model, 'moonshotai/kimi-k3');
});

test('粘性仍然保留：当前模型已属最优渠道时不换', () => {
  const laneIndex = buildLaneIndex(REAL_CATALOG);
  const advertised = asAdvertised(['moonshotai/kimi-k3', 'moonshotai/kimi-k2.6']);
  const result = pickModel({
    advertised,
    laneIndex,
    preferLanes: [LANE_SEALED],
    now: 1,
    previous: 'moonshotai/kimi-k2.6',
  });
  assert.equal(result.chosen?.model, 'moonshotai/kimi-k2.6');
  assert.equal(result.reason, 'sticky');
});

test('候选带 lane 字段，便于状态展示', () => {
  const laneIndex = buildLaneIndex(REAL_CATALOG);
  const rows = rankCandidates({
    advertised: asAdvertised(['moonshotai/kimi-k3', 'ling-3.1-flash-free', 'kilo-auto/free']),
    laneIndex,
    now: 1,
  });
  assert.deepEqual(rows.map((row) => row.lane), [LANE_SEALED, LANE_FREE, LANE_KILO]);
});

test('渠道偏好与可用性同时作用时，先比渠道再比可用性', () => {
  const laneIndex = buildLaneIndex(REAL_CATALOG);
  const advertised = asAdvertised(['ling-3.1-flash-free', 'moonshotai/kimi-k3']);
  const availability = { 'moonshotai/kimi-k3': { level: 'unknown' }, 'ling-3.1-flash-free': { level: 'ok' } };
  const result = pickModel({ advertised, laneIndex, availability, preferLanes: [LANE_SEALED], now: 1 });
  assert.equal(result.chosen?.model, 'moonshotai/kimi-k3', '渠道偏好优先于可用性等级');
});

test('排序在不带渠道索引时保持原有的稳定行为', () => {
  const rows = rankCandidates({ advertised: asAdvertised(['b', 'a', 'c']), availability: {}, now: 1 });
  assert.deepEqual([...rows].sort(compareCandidates).map((row) => row.model), ['b', 'a', 'c']);
});
