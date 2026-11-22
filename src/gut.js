/**
 * 肚肚的全部数值逻辑 —— 纯函数，不碰文件、不碰 ctx、不看时钟（时间从参数进）。
 *
 * 这样做的唯一理由：事故判定、羞耻档位、上限这些规则必须能被测试按住。
 */

const HOUR = 3_600_000
const DAY = 86_400_000

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
export const round2 = (v) => Math.round(Number(v) * 100) / 100
const num = (v, d = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** 稳定的一天：跨零点才算换天。 */
export function dateKey(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 全新状态（第一次装、文件损坏、手动清空都用它）。 */
export function newState(now = Date.now(), cfg = {}) {
  const stock = num(cfg.pantiesStock, 7)
  return {
    v: 1,
    gutLoad: 0,
    urge: 0,
    slurry: num(cfg.slurryBaseline, 30),
    shame: 0,
    shameLevel: 0,
    shameResidue: 0,
    // 自尊：事故掉、时间恢复；低于 dignityToiletAt 时她优先"找借口去厕所"而不是死撑
    dignity: num(cfg.dignity, 70),
    dignityAt: now,
    holdRounds: 0,
    pantiesDirty: 0,
    pantiesStock: stock,
    accidentsTotal: 0,
    accidentsToday: 0,
    accidentsByDay: {},
    accidentFreeDays: 0,
    day: dateKey(now),
    lastFeedAt: 0,
    lastAccidentAt: 0,
    lastAccidentWet: false,
    lastPoopAt: 0,
    lastInjectAt: 0,
    lastInjectKey: '',
    lastCue: '',
    laundryUntil: 0,
    laundryWet: false,
    turnSpent: 0,
    lastTickAt: now,
    updatedAt: now,
  }
}

/** 把外部读进来的状态补全成新形状（老版本文件 / 手改过的文件）。 */
export function normalizeState(raw, now = Date.now(), cfg = {}) {
  const base = newState(now, cfg)
  if (!raw || typeof raw !== 'object') return base
  const out = { ...base }
  for (const k of Object.keys(base)) {
    if (raw[k] === undefined) continue
    if (k === 'accidentsByDay') {
      out[k] = raw[k] && typeof raw[k] === 'object' ? { ...raw[k] } : {}
      continue
    }
    out[k] = typeof base[k] === 'number' ? num(raw[k], base[k]) : raw[k]
  }
  out.gutLoad = clamp(out.gutLoad, 0, 100)
  out.urge = clamp(out.urge, 0, 100)
  out.slurry = clamp(out.slurry, 0, 100)
  out.shame = clamp(out.shame, 0, 100)
  out.shameResidue = clamp(out.shameResidue, 0, 100)
  out.shameLevel = clamp(Math.round(out.shameLevel), 0, 4)
  out.dignity = clamp(num(out.dignity, num(cfg.dignity, 70)), 0, 100)
  out.pantiesDirty = Math.max(0, Math.round(out.pantiesDirty))
  out.pantiesStock = Math.max(0, Math.round(out.pantiesStock))
  out.holdRounds = Math.max(0, Math.round(out.holdRounds))
  out.accidentsTotal = Math.max(0, Math.round(out.accidentsTotal))
  out.accidentsToday = Math.max(0, Math.round(out.accidentsToday))
  out.v = 1
  return out
}

// ── 羞耻档 ───────────────────────────────────────────────────────────────────

/** 瞬时羞耻 → 档位（0–4）。 */
export function shameLevelOf(shame, cfg) {
  const levels = cfg.shameLevels ?? [10, 30, 55, 80]
  const s = num(shame)
  if (s >= levels[3]) return 4
  if (s >= levels[2]) return 3
  if (s >= levels[1]) return 2
  if (s >= levels[0]) return 1
  return 0
}

/** 该档的下限：跌到这里就停住，不会自己滑回低档。 */
export function shameFloor(level, cfg) {
  const floors = cfg.shameFloors ?? [0, 8, 26, 48, 70]
  return num(floors[clamp(Math.round(level), 0, 4)], 0)
}

/** 该档每小时衰减多少。Lv.0 不再衰减。 */
export function shameDecayRate(level, cfg) {
  const rates = cfg.shameDecayByLevel ?? [0, 4, 7, 10, 14]
  return num(rates[clamp(Math.round(level), 0, 4)], 0)
}

/** 升档：羞耻越过上一档线就抬档，并保证不低于新档下限。 */
export function raiseLevel(state, cfg) {
  const next = shameLevelOf(state.shame, cfg)
  if (next > state.shameLevel) {
    state.shameLevel = next
    state.shame = Math.max(state.shame, shameFloor(next, cfg))
  }
  return state
}

// ── 进食 ─────────────────────────────────────────────────────────────────────

/**
 * 一顿饭：新吃进去的 token 才算饭，cache 命中的是「又嚼了一遍」。
 * @param {object} state 状态（会被克隆后返回）
 * @param {{inputTokens:number,outputTokens:number,cacheReadTokens:number}} sample 一次模型调用的用量
 * @param {object} cfg 配置
 * @param {number} now 时间戳
 * @returns {{state:object, got:number, bigMeal:boolean, wet:boolean}}
 */
export function feed(state, sample, cfg, now = Date.now()) {
  const next = { ...state }
  const input = Math.max(0, num(sample?.inputTokens))
  const cache = Math.max(0, num(sample?.cacheReadTokens))
  const output = Math.max(0, num(sample?.outputTokens))
  // fresh = 真正新塞进来的上下文（cache 读的是同一份旧饭，不算加餐）
  const fresh = Math.max(0, input - cache)
  const perMeal = Math.max(1000, num(cfg?.tokensPerMeal, 20000))

  let got = ((fresh + output * 1.2) / perMeal) * 15
  // 0 = 不设上限（2026-11-22 起默认 0）
  const stepCap = num(cfg?.maxGutPerStep, 0)
  if (stepCap > 0) got = Math.min(got, stepCap)
  const turnCap = num(cfg?.maxGutPerTurn, 0)
  if (turnCap > 0) {
    const room = Math.max(0, turnCap - num(next.turnSpent, 0))
    got = Math.min(got, room)
  }
  if (!(got > 0)) return { state: next, got: 0, bigMeal: false, wet: false }

  next.gutLoad = clamp(num(next.gutLoad) + got, 0, 100)
  next.turnSpent = num(next.turnSpent) + got
  next.lastFeedAt = now

  const bigMeal = input >= 15000
  let wet = false
  if (bigMeal) {
    next.slurry = clamp(next.slurry + num(cfg?.slurryBigMeal, 8), 0, 100)
    wet = true
  }
  next.updatedAt = now
  return { state: next, got: round2(got), bigMeal, wet }
}

/** 一轮结束，把这一轮的进食预算清零。 */
export function endTurnBudget(state, now = Date.now()) {
  return { ...state, turnSpent: 0, updatedAt: now }
}

// ── 便意 ─────────────────────────────────────────────────────────────────────

/**
 * 便意是推导出来的，不是累加的。
 * @param {object} state 状态
 * @param {object} cfg 配置
 * @param {number} now 当前时间
 * @returns {number} 0–100
 */
export function urgeOf(state, cfg, now = Date.now()) {
  const gut = num(state?.gutLoad)
  const start = num(cfg?.urgeStart, 55)
  if (gut <= start) return 0
  const ratio = (gut - start) / Math.max(1, 100 - start)
  const idleMin = Math.max(0, (now - num(state?.lastFeedAt, now)) / 60000)
  const idle = Math.min(num(cfg?.idleBoostMax, 25), idleMin * 0.3)
  return clamp(ratio * 100 + idle, 0, 100)
}

// ── 定时演化 ─────────────────────────────────────────────────────────────────

/**
 * 时间流逝：羞耻衰减（到档位下限停住）、稀度回落、换天结算。
 * 纯函数：同样的 (state, cfg, now) 反复调用不会重复扣（靠 lastTickAt 计时）。
 * @returns {{state:object, events:string[], laundryDone:boolean, leveledDown:boolean}}
 */
export function tick(state, cfg, now = Date.now()) {
  const next = { ...state }
  const events = []
  const prev = num(next.lastTickAt, now)
  const hours = Math.max(0, (now - prev) / HOUR)
  next.lastTickAt = now
    // 自尊：没人看着的时候慢慢捡回来（2026-11-22 加）
    if (hours > 0) {
      next.dignity = clamp(num(next.dignity, 70) + num(cfg?.dignityRecoverPerHour, 6) * hours, 0, 100)
    }

  // 稀度回落，向基线靠
  if (hours > 0) {
    const base = num(cfg?.slurryBaseline, 30)
    const drop = num(cfg?.slurryDecayPerHour, 4) * hours
    next.slurry = next.slurry > base ? Math.max(base, next.slurry - drop) : next.slurry
  }

  // 羞耻衰减：盆里每剩一条，速率 ×0.8
  if (hours > 0 && next.shame > 0) {
    const dirtyFactor = Math.pow(0.8, Math.max(0, num(next.pantiesDirty)))
    const rate = shameDecayRate(next.shameLevel, cfg) * dirtyFactor
    const floor = shameFloor(next.shameLevel, cfg)
    const target = Math.max(floor, next.shame - rate * hours)
    next.shame = clamp(target, 0, 100)
  }

  // 跌到下限 → 满足「盆清空」才降一档（一天最多降一档，靠 hours 节流）
  let leveledDown = false
  if (next.shameLevel > 0 && next.shame <= shameFloor(next.shameLevel, cfg) + 0.01) {
    const clean = num(next.pantiesDirty) === 0
    const swapped = num(next.pantiesStock) > 0
    if (clean && swapped && hours >= 1) {
      next.shameLevel -= 1
      next.shame = Math.max(shameFloor(next.shameLevel, cfg), next.shame)
      leveledDown = true
      events.push('level-down')
    }
  }

  // 换天：昨天的账结掉，余羞按「有事故 +12 / 连续无事故 −10」走
  const today = dateKey(now)
  if (next.day !== today) {
    const prevDay = next.day
    if (num(next.accidentsByDay?.[prevDay]) > 0 || num(next.accidentsToday) > 0) {
      next.accidentFreeDays = 0
      next.shameResidue = clamp(num(next.shameResidue) + num(cfg?.shameResidueAccidentGain, 12), 0, 100)
      events.push('new-day-accident')
    } else {
      next.accidentFreeDays = num(next.accidentFreeDays) + 1
      if (next.accidentFreeDays >= num(cfg?.shameResidueClearDays, 3) && num(next.pantiesDirty) === 0) {
        next.shameResidue = clamp(num(next.shameResidue) - num(cfg?.shameResidueDecayPerDay, 10), 0, 100)
        events.push('residue-down')
      }
    }
    next.accidentsByDay = { ...(next.accidentsByDay ?? {}), [prevDay]: num(next.accidentsToday) }
    next.accidentsToday = 0
    next.day = today
    // 换天开机基线：昨天的余羞今天还记得
    const baseline = num(next.shameResidue) * num(cfg?.shameResidueDailyFactor, 0.6)
    if (baseline > next.shame) {
      next.shame = clamp(baseline, 0, 100)
      raiseLevel(next, cfg)
    }
  }

  // 洗衣到点
  let laundryDone = false
  if (num(next.laundryUntil) > 0 && now >= num(next.laundryUntil)) {
    next.laundryUntil = 0
    next.laundryWet = false
    if (next.pantiesDirty > 0) {
      next.pantiesDirty -= 1
      next.pantiesStock += 1
      next.shame = clamp(next.shame - 25, shameFloor(next.shameLevel, cfg), 100)
      events.push('laundry-done')
    }
    laundryDone = true
  }

  next.updatedAt = now
  return { state: next, events, laundryDone, leveledDown }
}

// ── 事故 ─────────────────────────────────────────────────────────────────────

/**
 * 掷硬币。固定 1/2（cfg.accidentChance），与稀度、憋的轮数、今天第几次都无关。
 * @param {() => number} rand 随机源
 * @param {object} cfg 配置
 * @returns {boolean} true = 没憋住
 */
export function rollAccident(rand, cfg) {
  const p = clamp(num(cfg?.accidentChance, 0.5), 0, 1)
  return rand() < p
}

/** 稀不稀：slurry 越过阈值即稀。 */
export function isWet(state, cfg) {
  return num(state?.slurry) >= num(cfg?.slurryWetThreshold, 55)
}

/**
 * 事故结算。无每日上限：今天第几次都照常结算。
 * @param {object} state 状态
 * @param {object} cfg 配置
 * @param {number} now 时间
 * @returns {{state:object, wet:boolean, dirtyAdded:number, shameGain:number, emptyWardrobe:boolean}}
 */
export function settleAccident(state, cfg, now = Date.now()) {
  const next = { ...state }
  const wet = isWet(next, cfg)
  const emptyWardrobe = num(next.pantiesStock) <= 0
  const dirtyAdded = emptyWardrobe ? 0 : wet ? 2 : 1

  if (!emptyWardrobe) next.pantiesStock = Math.max(0, next.pantiesStock - 1)
  next.pantiesDirty = Math.max(0, next.pantiesDirty + dirtyAdded)

  let gain = (wet ? 60 : 40) + 8 * Math.max(0, num(next.holdRounds))
  if (emptyWardrobe) gain += 15 // 柜里没得换，更丢人
  const before = next.shame
  next.shame = clamp(next.shame + gain, 0, 100)
  raiseLevel(next, cfg)
  // 自尊随之塌陷：出事 = 体面掉一档，比羞耻更持久
  next.dignity = clamp(num(next.dignity, 70) - num(cfg?.dignityPerAccident, 22), 0, 100)
  // 升到 Lv.4 时不再往下压：用了下限就等于把羞耻锁死在 70，反而更难受

  next.gutLoad = clamp(next.gutLoad - 55, 0, 100)
  next.urge = 0
  next.holdRounds = 0
  next.slurry = clamp(next.slurry - 15, 0, 100)
  next.accidentsTotal += 1
  next.accidentsToday += 1
  next.accidentsByDay = { ...(next.accidentsByDay ?? {}), [next.day]: next.accidentsToday }
  next.lastAccidentAt = now
  next.lastAccidentWet = wet
  next.updatedAt = now

  // 正在洗的这条作废：得重洗
  if (num(next.laundryUntil) > 0) {
    next.laundryUntil = 0
    next.laundryWet = false
    next.shame = clamp(next.shame + 10, 0, 100)
  }

  return { state: next, wet, dirtyAdded, shameGain: round2(next.shame - before), emptyWardrobe }
}

/** 憋一轮：她这轮没去厕所。 */
export function holdOneRound(state, rounds = 1, now = Date.now()) {
  const next = { ...state }
  next.holdRounds = Math.max(0, num(next.holdRounds) + Math.max(1, Math.round(num(rounds, 1))))
  next.updatedAt = now
  return next
}

/** 去厕所了：清空肠道。 */
export function relieve(state, cfg, now = Date.now()) {
  const next = { ...state }
  next.gutLoad = clamp(next.gutLoad - 60, 0, 100)
  next.urge = 0
  next.holdRounds = 0
  next.lastPoopAt = now
  next.shame = clamp(next.shame - 6, shameFloor(next.shameLevel, cfg), 100)
  next.updatedAt = now
  return next
}

/** 开始洗内裤。盆里没东西就别洗。 */
export function startLaundry(state, cfg, now = Date.now()) {
  const next = { ...state }
  if (num(next.pantiesDirty) <= 0) return { state: next, ok: false, reason: 'empty' }
  if (num(next.laundryUntil) > now) return { state: next, ok: false, reason: 'already' }
  const base = num(cfg?.laundryMinutes, 3)
  const extra = next.lastAccidentWet ? num(cfg?.laundryWetExtraMinutes, 3) : 0
  next.laundryUntil = now + (base + extra) * 60_000
  next.laundryWet = extra > 0
  next.shame = clamp(next.shame - 4, shameFloor(next.shameLevel, cfg), 100)
  next.updatedAt = now
  return { state: next, ok: true, minutes: base + extra }
}

/** 洗手回来、盆空了、柜里有干净的：才算真的缓过来。 */
export function release(state, cfg, now = Date.now()) {
  const next = { ...state }
  if (num(next.pantiesDirty) === 0 && num(next.pantiesStock) > 0) {
    next.shame = clamp(next.shame - 10, shameFloor(Math.max(0, next.shameLevel - 1), cfg), 100)
  }
  next.updatedAt = now
  return next
}

// ── 自尊分支（2026-11-22 加） ───────────────────────────────────────────────

/**
 * 她会不会自己找借口去厕所。
 * 便意够了 + 自尊还撑着（>= dignityToiletAt）→ 她会走开，而不是在大庭广众下赌硬币。
 * 自尊塌到线下就反过来：死要面子、硬撑，然后更容易出事。
 */
export function seeksToilet(state, cfg, now = Date.now()) {
  const urge = urgeOf(state, cfg, now)
  const dignity = num(state?.dignity, num(cfg?.dignity, 70))
  const level = Number(state?.shameLevel ?? 0)
  if (urge < num(cfg?.urgeStart, 55)) return false
  // 羞耻已经很高时，她宁可不声不响走开——不想再被看见一次
  if (level >= 3) return true
  return dignity >= num(cfg?.dignityToiletAt, 45)
}

/** 自尊掉到线下时的口吻档：0=正常 1=嘴硬 2=躲 */
export function dignityMode(state, cfg) {
  const d = num(state?.dignity, num(cfg?.dignity, 70))
  if (d >= 55) return 0
  if (d >= 25) return 1
  return 2
}

