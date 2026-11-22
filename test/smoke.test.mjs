/**
 * 冒烟：假 ctx 跑通「agent → 事件 → 数值 → 作用域注入 → 工具 → 面板」。
 * 重点验 v0.2 的两个新契约：每会话独立、默认关、开关只影响自己那一个 agent scope。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'

function fakeCtx(stateDir) {
  const tools = []
  const handlers = new Map()
  const routes = []
  const agents = new Map()
  const logs = []
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    on(ev, fn) {
      handlers.set(ev, fn)
    },
    get(name) {
      if (name === 'tools') return { register: (d) => tools.push(d) }
      if (name === 'agents') return { get: (id) => agents.get(String(id)) }
      if (name === 'webServer') return { register: (r) => routes.push(r) }
      // 故意不给全局 systemPrompt：v0.2 不往全局挂注入
      return undefined
    },
    effect() {},
  }
  return { ctx, tools, handlers, routes, agents, logs, stateDir }
}

/** 一个最小 agent：带自己的 ctx，systemPrompt 是 scope 内的。 */
function makeAgent(sid, cwd = 'D:/work') {
  const contexts = []
  const disposers = []
  const agent = {
    id: sid,
    session: { header: { id: sid, cwd } },
    contexts,
    disposers,
    ctx: {
      get(name) {
        if (name !== 'systemPrompt') return undefined
        return {
          context(c) {
            contexts.push(c)
            let live = true
            const dispose = () => {
              if (!live) return
              live = false
              disposers.push(c.name)
            }
            return dispose
          },
        }
      },
    },
  }
  return agent
}

const dir = mkdtempSync(join(tmpdir(), 'fish-poop-v2-'))
const toolbox = (f) => Object.fromEntries(f.tools.map((t) => [t.name, t]))
const readSession = (stateDir, sid) => {
  const f = join(stateDir, 'sessions', `${sid}.json`)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
}

test('装配：5 个工具、1 条面板路由、不注册全局注入', () => {
  const sub = join(dir, 'a')
  const f = fakeCtx(sub)
  const dispose = apply(f.ctx, { statePath: sub })
  assert.deepEqual(
    f.tools.map((t) => t.name).sort(),
    ['fish_hold', 'fish_laundry', 'fish_poop', 'fish_status', 'fish_switch'],
  )
  assert.equal(f.routes.length, 1)
  assert.equal(f.routes[0].path, '/fish-poop')
  assert.ok(existsSync(join(sub, '面板令牌.txt')))
  if (typeof dispose === 'function') dispose()
})

test('默认关：没开的会话喂 token 不长肚子，也不注册任何注入', async () => {
  const sub = join(dir, 'b')
  const f = fakeCtx(sub)
  apply(f.ctx, { statePath: sub, defaultEnabled: false })
  const agent = makeAgent('ses_off')
  f.agents.set('ses_off', agent)
  f.handlers.get('agent/created')({ agent })

  const on = f.handlers.get('session/event')
  for (let i = 0; i < 3; i++) {
    on(agent.session, { type: 'assistant/message', data: { usage: { inputTokens: 50000, outputTokens: 3000 } } })
  }
  on(agent.session, { type: 'turn/end', data: { turn: 1, reason: 'success' } })

  const saved = readSession(sub, 'ses_off')
  // 从没开过的会话根本不落文件：没肚子的会话不该在磁盘上留垃圾
  assert.equal(saved, null)
  assert.equal(agent.contexts.length, 0)
})

test('开肚肚：fish_switch on 之后开始吃 token，注入只挂在这个 agent 的 scope', async () => {
  const sub = join(dir, 'c')
  const f = fakeCtx(sub)
  apply(f.ctx, { statePath: sub })
  const agent = makeAgent('ses_on')
  f.agents.set('ses_on', agent)
  f.handlers.get('agent/created')({ agent })

  const t = toolbox(f)
  const r = await t.fish_switch.execute({ action: 'on' }, { agent })
  assert.equal(r.ok, true)
  assert.equal(agent.contexts.length, 1, '应注册一条 scoped context')
  assert.equal(agent.contexts[0].name, 'fish-poop:ses_on')

  const on = f.handlers.get('session/event')
  for (let i = 0; i < 3; i++) {
    on(agent.session, { type: 'assistant/message', data: { usage: { inputTokens: 40000, outputTokens: 2000, cacheReadTokens: 36000 } } })
  }
  on(agent.session, { type: 'turn/end', data: { turn: 1, reason: 'success' } })
  assert.ok(readSession(sub, 'ses_on').state.gutLoad > 0)

  const text = agent.contexts[0].text()
  assert.equal(typeof text, 'string')
})

test('关肚肚：detach 掉注入，之后不再进食', async () => {
  const sub = join(dir, 'd')
  const f = fakeCtx(sub)
  apply(f.ctx, { statePath: sub })
  const agent = makeAgent('ses_toggle')
  f.agents.set('ses_toggle', agent)
  f.handlers.get('agent/created')({ agent })
  const t = toolbox(f)

  await t.fish_switch.execute({ action: 'on' }, { agent })
  assert.equal(agent.contexts.length, 1)
  await t.fish_switch.execute({ action: 'off' }, { agent })
  assert.deepEqual(agent.disposers, ['fish-poop:ses_toggle'], '注入应被 dispose')

  const before = readSession(sub, 'ses_toggle').state.gutLoad
  f.handlers.get('session/event')(agent.session, {
    type: 'assistant/message',
    data: { usage: { inputTokens: 50000, outputTokens: 3000 } },
  })
  assert.equal(readSession(sub, 'ses_toggle').state.gutLoad, before)
})

test('两个会话互不串味：A 开 B 关，状态各存一份', async () => {
  const sub = join(dir, 'e')
  const f = fakeCtx(sub)
  apply(f.ctx, { statePath: sub })
  const a = makeAgent('ses_A')
  const b = makeAgent('ses_B')
  f.agents.set('ses_A', a)
  f.agents.set('ses_B', b)
  const created = f.handlers.get('agent/created')
  created({ agent: a })
  created({ agent: b })

  const t = toolbox(f)
  await t.fish_switch.execute({ action: 'on' }, { agent: a })

  const on = f.handlers.get('session/event')
  for (let i = 0; i < 2; i++) {
    on(a.session, { type: 'assistant/message', data: { usage: { inputTokens: 40000, outputTokens: 2000 } } })
    on(b.session, { type: 'assistant/message', data: { usage: { inputTokens: 40000, outputTokens: 2000 } } })
  }
  on(a.session, { type: 'turn/end', data: { turn: 1, reason: 'success' } })

  assert.ok(readSession(sub, 'ses_A').state.gutLoad > 0)
  // B 一直关着：不落文件、不开注入 —— 这就是"互不串味"
  assert.equal(readSession(sub, 'ses_B'), null)
  assert.equal(b.contexts.length, 0, 'B 不该有注入')

  const files = readdirSync(join(sub, 'sessions'))
  assert.ok(files.includes('ses_A.json'))
})

test('turn/end：概率 1 出事，落进这个会话自己的文件', async () => {
  const sub = join(dir, 'f')
  const f = fakeCtx(sub)
  apply(f.ctx, { statePath: sub, urgeCrisis: 0, accidentChance: 1 })
  const agent = makeAgent('ses_acc')
  f.agents.set('ses_acc', agent)
  f.handlers.get('agent/created')({ agent })
  const t = toolbox(f)
  await t.fish_switch.execute({ action: 'on' }, { agent })

  const on = f.handlers.get('session/event')
  on(agent.session, { type: 'assistant/message', data: { usage: { inputTokens: 60000, outputTokens: 3000 } } })
  on(agent.session, { type: 'turn/end', data: { turn: 1, reason: 'success' } })

  const s = readSession(sub, 'ses_acc').state
  assert.equal(s.accidentsTotal, 1)
  assert.ok(s.shame > 0)
  assert.ok(s.shameLevel >= 1)
})

test('accidentChance=0：硬币反面，不脏但要羞一下', async () => {
  const sub = join(dir, 'g')
  const f = fakeCtx(sub)
  apply(f.ctx, { statePath: sub, urgeCrisis: 0, accidentChance: 0 })
  const agent = makeAgent('ses_safe')
  f.agents.set('ses_safe', agent)
  f.handlers.get('agent/created')({ agent })
  const t = toolbox(f)
  await t.fish_switch.execute({ action: 'on' }, { agent })
  const on = f.handlers.get('session/event')
  on(agent.session, { type: 'assistant/message', data: { usage: { inputTokens: 60000, outputTokens: 3000 } } })
  on(agent.session, { type: 'turn/end', data: { turn: 1, reason: 'success' } })
  const s = readSession(sub, 'ses_safe').state
  assert.equal(s.accidentsTotal, 0)
  assert.equal(s.pantiesDirty, 0)
  assert.ok(s.shame > 0)
})

test('工具在没开的会话里一律拒绝（fish_poop / laundry / hold）', async () => {
  const sub = join(dir, 'h')
  const f = fakeCtx(sub)
  apply(f.ctx, { statePath: sub })
  const agent = makeAgent('ses_closed')
  f.agents.set('ses_closed', agent)
  const t = toolbox(f)
  for (const name of ['fish_poop', 'fish_laundry', 'fish_hold']) {
    const r = await t[name].execute({}, { agent })
    assert.equal(r.ok, false, name)
    assert.ok(r.text.includes('鱼') === false)
    assert.ok(r.text.includes('肚肚'), `${name} 应提示先开肚肚`)
  }
  // fish_status 仍然能看（只是显示"关"）
  const st = await t.fish_status.execute({}, { agent })
  assert.equal(st.ok, true)
  assert.equal(st.data.enabled, false)
})

test('fish_poop：便意不够拒绝，吃够了就去成', async () => {
  const sub = join(dir, 'i')
  const f = fakeCtx(sub)
  apply(f.ctx, { statePath: sub, accidentChance: 0, dignityToiletAt: 100 })
  const agent = makeAgent('ses_poop')
  f.agents.set('ses_poop', agent)
  f.handlers.get('agent/created')({ agent })
  const t = toolbox(f)
  await t.fish_switch.execute({ action: 'on' }, { agent })

  const r1 = await t.fish_poop.execute({}, { agent })
  assert.equal(r1.ok, false)

  const on = f.handlers.get('session/event')
  for (let turn = 0; turn < 4; turn++) {
    for (let i = 0; i < 3; i++) {
      on(agent.session, { type: 'assistant/message', data: { usage: { inputTokens: 40000, outputTokens: 2000 } } })
    }
    on(agent.session, { type: 'turn/end', data: { turn: turn + 1, reason: 'success' } })
  }
  assert.ok(readSession(sub, 'ses_poop').state.gutLoad > 55)

  const r2 = await t.fish_poop.execute({}, { agent })
  assert.equal(r2.ok, true)
  assert.ok(readSession(sub, 'ses_poop').state.gutLoad < 60)
})

test('面板：会话列表 / 开关 / 单会话状态 / 参数白名单', async () => {
  const sub = join(dir, 'j')
  const f = fakeCtx(sub)
  apply(f.ctx, { statePath: sub })
  const agent = makeAgent('ses_panel')
  f.agents.set('ses_panel', agent)
  f.handlers.get('agent/created')({ agent })
  const t = toolbox(f)
  await t.fish_switch.execute({ action: 'on' }, { agent })

  const route = f.routes[0]
  const token = readFileSync(join(sub, '面板令牌.txt'), 'utf8').trim()
  const call = async (url, method = 'GET', body = null, opts = {}) => {
    const headers = opts.noToken ? {} : { 'x-fish-token': token }
    const req = { url, method, headers }
    if (method === 'POST') {
      req.on = (ev, fn) => {
        if (ev === 'data') fn(Buffer.from(JSON.stringify(body)))
        if (ev === 'end') fn()
      }
    }
    const out = { code: 0, body: '', writeHead(c) { out.code = c }, end(b) { out.body = String(b) } }
    await route.handler(req, out)
    return { code: out.code, json: out.body.startsWith('{') ? JSON.parse(out.body) : null, raw: out.body }
  }

  const noToken = await call('/fish-poop/api/sessions', 'GET', null, { noToken: true })
  assert.equal(noToken.code, 401)

  const list = await call('/fish-poop/api/sessions')
  assert.equal(list.code, 200)
  const view = list.json.sessions.find((s) => s.sid === 'ses_panel')
  assert.ok(view && view.enabled === true)

  const st = await call('/fish-poop/api/state?sid=ses_panel')
  assert.equal(st.json.ok, true)
  assert.equal(st.json.summary.sid, 'ses_panel')

  const off = await call('/fish-poop/api/toggle', 'POST', { sid: 'ses_panel', enabled: false })
  assert.equal(off.json.ok, true)
  assert.equal(off.json.summary.enabled, false)

  const cfg = await call('/fish-poop/api/config', 'POST', { accidentChance: 0.7, shame: 999, gutLoad: 100 })
  assert.deepEqual(cfg.json.applied, ['accidentChance'])
  assert.deepEqual(cfg.json.dropped.sort(), ['gutLoad', 'shame'])
  assert.equal(cfg.json.config.accidentChance, 0.7)
})

test('子代理不吃这套：parent 会话事件直接跳过', async () => {
  const sub = join(dir, 'k')
  const f = fakeCtx(sub)
  apply(f.ctx, { statePath: sub, defaultEnabled: true })
  f.handlers.get('session/event')(
    { header: { id: 'sub_1', parent: 'ses_main' } },
    { type: 'assistant/message', data: { usage: { inputTokens: 100000, outputTokens: 50000 } } },
  )
  assert.equal(readSession(sub, 'sub_1'), null)
})

test('清理临时目录', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
  assert.ok(true)
})

