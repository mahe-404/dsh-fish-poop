import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../src/config.js'
import { newState, settleAccident, startLaundry } from '../src/gut.js'
import { buildBlock, levelLabel, modeOf, shouldInject } from '../src/prompt.js'

const cfg = normalizeConfig({})
const T0 = Date.UTC(2026, 10, 22, 1, 0, 0)

const base = (patch) => ({ ...newState(T0, cfg), ...patch })

test('Lv.0 一个字都不注入', () => {
  const s = base({ shame: 5, shameLevel: 0, gutLoad: 10, pantiesDirty: 2 })
  const b = buildBlock(s, cfg, T0)
  assert.equal(b.text, '')
})

test('没事的时候（便意 < 40）安静', () => {
  const s = base({ gutLoad: 58, urge: 20, lastFeedAt: T0 })
  const b = buildBlock(s, cfg, T0)
  assert.equal(b.text, '')
  assert.equal(b.mode, 'calm')
})

test('有便意：写肠道/便意/稀度，并要求只带一处细微表现', () => {
  const s = base({ gutLoad: 78, urge: 61, slurry: 45, lastFeedAt: T0 })
  const b = buildBlock(s, cfg, T0)
  assert.ok(b.text.includes('便意 61'))
  assert.ok(b.text.includes('肠道积存 78'))
  assert.ok(b.text.includes('一处细微表现'))
})

test('事故（成形）：羞耻、档位、盆里、次数都得写清，且不许写过程细节', () => {
  const s = base({
    slurry: 10, pantiesDirty: 1, pantiesStock: 6, shame: 74, shameLevel: 3,
    lastAccidentAt: T0, lastAccidentWet: false, accidentsToday: 2,
  })
  const b = buildBlock(s, cfg, T0)
  assert.equal(b.mode, 'accident')
  assert.ok(b.text.includes('羞耻 74/100'))
  assert.ok(b.text.includes('Lv.3'))
  assert.ok(b.text.includes('今天第 2 次'))
  assert.ok(b.text.includes('不写排泄过程细节'))
  assert.ok(b.text.includes('先忍着'), 'Lv.3 必须写"倾向先忍着"')
})

test('事故（稀）：更慌 + 两条 + 外裤', () => {
  const s = base({
    slurry: 90, pantiesDirty: 2, pantiesStock: 5, shame: 88, shameLevel: 4,
    lastAccidentAt: T0, lastAccidentWet: true, accidentsToday: 1,
  })
  const b = buildBlock(s, cfg, T0)
  assert.ok(b.text.includes('稀的'))
  assert.ok(b.text.includes('两条'))
  assert.ok(b.text.includes('外裤'))
  assert.ok(b.text.includes('别看'), 'Lv.4 允许回避/沉默')
})

test('洗衣中：给剩余分钟，柜里空了要说', () => {
  const s = base({ pantiesDirty: 2, pantiesStock: 0, shame: 62, shameLevel: 3, laundryUntil: T0 + 120_000 })
  const b = buildBlock(s, cfg, T0)
  assert.equal(b.mode, 'washing')
  assert.ok(b.text.includes('大约还要 2 分钟'))
  assert.ok(b.text.includes('没有干净的了'))
})

test('盆里堆着（非事故 30 分钟后）：只提一句', () => {
  const s = base({ pantiesDirty: 1, pantiesStock: 4, shame: 40, shameLevel: 2, lastAccidentAt: T0 - 3600_000 })
  const b = buildBlock(s, cfg, T0)
  assert.equal(b.mode, 'dirty')
  assert.ok(b.text.includes('还堆着 1 条'))
  assert.ok(b.text.includes('等会儿得去洗了'))
})

test('字数按档位收口（Lv.1 ≤120，Lv.4 ≤300）', () => {
  for (const [level, cap] of [[1, 120], [2, 180], [3, 240], [4, 300]]) {
    const s = base({ shame: [0, 15, 40, 63, 88][level], shameLevel: level, gutLoad: 10, pantiesDirty: 3, pantiesStock: 2 })
    const b = buildBlock(s, cfg, T0)
    assert.ok(b.text.length <= cap, `Lv.${level} 长度 ${b.text.length} > ${cap}`)
  }
})

test('冷却：同一状态 30 分钟内不重复注入', () => {
  const s = base({ gutLoad: 90, urge: 80, shame: 20, shameLevel: 1, lastFeedAt: T0 })
  const b = buildBlock(s, cfg, T0)
  assert.equal(shouldInject(s, cfg, b, T0).ok, true)
  const injected = { ...s, lastInjectAt: T0, lastInjectKey: b.key }
  const again = shouldInject(injected, cfg, b, T0 + 60_000)
  assert.equal(again.ok, false)
  assert.equal(again.skip, 'cooldown')
})

test('冷却：事故与洗衣不受 30 分钟限制', () => {
  const s = base({ slurry: 10, pantiesDirty: 1, pantiesStock: 6, shame: 74, shameLevel: 3, lastAccidentAt: T0, lastInjectAt: T0 - 60_000 })
  const b = buildBlock(s, cfg, T0)
  assert.equal(shouldInject(s, cfg, b, T0).ok, true)
})

test('同一状态去重：key 相同就跳过', () => {
  const s = base({ gutLoad: 90, urge: 80, shame: 40, shameLevel: 2, lastFeedAt: T0 })
  const b = buildBlock(s, cfg, T0)
  const injected = { ...s, lastInjectAt: T0 - 4 * 3600_000, lastInjectKey: b.key }
  assert.equal(shouldInject(injected, cfg, b, T0).skip, 'same')
})

test('关掉总开关：不注入', () => {
  const off = normalizeConfig({ enabled: false })
  const b = buildBlock(base({ gutLoad: 100, shame: 90 }), off, T0)
  assert.equal(b.text, '')
  assert.equal(modeOf(base({}), off, T0), 'off')
})

test('真实链路：事故结算后立刻能生成 Lv.3 的块', () => {
  const s = base({ slurry: 10, pantiesStock: 5, gutLoad: 90, holdRounds: 2, shame: 20 })
  const r = settleAccident(s, cfg, T0)
  const b = buildBlock(r.state, cfg, T0)
  assert.equal(b.mode, 'accident')
  assert.ok(b.text.length > 0)
  assert.ok(levelLabel(r.state.shameLevel).length > 0)
})

test('洗内裤触发的洗衣块也能生成', () => {
  const s = base({ pantiesDirty: 1, pantiesStock: 2, shame: 60, shameLevel: 3 })
  const started = startLaundry(s, cfg, T0)
  const b = buildBlock(started.state, cfg, T0)
  assert.equal(b.mode, 'washing')
  assert.ok(b.text.length > 0)
})
