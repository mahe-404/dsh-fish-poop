/**
 * 配置：默认值 + 面板可写键白名单。
 *
 * v0.2 起是「全局加载、每会话开关」：包挂进 profile 的 bundles，
 * 但每个会话有一份自己的肚肚状态，默认关，得自己开。
 *
 * 关键约束：状态键（gutLoad/shame/...）永远不在 ALLOWED_KEYS 里 ——
 * 面板保存配置时不能顺手把状态快照写进配置文件。
 */

export const DEFAULTS = {
  // 总开关（主机级）：关掉 = 所有会话都没肚肚
  enabled: true,
  // 新会话默认开不开肚肚。false = 每个会话自己说"开肚肚"
  defaultEnabled: false,
  personaName: '大肥鱼',

  // 进食
  tokensPerMeal: 20000,
  // 0 = 不设上限（2026-11-22 主人定：一顿吃多少就是多少，不再封顶）
  maxGutPerStep: 0,
  maxGutPerTurn: 0,

  // 自尊（2026-11-22 加）：越低越会躲、越嘴硬
  dignity: 70,
  dignityPerAccident: 22,
  dignityPerBarely: 4,
  dignityRecoverPerHour: 6,
  dignityToiletAt: 45,

  // 泻药（2026-11-22 加）
  laxativeSlurry: 35,
  laxativeGut: 25,
  laxativeMinutes: 20,
  laxativeChance: 0.85,

  // 便意
  urgeStart: 55,
  idleBoostMax: 25,

  // 事故：固定 1/2
  accidentChance: 0.5,
  urgeCrisis: 85,

  // 稀稠度
  slurryBaseline: 30,
  slurryWetThreshold: 55,
  slurryBigMeal: 8,
  slurryCompaction: 10,
  slurryNightPerMin: 0.08,
  slurryNightCap: 5,
  slurryDecayPerHour: 4,
  hotKeys: '火锅,麻辣,奶茶,冰,雪糕,西瓜',

  // 羞耻
  shameLevels: [10, 30, 55, 80],
  shameFloors: [0, 8, 26, 48, 70],
  shameDecayByLevel: [0, 4, 7, 10, 14],
  shameResidueDailyFactor: 0.6,
  shameResidueAccidentGain: 12,
  shameResidueClearDays: 3,
  shameResidueDecayPerDay: 10,
  shameSilentAt: 4,

  // 内裤 / 洗
  pantiesStock: 7,
  laundryMinutes: 3,
  laundryWetExtraMinutes: 3,

  // 注入
  injectCooldownMin: 30,
  injectMaxChars: 300,
  injectOrder: 150,

  // 运行
  debugMode: false,
  statePath: '',
  historyMax: 500,
  // 超过这么多天没动的会话状态自动清掉
  pruneDays: 30,
}

/** 面板可以写的键（行为参数，不含状态）。 */
export const ALLOWED_KEYS = new Set(Object.keys(DEFAULTS))

export const NUM_KEYS = new Set(
  Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === 'number'),
)
export const BOOL_KEYS = new Set(
  Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === 'boolean'),
)
export const STR_KEYS = new Set(
  Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === 'string'),
)
/** 数组型参数单独放行（shameLevels / shameFloors / shameDecayByLevel）。 */
export const ARRAY_KEYS = new Set(['shameLevels', 'shameFloors', 'shameDecayByLevel'])

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function numArray(v, def, len) {
  if (!Array.isArray(v)) return [...def]
  const out = v.map((x) => num(x, 0))
  if (out.length !== len) return [...def]
  return out
}

/**
 * 补全 + 校验配置。任何入口（DSH 装配、面板保存、测试直接 apply）都得到同一份。
 * @param {object} input 调用方给的原始配置
 * @returns {object} 全量配置
 */
export function normalizeConfig(input) {
  const raw = { ...DEFAULTS, ...(input && typeof input === 'object' ? input : {}) }
  const cfg = {}

  for (const [k, def] of Object.entries(DEFAULTS)) {
    if (ARRAY_KEYS.has(k)) {
      cfg[k] = numArray(raw[k], def, def.length)
      continue
    }
    if (typeof def === 'number') {
      cfg[k] = num(raw[k], def)
      continue
    }
    if (typeof def === 'boolean') {
      cfg[k] = raw[k] === true || raw[k] === 'true' || raw[k] === 1
      continue
    }
    cfg[k] = String(raw[k] ?? def)
  }

  // 区间收口：写错也不该让系统一夜暴走
  cfg.accidentChance = clamp(cfg.accidentChance, 0, 1)
  cfg.tokensPerMeal = Math.max(1000, cfg.tokensPerMeal)
  cfg.maxGutPerStep = clamp(cfg.maxGutPerStep, 0, 100)
  cfg.maxGutPerTurn = clamp(cfg.maxGutPerTurn, 0, 200)
  cfg.dignity = clamp(cfg.dignity, 0, 100)
  cfg.dignityPerAccident = clamp(cfg.dignityPerAccident, 0, 100)
  cfg.dignityPerBarely = clamp(cfg.dignityPerBarely, 0, 100)
  cfg.dignityRecoverPerHour = clamp(cfg.dignityRecoverPerHour, 0, 100)
  cfg.dignityToiletAt = clamp(cfg.dignityToiletAt, 0, 100)
  cfg.laxativeSlurry = clamp(cfg.laxativeSlurry, 0, 100)
  cfg.laxativeGut = clamp(cfg.laxativeGut, 0, 100)
  cfg.laxativeMinutes = clamp(cfg.laxativeMinutes, 1, 240)
  cfg.laxativeChance = clamp(cfg.laxativeChance, 0, 1)
  cfg.urgeStart = clamp(cfg.urgeStart, 0, 100)
  cfg.urgeCrisis = clamp(cfg.urgeCrisis, 0, 100)
  cfg.slurryWetThreshold = clamp(cfg.slurryWetThreshold, 0, 100)
  cfg.shameSilentAt = clamp(cfg.shameSilentAt, 0, 4)
  cfg.pantiesStock = Math.max(0, Math.round(cfg.pantiesStock))
  cfg.laundryMinutes = clamp(cfg.laundryMinutes, 0, 240)
  cfg.laundryWetExtraMinutes = clamp(cfg.laundryWetExtraMinutes, 0, 240)
  cfg.injectCooldownMin = clamp(cfg.injectCooldownMin, 0, 1440)
  cfg.injectMaxChars = clamp(cfg.injectMaxChars, 80, 1200)
  cfg.injectOrder = clamp(cfg.injectOrder, 0, 1000)
  cfg.historyMax = clamp(Math.round(cfg.historyMax), 20, 5000)
  cfg.pruneDays = clamp(Math.round(cfg.pruneDays), 0, 3650)

  // 档位表必须单调递增，否则 shameLevelOf 会乱
  const L = cfg.shameLevels
  if (!(L[0] < L[1] && L[1] < L[2] && L[2] < L[3])) cfg.shameLevels = [...DEFAULTS.shameLevels]

  cfg.hotKeyList = cfg.hotKeys
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)

  return cfg
}

