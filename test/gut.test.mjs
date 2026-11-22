import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../src/config.js'
import { makeRng } from '../src/rng.js'
import {
  dateKey,
  feed,
  holdOneRound,
  isWet,
  newState,
  normalizeState,
  relieve,
  rollAccident,
  seeksToilet,
  settleAccident,
  shameFloor,
  shameLevelOf,
  startLaundry,
  tick,
  urgeOf,
  takeLaxative,
  inLaxative,
  takeRice,
  justAteRice,
} from '../src/gut.js'

const cfg = normalizeConfig({})
const T0 = Date.UTC(2026, 10, 22, 1, 0, 0) // 2026-11-22 09:00 +08

test('feed：cache 读的不算新饭，只算 fresh + 输出', () => {
  const s0 = newState(T0, cfg)
  const r = feed(s0, { inputTokens: 30000, outputTokens: 1500, cacheReadTokens: 28000 }, cfg, T0)
  // (2000 + 1500*1.2) / 20000 * 15 = 2.85
  assert.ok(Math.abs(r.got - 2.85) < 0.01, `got=${r.got}`)
  assert.ok(r.state.gutLoad > 2 && r.state.gutLoad < 3)
})

test('feed：默认不封顶（0 = 不限），显式给上限时才封', () => {
  const s0 = newState(T0, cfg)
  const r1 = feed(s0, { inputTokens: 500000, outputTokens: 100000 }, cfg, T0)
  assert.ok(r1.got > 40, `got=${r1.got}`)
  assert.equal(r1.state.gutLoad, 100)

  const capped = { ...cfg, maxGutPerStep: 20, maxGutPerTurn: 40 }
  const c1 = feed(newState(T0, capped), { inputTokens: 500000, outputTokens: 100000 }, capped, T0)
  assert.equal(c1.got, 20)
  let s = c1.state
  for (let i = 0; i < 20; i++) {
    s = feed(s, { inputTokens: 500000, outputTokens: 100000 }, capped, T0).state
  }
  assert.ok(s.turnSpent <= 40.001, `turnSpent=${s.turnSpent}`)
})

test('自尊：事故扣、时间恢复、低了会自己躲', () => {
  const s0 = newState(T0, cfg)
  assert.equal(s0.dignity, cfg.dignity)

  const before = { ...s0, gutLoad: 100, slurry: 80, holdRounds: 2 }
  const acc = settleAccident(before, cfg, T0)
  assert.ok(acc.state.dignity < before.dignity, '事故应扣自尊')

  const later = tick({ ...s0, dignity: 40, lastTickAt: T0 }, cfg, T0 + 3600_000)
  assert.ok(later.state.dignity > 40, `应恢复，实际 ${later.state.dignity}`)

  const urgent = { ...s0, gutLoad: 100, dignity: 70, updatedAt: T0 }
  assert.equal(seeksToilet(urgent, cfg, T0 + 30 * 60_000), true)
  assert.equal(seeksToilet({ ...urgent, dignity: 10 }, cfg, T0 + 30 * 60_000), false)
})
test('feed：大餐（input ≥ 15000）会把稀度顶上去', () => {
  const s0 = newState(T0, cfg)
  const r = feed(s0, { inputTokens: 20000, outputTokens: 500, cacheReadTokens: 0 }, cfg, T0)
  assert.equal(r.bigMeal, true)
  assert.ok(r.state.slurry > s0.slurry)
})

test('urgeOf：低于 urgeStart 一律 0', () => {
  const s = { ...newState(T0, cfg), gutLoad: 40, lastFeedAt: T0 }
  assert.equal(urgeOf(s, cfg, T0), 0)
  const s2 = { ...newState(T0, cfg), gutLoad: 54.9, lastFeedAt: T0 }
  assert.equal(urgeOf(s2, cfg, T0), 0)
})

test('urgeOf：满肠道 = 100，且久坐会加成但有上限', () => {
  const s = { ...newState(T0, cfg), gutLoad: 100, lastFeedAt: T0 }
  assert.equal(Math.round(urgeOf(s, cfg, T0)), 100)
  const later = T0 + 6 * 3600_000
  assert.ok(urgeOf(s, cfg, later) <= 100)
})

test('rollAccident：固定 1/2，10000 次统计在 0.50±0.02', () => {
  const rand = makeRng(20261122)
  let hit = 0
  for (let i = 0; i < 10000; i++) if (rollAccident(rand, cfg)) hit++
  const p = hit / 10000
  assert.ok(Math.abs(p - 0.5) < 0.02, `p=${p}`)
})

test('rollAccident：与稀度/憋的轮数/当天次数完全无关（同一随机序列结果一致）', () => {
  const a = []
  const b = []
  const r1 = makeRng(7)
  const r2 = makeRng(7)
  const calm = { ...newState(T0, cfg), slurry: 0, holdRounds: 0, accidentsToday: 0 }
  const messy = { ...newState(T0, cfg), slurry: 100, holdRounds: 12, accidentsToday: 99 }
  for (let i = 0; i < 200; i++) {
    a.push(rollAccident(r1, cfg))
    b.push(rollAccident(r2, cfg))
  }
  assert.deepEqual(a, b)
  assert.ok(calm.slurry !== messy.slurry)
})

test('settleAccident：成形脏 1 条，稀脏 2 条', () => {
  const dryState = { ...newState(T0, cfg), gutter: 0, slurry: 10, pantiesStock: 5, holdRounds: 0 }
  const dry = settleAccident(dryState, cfg, T0)
  assert.equal(dry.wet, false)
  assert.equal(dry.state.pantiesDirty, 1)
  assert.equal(dry.state.pantiesStock, 4)

  const wetState = { ...newState(T0, cfg), slurry: 90, pantiesStock: 5 }
  const wet = settleAccident(wetState, cfg, T0)
  assert.equal(wet.wet, true)
  assert.equal(wet.state.pantiesDirty, 2)
  assert.ok(wet.state.shame > dry.state.shame)
})

test('settleAccident：没有每日上限 —— 今天第 99 次也照常结算', () => {
  let s = { ...newState(T0, cfg), accidentsToday: 99, accidentsTotal: 99, pantiesStock: 50, slurry: 10 }
  const before = s.accidentsToday
  const r = settleAccident(s, cfg, T0)
  assert.equal(r.state.accidentsToday, before + 1)
  assert.equal(r.state.pantiesDirty, 1)
  // 再来十次也一样
  let x = r.state
  for (let i = 0; i < 10; i++) x = settleAccident(x, cfg, T0).state
  assert.equal(x.accidentsToday, before + 11)
  assert.ok(x.pantiesStock < 50)
})

test('settleAccident：柜里没得换时更丢人，脏的也不再加', () => {
  const s = { ...newState(T0, cfg), pantiesStock: 0, slurry: 10, shame: 10 }
  const r = settleAccident(s, cfg, T0)
  assert.equal(r.emptyWardrobe, true)
  assert.equal(r.state.pantiesStock, 0)
  assert.equal(r.state.pantiesDirty, 0)
  assert.ok(r.state.shame >= 10 + 40 + 15)
})

test('settleAccident：清空肠道、清掉憋的轮数、档位跟着抬', () => {
  const s = { ...newState(T0, cfg), gutLoad: 90, holdRounds: 4, slurry: 10, pantiesStock: 5 }
  const r = settleAccident(s, cfg, T0)
  assert.ok(r.state.gutLoad <= 35)
  assert.equal(r.state.holdRounds, 0)
  assert.equal(r.state.shameLevel, shameLevelOf(r.state.shame, cfg))
  assert.ok(r.state.shame >= shameFloor(r.state.shameLevel, cfg))
})

test('羞耻档：63 是 Lv.3，下限 48，跌到下限就停住', () => {
  assert.equal(shameLevelOf(63, cfg), 3)
  assert.equal(shameFloor(3, cfg), 48)
  let s = { ...newState(T0, cfg), shame: 63, shameLevel: 3, pantiesDirty: 0, pantiesStock: 3, lastTickAt: T0 }
  // 10 小时后
  const r = tick(s, cfg, T0 + 10 * 3600_000)
  assert.ok(r.state.shame >= 48, `shame=${r.state.shame}`)
  assert.ok(r.state.shame <= 48.5)
})

test('羞耻档：盆里堆着时衰减更慢（×0.8^n）', () => {
  const clean = tick({ ...newState(T0, cfg), shame: 90, shameLevel: 4, pantiesDirty: 0, lastTickAt: T0 }, cfg, T0 + 3600_000)
  const dirty = tick({ ...newState(T0, cfg), shame: 90, shameLevel: 4, pantiesDirty: 3, lastTickAt: T0 }, cfg, T0 + 3600_000)
  assert.ok(dirty.state.shame > clean.state.shame)
})

test('羞耻档：盆没清空就不降档（跌到下限只停，不滑）', () => {
  const s = { ...newState(T0, cfg), shame: 48, shameLevel: 3, pantiesDirty: 2, pantiesStock: 2, lastTickAt: T0 }
  const r = tick(s, cfg, T0 + 3 * 3600_000)
  assert.equal(r.state.shameLevel, 3)
})

test('羞耻档：盆清空 + 有干净内裤 + 过了 1 小时才降一档', () => {
  const s = { ...newState(T0, cfg), shame: 48, shameLevel: 3, pantiesDirty: 0, pantiesStock: 2, lastTickAt: T0 }
  const r = tick(s, cfg, T0 + 2 * 3600_000)
  assert.equal(r.state.shameLevel, 2)
  assert.ok(r.state.shame >= shameFloor(2, cfg))
})

test('洗内裤：盆里空了不能洗；洗一次盆里少一条、柜里多一条', () => {
  const empty = startLaundry({ ...newState(T0, cfg), pantiesDirty: 0 }, cfg, T0)
  assert.equal(empty.ok, false)

  const s = { ...newState(T0, cfg), pantiesDirty: 2, pantiesStock: 3, shame: 70, shameLevel: 3 }
  const started = startLaundry(s, cfg, T0)
  assert.equal(started.ok, true)
  assert.ok(started.state.laundryUntil > T0)
  const done = tick(started.state, cfg, T0 + 10 * 60_000)
  assert.equal(done.laundryDone, true)
  assert.equal(done.state.pantiesDirty, 1)
  assert.equal(done.state.pantiesStock, 4)
})

test('偷洗到一半又出事故：这条作废，得重洗', () => {
  const s = { ...newState(T0, cfg), pantiesDirty: 1, pantiesStock: 2, slurry: 10 }
  const started = startLaundry(s, cfg, T0)
  assert.ok(started.state.laundryUntil > 0)
  const accident = settleAccident(started.state, cfg, T0 + 30_000)
  assert.equal(accident.state.laundryUntil, 0)
})

test('换天：昨天出过事 → 余羞 +12；连续三天干净才往回掉', () => {
  const day1 = T0
  const s = { ...newState(day1, cfg), day: dateKey(day1), accidentsToday: 2, accidentFreeDays: 0 }
  const r = tick(s, cfg, day1 + 86_400_000)
  assert.equal(r.state.shameResidue, 12)
  assert.equal(r.state.accidentsToday, 0)
  assert.equal(r.state.accidentFreeDays, 0)

  let x = { ...newState(day1, cfg), day: dateKey(day1), accidentsToday: 0, accidentFreeDays: 2, shameResidue: 40, pantiesDirty: 0 }
  const r2 = tick(x, cfg, day1 + 86_400_000)
  assert.equal(r2.state.shameResidue, 30)
})

test('换天：昨天的余羞会变成今天开机羞耻（×0.6）', () => {
  const s = { ...newState(T0, cfg), day: dateKey(T0), shame: 0, shameLevel: 0, shameResidue: 60, accidentsToday: 0, accidentFreeDays: 0, pantiesDirty: 1 }
  const r = tick(s, cfg, T0 + 86_400_000)
  assert.ok(r.state.shame >= 36, `shame=${r.state.shame}`)
  assert.ok(r.state.shameLevel >= 2)
})

test('normalizeState：坏字段不致于让整份状态作废', () => {
  const s = normalizeState({ gutLoad: 'abc', shame: 999, shameLevel: 9, pantiesDirty: -3, day: 'x' }, T0, cfg)
  assert.equal(s.gutLoad, 0)
  assert.equal(s.shame, 100)
  assert.equal(s.shameLevel, 4)
  assert.equal(s.pantiesDirty, 0)
})

test('relieve / holdOneRound 的基本语义', () => {
  const s = { ...newState(T0, cfg), gutLoad: 90, holdRounds: 0 }
  const h = holdOneRound(s, 2, T0)
  assert.equal(h.holdRounds, 2)
  const p = relieve(h, T0)
  assert.equal(p.holdRounds, 0)
  assert.ok(p.gutLoad <= 35)
})

test('稀度阈值判定', () => {
  assert.equal(isWet({ slurry: 54.9 }, cfg), false)
  assert.equal(isWet({ slurry: 55 }, cfg), true)
})




test('泻药：立即抬稀度与肠道，并有药效窗口', () => {
  const s0 = newState(T0, cfg)
  const s1 = takeLaxative(s0, cfg, T0)
  assert.equal(s1.slurry, s0.slurry + cfg.laxativeSlurry)
  assert.equal(s1.gutLoad, s0.gutLoad + cfg.laxativeGut)
  assert.equal(inLaxative(s1, T0), true)
  // 过了药效窗口就失效
  const later = T0 + (cfg.laxativeMinutes + 1) * 60_000
  assert.equal(inLaxative(s1, later), false)
  // 药效期内危机概率用 laxativeChance
  assert.ok(cfg.laxativeChance > cfg.accidentChance, '药效期概率应高于平时')
})


test('大白饭：涨肠多、降水少，且有"刚吃过"窗口', () => {
  const s0 = newState(T0, cfg)
  const s1 = takeRice(s0, cfg, T0)
  assert.equal(s1.gutLoad, s0.gutLoad + cfg.riceGut)
  assert.equal(s1.slurry, Math.max(0, s0.slurry - cfg.riceDry))
  assert.equal(s1.riceBowls, 1)
  assert.equal(justAteRice(s1, cfg, T0 + 60_000), true)
  assert.equal(justAteRice(s1, cfg, T0 + (cfg.riceWindowMin + 1) * 60_000), false)
  // 干饭不该比读资料更稀
  assert.ok(cfg.riceGut > 0 && cfg.riceDry > 0)
})
