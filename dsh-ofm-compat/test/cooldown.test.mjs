import test from 'node:test';
import assert from 'node:assert/strict';

import { bumpStrikes, clearStrikes, escalateCooldown } from '../src/cooldown.js';

const BASE = 900000; // 15 分钟
const MAX = 3600000; // 1 小时

test('连续失败时冷却翻倍', () => {
  assert.equal(escalateCooldown(BASE, 1, MAX), BASE); // 15 分钟
  assert.equal(escalateCooldown(BASE, 2, MAX), 2 * BASE); // 30 分钟
  assert.equal(escalateCooldown(BASE, 3, MAX), MAX); // 60 分钟（正好到顶）
  assert.equal(escalateCooldown(BASE, 4, MAX), MAX); // 封顶
});

test('失败次数很大也不会溢出成 Infinity', () => {
  const value = escalateCooldown(BASE, 5000, MAX);
  assert.equal(value, MAX);
  assert.equal(Number.isFinite(value), true);
});

test('异常输入退化为最保守的行为', () => {
  assert.equal(escalateCooldown(BASE, 0, MAX), BASE, 'strikes<1 按第一此处理');
  assert.equal(escalateCooldown(BASE, -3, MAX), BASE);
  assert.equal(escalateCooldown(BASE, NaN, MAX), BASE);
  assert.equal(escalateCooldown(0, 3, MAX), 0, '基础冷却为 0 表示不冷却');
  assert.equal(escalateCooldown(-5, 3, MAX), 0);
});

test('上限小于基础值时不会低于基础值', () => {
  assert.equal(escalateCooldown(BASE, 3, 1000), BASE);
});

test('上限缺失时退化为基础值（不无限增长）', () => {
  assert.equal(escalateCooldown(BASE, 5, NaN), BASE);
});

test('bumpStrikes 递增，clearStrikes 清零', () => {
  const map = Object.create(null);
  assert.equal(bumpStrikes(map, 'eac'), 1);
  assert.equal(bumpStrikes(map, 'eac'), 2);
  assert.equal(bumpStrikes(map, 'kilo'), 1);
  assert.deepEqual({ ...map }, { eac: 2, kilo: 1 });

  assert.equal(clearStrikes(map, 'eac'), true);
  assert.equal(clearStrikes(map, 'eac'), false, '已经清过了就该返回 false');
  assert.deepEqual({ ...map }, { kilo: 1 });
});

test('clearStrikes 对空 map 安全', () => {
  assert.equal(clearStrikes(null, 'x'), false);
  assert.equal(clearStrikes(Object.create(null), 'x'), false);
});

test('模型 id 若叫 __proto__ 也不会污染原型', () => {
  const map = Object.create(null);
  bumpStrikes(map, '__proto__');
  bumpStrikes(map, '__proto__');
  assert.equal(map.__proto__, 2);
  assert.equal({}.__proto__, 2 === 2 ? Object.prototype : null, 'Object.prototype 未被污染');
});
