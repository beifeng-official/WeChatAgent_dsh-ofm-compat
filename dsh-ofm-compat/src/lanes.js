/**
 * 渠道（lane）识别 —— 「白嫖模型接入」的适配基础。
 *
 * dsh-our-free-model 把免费额度分成几条互不相同的渠道，各自的代价与门槛都不同：
 *
 *   eac   共付渠道（俗称「白嫖」）。凭据以 AES-GCM 封印形式随包分发，**只有在被认可的
 *         DSH 宿主里才会解开**（见它的 src/vault.js `detectSealedHost`：profile 名为
 *         `desktop` / `web` / `web-desktop`，或 Tauri AIO 的三重特征）。解开前模型
 *         **被从列表里整个摘掉**，只留一条 logger.warn —— 在 WeChatAgent 里完全看不见。
 *   free  匿名免费通道。catalog.json 的 `entries`。
 *   kilo  Kilo 渠道。catalog.json 的 `kiloRows`，id 形如 `org/model` 常带 `:free` 后缀。
 *
 * 本模块只读 catalog.json 做**静态**分类（不碰凭据、不解封印、不发起任何网络请求），
 * 把「某个模型属于哪条渠道」变成可排序、可过滤、可展示的事实。
 *
 * @module src/lanes
 */

/** 渠道 id，按「越白嫖越靠前」排列，这个顺序就是默认偏好顺序。 */
export const LANE_SEALED = 'eac';
export const LANE_FREE = 'free';
export const LANE_KILO = 'kilo';
export const LANE_UNKNOWN = 'unknown';

export const LANE_ORDER = Object.freeze([LANE_SEALED, LANE_FREE, LANE_KILO, LANE_UNKNOWN]);

export const LANE_LABELS = Object.freeze({
  [LANE_SEALED]: '共付渠道（白嫖）',
  [LANE_FREE]: '匿名免费通道',
  [LANE_KILO]: 'Kilo 渠道',
  [LANE_UNKNOWN]: '未分类渠道',
});

/** 共付渠道被摘掉时的解释，直接给用户看。 */
export const SEALED_HIDDEN_HINT =
  '共付渠道未解锁：our-free-model 只在被认可的 DSH 宿主里解开封印凭据' +
  '（profile 名为 desktop / web / web-desktop）。未解锁时它的模型会被整个摘掉，' +
  '不会出现在候选里。WeChatAgent 用的 desktop profile 本应满足条件 —— ' +
  '若这里显示 hidden，请确认 DSH 确实是它自带的那个运行时，且内核提供了 profile 上下文。';

const KNOWN = new Set(LANE_ORDER);

/** 把任意输入归一成已知渠道 id。大小写与首尾空白都会被容忍。 */
export function normalizeLane(value) {
  const lane = String(value ?? '').trim().toLowerCase();
  return KNOWN.has(lane) ? lane : '';
}

/**
 * 从 catalog.json 建立 `modelId -> lane` 索引。
 *
 * 顺序即优先级：先认 `sealIds`（共付），再 `entries`（匿名免费），再 `kiloRows`，
 * 最后兜底扫带 `channel` 字段的行。同一个 id 出现在多处时以先命中者为准 ——
 * 这样「既在 sealIds 又在别处」的 id 会被正确归为共付渠道。
 *
 * @param {object|null|undefined} catalog our-free-model 的 catalog.json
 * @returns {{byModel: Record<string,string>, lanes: Record<string,string[]>, counts: Record<string,number>}}
 */
export function buildLaneIndex(catalog) {
  const byModel = Object.create(null);
  const lanes = { [LANE_SEALED]: [], [LANE_FREE]: [], [LANE_KILO]: [], [LANE_UNKNOWN]: [] };

  const add = (rawId, lane) => {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (id === '') return;
    if (byModel[id] !== undefined) return; // 先命中者胜
    byModel[id] = lane;
    lanes[lane].push(id);
  };

  const source = catalog && typeof catalog === 'object' ? catalog : {};

  if (Array.isArray(source.sealIds)) for (const id of source.sealIds) add(id, LANE_SEALED);
  if (Array.isArray(source.entries)) for (const id of source.entries) add(id, LANE_FREE);
  if (Array.isArray(source.kiloRows)) {
    for (const row of source.kiloRows) add(typeof row === 'string' ? row : row?.id, LANE_KILO);
  }

  // 兜底：某些版本会把完整行放在 rows/catalog 里，带显式 channel 字段。
  const rows = Array.isArray(source.rows) ? source.rows : Array.isArray(source.catalog) ? source.catalog : [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.channel === LANE_SEALED) add(row.id, LANE_SEALED);
    else if (row.channel === LANE_KILO) add(row.id, LANE_KILO);
  }

  const counts = Object.create(null);
  for (const lane of LANE_ORDER) counts[lane] = lanes[lane].length;
  return { byModel, lanes, counts };
}

/** 查一个模型属于哪条渠道；索引里没有就返回 'unknown'。 */
export function laneOf(model, index) {
  if (!index || !index.byModel) return LANE_UNKNOWN;
  return index.byModel[String(model ?? '')] ?? LANE_UNKNOWN;
}

/**
 * 渠道可用性诊断：对比「catalog 里本可以有」与「实际 advertise 出来的」。
 *
 * 这是本模块最有价值的一件事。our-free-model 在共付渠道未解锁时**静默摘除**模型，
 * 只在日志里 warn 一句；对比两个集合就能把这件事变成一个确定的事实，写进 /status。
 *
 * @param {object|null} catalog our-free-model 的 catalog.json
 * @param {Iterable<string>} advertised 当前真正 advertise 出来的模型 id
 * @returns {Record<string, {label:string, catalogCount:number, advertisedCount:number, state:'available'|'hidden'|'absent', missing:string[]}>}
 */
export function laneDiagnostics(catalog, advertised) {
  const index = buildLaneIndex(catalog);
  const shown = new Set([...advertised ?? []].map((id) => String(id)));
  const out = Object.create(null);
  for (const lane of LANE_ORDER) {
    if (lane === LANE_UNKNOWN) continue;
    const all = index.lanes[lane] ?? [];
    const present = all.filter((id) => shown.has(id));
    out[lane] = {
      label: LANE_LABELS[lane],
      catalogCount: all.length,
      advertisedCount: present.length,
      state: all.length === 0 ? 'absent' : present.length > 0 ? 'available' : 'hidden',
      missing: all.filter((id) => !shown.has(id)),
    };
  }
  return out;
}
