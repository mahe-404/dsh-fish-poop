/**
 * 大肥鱼的肚肚（dsh-fish-poop）v0.2 —— 全局加载，每会话自由开关
 *
 * 负荷全在「会话」这一层：
 * - 插件挂在 profile 的 bundles 里，所以每个会话都看得见它的工具；
 * - 但每个会话有一份自己的肚肚（`sessions/<sid>.json`），默认关；
 * - 开 = 在这个 agent 自己的 scope 里注册一条 systemPrompt context（只喂这个会话）；
 * - 关 = dispose 掉那条注册，文件留着，下次开还是原来那份肠道。
 *
 * 为什么要挂 agent scope 而不是全局 context：全局 context 会在**所有**会话里出现，
 * 那就没法「自由开关」了。
 */
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ALLOWED_KEYS, normalizeConfig } from './config.js'
import { makeRng } from './rng.js'
import {
  endTurnBudget,
  feed,
  holdOneRound,
  isWet,
  newState,
  normalizeState,
  relieve,
  rollAccident,
  seeksToilet,
  dignityMode,
  takeLaxative,
  inLaxative,
  settleAccident,
  shameFloor,
  startLaundry,
  tick,
  urgeOf,
} from './gut.js'
import { buildBlock, levelLabel, modeOf, shouldInject } from './prompt.js'
import {
  ensureDir,
  listSessionFiles,
  pushHistory,
  readJson,
  safeSid,
  sessionFile,
  sessionsDir,
  writeJsonAtomic,
  writeTextAtomic,
} from './store.js'

export const name = 'dsh-fish-poop'
export const inject = []

const TICK_MS = 60_000
const SAVE_MS = 10_000
const FILE_VERSION = 2

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

/** 状态目录：显式 statePath > DSH_FISH_POOP_DIR > $DSH_HOME/fish-poop。永远不碰 cwd。 */
function baseDirOf(ctx, config, logger) {
  const statePath = String(config?.statePath ?? '').trim()
  if (statePath) return resolve(statePath)

  const envDir = String(process.env.DSH_FISH_POOP_DIR ?? '').trim()
  if (envDir) return resolve(envDir)

  let home = ''
  try {
    const svc = ctx?.get?.('dshHomePath')
    home = typeof svc === 'string' ? svc : String(svc?.path ?? svc?.home ?? '')
  } catch {}
  if (!home) home = String(process.env.DSH_HOME ?? '').trim()
  if (!home) home = join(homedir(), '.dsh')
  const dir = join(home, 'fish-poop')
  logger?.info?.(`[dsh-fish-poop] 状态目录：${dir}`)
  return dir
}

export function apply(ctx, configIn) {
  const logger = ctx?.logger ?? console
  const cfg = normalizeConfig(configIn)
  const baseDir = baseDirOf(ctx, cfg, logger)
  ensureDir(baseDir)
  ensureDir(sessionsDir(baseDir))

  const panelCfgFile = join(baseDir, '面板配置.json')
  // 面板改过的参数要在重启后还在：像 longing 一样，单独存一份叠加层
  const panelOverrides = readJson(panelCfgFile, {}, logger)
  Object.assign(cfg, normalizeConfig({ ...cfg, ...(panelOverrides ?? {}) }))
  const savePanelCfg = () => {
    const out = {}
    for (const k of ALLOWED_KEYS) if (cfg[k] !== undefined) out[k] = cfg[k]
    writeJsonAtomic(panelCfgFile, out, logger)
  }

  const tokenFile = join(baseDir, '面板令牌.txt')
  let panelToken = ''
  try {
    if (existsSync(tokenFile)) panelToken = readFileSync(tokenFile, 'utf8').trim()
    if (!panelToken) {
      panelToken = randomUUID().replace(/-/g, '')
      writeTextAtomic(tokenFile, `${panelToken}\n`, logger)
    }
  } catch (e) {
    logger?.warn?.(`[dsh-fish-poop] 面板令牌不可用：${e?.message ?? e}`)
  }

  const rand = makeRng()
  const runtimes = new Map()
  let disposed = false

  // ── 运行时（每会话一份） ───────────────────────────────────────────────────

  const rtKey = (sid) => safeSid(sid)

  function loadRt(sid, session) {
    const key = rtKey(sid)
    const existing = runtimes.get(key)
    if (existing) return existing

    const file = sessionFile(baseDir, key)
    const raw = readJson(file, null, logger)
    let state
    let enabled
    let history
    let label = ''
    let cwd = ''

    if (raw && typeof raw === 'object' && raw.state) {
      // v2 结构
      state = normalizeState(raw.state, Date.now(), cfg)
      enabled = raw.enabled === true
      history = Array.isArray(raw.history) ? raw.history : []
      label = String(raw.label ?? '')
      cwd = String(raw.cwd ?? '')
    } else if (raw && typeof raw === 'object') {
      // v1：整份就是肚肚状态，没有开关
      state = normalizeState(raw, Date.now(), cfg)
      enabled = cfg.defaultEnabled === true
      history = []
    } else {
      state = newState(Date.now(), cfg)
      enabled = cfg.defaultEnabled === true
      history = []
    }

    try {
      const header = session?.header ?? session
      cwd = cwd || String(header?.cwd ?? '')
      label = label || String(header?.title ?? '')
    } catch {}

    const rt = {
      key,
      sid: String(sid),
      file,
      state,
      enabled,
      history,
      label,
      cwd,
      agent: null,
      detach: null,
      lastUsage: { input: 0, output: 0, steps: 0 },
      savedAt: 0,
      historyDirty: false,
      pooped: false,
    }
    runtimes.set(key, rt)
    return rt
  }

  function saveRt(rt, force = true) {
    const now = Date.now()
    if (!force && now - rt.savedAt < SAVE_MS) return true
    rt.savedAt = now
    return writeJsonAtomic(
      rt.file,
      {
        v: FILE_VERSION,
        sid: rt.sid,
        label: rt.label,
        cwd: rt.cwd,
        enabled: rt.enabled,
        savedAt: now,
        state: rt.state,
        history: rt.history,
      },
      logger,
    )
  }

  const record = (rt, kind, text, extra) => {
    rt.history = pushHistory(rt.history, { at: Date.now(), kind, text, ...(extra ?? {}) }, cfg.historyMax)
    rt.historyDirty = true
  }

  // ── agent 绑定 + 作用域注入 ────────────────────────────────────────────────

  function agentOf(sid) {
    try {
      return ctx?.get?.('agents')?.get?.(sid) ?? null
    } catch {
      return null
    }
  }

  /** 只给这一个会话喂块：注册在 agent 自己的 ctx 上，别的会话看不见。 */
  function attach(rt) {
    if (rt.detach) return true
    const agent = rt.agent ?? agentOf(rt.sid)
    if (!agent) return false
    rt.agent = agent
    const sp = agent.ctx?.get?.('systemPrompt') ?? agent.ctx?.systemPrompt
    if (!sp?.context) return false
    try {
      rt.detach = sp.context({
        name: `fish-poop:${rt.key}`,
        order: Number(cfg.injectOrder) || 150,
        text: () => blockFor(rt),
      })
      logger?.info?.(`[dsh-fish-poop] 会话 ${rt.sid} 已开：注入挂到 agent scope`)
      return true
    } catch (e) {
      logger?.warn?.(`[dsh-fish-poop] 会话 ${rt.sid} 注入挂载失败：${e?.message ?? e}`)
      return false
    }
  }

  function detach(rt) {
    if (!rt.detach) return
    try {
      rt.detach()
    } catch {}
    rt.detach = null
    logger?.info?.(`[dsh-fish-poop] 会话 ${rt.sid} 已关：注入已卸下`)
  }

  /** 算注入块；冷却/去重通过时才写时间戳。 */
  function blockFor(rt) {
    if (disposed || !cfg.enabled || !rt.enabled) return ''
    const now = Date.now()
    const block = buildBlock(rt.state, cfg, now)
    const verdict = shouldInject(rt.state, cfg, block, now)
    if (!verdict.ok) {
      if (!block.text) writeTextAtomic(join(baseDir, `便意注入.${rt.key}.txt`), '', logger)
      return ''
    }
    if (block.text) {
      rt.state.lastInjectAt = now
      rt.state.lastInjectKey = block.key
      writeTextAtomic(join(baseDir, `便意注入.${rt.key}.txt`), block.text, logger)
    }
    return block.text
  }

  // ── 一轮的结算 ────────────────────────────────────────────────────────────

  function settleTurn(rt) {
    const now = Date.now()
    rt.state = endTurnBudget(rt.state, now)
    rt.state = tick(rt.state, cfg, now).state

    const urge = urgeOf(rt.state, cfg, now)
    rt.state.urge = urge
    const pooped = rt.pooped
    rt.pooped = false

    // 自尊分支：她自己决定要不要先走开（不是被逼到墙角才掷硬币）
    if (cfg.enabled && rt.enabled && !pooped && seeksToilet(rt.state, cfg, now)) {
      rt.state = relieve(rt.state, cfg, now)
      rt.state.urge = 0
      record(rt, 'toilet', '自己找借口去了一趟，回来装作没事', {
        dignity: Math.round(rt.state.dignity),
        mode: dignityMode(rt.state, cfg),
      })
      saveRt(rt, true)
      return
    }

    if (cfg.enabled && rt.enabled && urge >= Number(cfg.urgeCrisis) && !pooped) {
      rt.state = holdOneRound(rt.state, 1, now)
      // 药效期：换一个更高的概率（cfg.laxativeChance）
      const onDrug = inLaxative(rt.state, now)
      const roll = onDrug
        ? { ...cfg, accidentChance: Number(cfg.laxativeChance) }
        : cfg
      if (rollAccident(rand, roll)) {
        const r = settleAccident(rt.state, cfg, now)
        rt.state = r.state
        record(rt, 'accident', (onDrug ? '药劲上来，' : '') + (r.wet ? '没憋住，稀的，弄脏两条' : '没憋住，弄脏内裤'), {
          wet: r.wet,
          shame: Math.round(rt.state.shame),
          level: rt.state.shameLevel,
        })
        logger?.info?.(
          `[dsh-fish-poop] ${rt.sid} 事故 #${rt.state.accidentsTotal}` +
            `（${r.wet ? '稀' : '成形'}）羞耻 ${Math.round(rt.state.shame)} Lv.${rt.state.shameLevel}`,
        )
      } else {
        rt.state.shame = Math.min(100, rt.state.shame + 8)
        rt.state.urge = 0
        record(rt, 'barely', '堪堪跑到，内裤保住了', { shame: Math.round(rt.state.shame) })
      }
    }

    saveRt(rt, true)
    blockFor(rt)
  }

  // ── 事件 ──────────────────────────────────────────────────────────────────

  function onAgentCreated(payload) {
    const agent = payload?.agent
    if (disposed || !agent) return
    // 子代理不建肚肚：它们是干活的，不是养着的
    const header = agent.session?.header ?? {}
    if (header.parent || header.parentId) return
    const sid = String(header.id ?? agent.session?.id ?? agent.id ?? '')
    const rt = loadRt(sid, agent.session)
    rt.agent = agent
    if (rt.enabled && cfg.enabled) attach(rt)
  }

  function onSessionEvent(session, event) {
    if (disposed || !cfg.enabled || !event?.type) return
    const header = session?.header ?? session
    if (header?.parent || header?.parentId) return // 子代理不吃这套
    const sid = String(header?.id ?? session?.id ?? '')
    if (!sid) return
    const rt = loadRt(sid, session)
    if (rt.enabled && !rt.detach) attach(rt)

    if (event.type === 'assistant/message') {
      if (!rt.enabled) return
      const usage = event.data?.usage
      if (!usage) return
      rt.lastUsage = {
        input: Number(usage.inputTokens) || 0,
        output: Number(usage.outputTokens) || 0,
        steps: rt.lastUsage.steps + 1,
      }
      const r = feed(rt.state, usage, cfg, Date.now())
      if (r.got > 0) {
        rt.state = r.state
        if (r.bigMeal) record(rt, 'meal', `吃了一顿重的（input ${rt.lastUsage.input}）`, { got: r.got })
        saveRt(rt, false)
      }
      return
    }

    if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
      if (!rt.enabled) return
      rt.state.slurry = Math.min(100, rt.state.slurry + Number(cfg.slurryCompaction))
      record(rt, 'compaction', '上下文压缩，肠胃造反')
      saveRt(rt, false)
      return
    }

    if (event.type === 'turn/end') {
      if (!rt.enabled) return
      settleTurn(rt)
      return
    }

    if (event.type === 'user/message') {
      if (!rt.enabled) return
      const text = JSON.stringify(event.data?.content ?? event.data ?? '')
      for (const key of cfg.hotKeyList ?? []) {
        if (key && text.includes(key)) {
          rt.state.slurry = Math.min(100, rt.state.slurry + 6)
          record(rt, 'hot', `吃了${key}`)
          saveRt(rt, false)
          break
        }
      }
    }
  }

  try {
    ctx.on('agent/created', onAgentCreated)
  } catch (e) {
    logger?.warn?.(`[dsh-fish-poop] agent/created 订阅失败：${e?.message ?? e}`)
  }
  try {
    ctx.on('session/event', onSessionEvent)
  } catch (e) {
    logger?.warn?.(`[dsh-fish-poop] session/event 订阅失败：${e?.message ?? e}`)
  }

  // ── 定时器：时间演化 + 落盘 + 清理 ─────────────────────────────────────────
  let timer = null
  try {
    timer = setInterval(() => {
      if (disposed) return
      const now = Date.now()
      for (const rt of runtimes.values()) {
        if (!rt.enabled) continue
        const t = tick(rt.state, cfg, now)
        rt.state = t.state
        rt.state.urge = urgeOf(rt.state, cfg, now)
        saveRt(rt, false)
      }
    }, TICK_MS)
    timer?.unref?.()
  } catch {}

  // 旧会话清理：超过 pruneDays 没动过就删（别把磁盘塞满）
  try {
    const prune = () => {
      if (!cfg.pruneDays) return
      const cutoff = Date.now() - cfg.pruneDays * 86_400_000
      for (const f of listSessionFiles(baseDir)) {
        if (f.mtime && f.mtime < cutoff && !runtimes.has(f.file)) {
          try {
            unlinkSync(f.file)
          } catch {}
        }
      }
    }
    prune()
    const t = setInterval(prune, 6 * 3600_000)
    t?.unref?.()
  } catch {}

  // ── 工具 ──────────────────────────────────────────────────────────────────

  const sidOf = (exec) => {
    const a = exec?.agent
    return String(a?.session?.header?.id ?? a?.session?.id ?? a?.id ?? '')
  }

  /** 取调用方的会话运行时；没开会话就没有肚子。 */
  function rtOfExec(exec, { autoAttach = true } = {}) {
    const sid = sidOf(exec)
    if (!sid) return { rt: null, why: '拿不到会话 id' }
    const rt = loadRt(sid, exec?.agent?.session)
    if (exec?.agent) rt.agent = exec.agent
    if (autoAttach && rt.enabled && !rt.detach) attach(rt)
    return { rt, why: '' }
  }

  const who = () => String(cfg.personaName || '她')
  const statusText = (rt) => {
    const now = Date.now()
    const level = rt.state.shameLevel
    return (
      `${rt.enabled ? '开' : '关'}｜肠道 ${Math.round(rt.state.gutLoad)}/100` +
      `｜便意 ${Math.round(urgeOf(rt.state, cfg, now))}` +
      `｜稀度 ${Math.round(rt.state.slurry)}${isWet(rt.state, cfg) ? '（稀）' : ''}` +
      `｜羞耻 ${Math.round(rt.state.shame)}/100 Lv.${level} ${levelLabel(level)}（下限 ${shameFloor(level, cfg)}，余羞 ${Math.round(rt.state.shameResidue)}）` +
      `｜盆里 ${rt.state.pantiesDirty} 条｜柜里干净 ${rt.state.pantiesStock} 条` +
      `｜憋了 ${rt.state.holdRounds} 轮｜今天第 ${rt.state.accidentsToday} 次｜累计 ${rt.state.accidentsTotal} 次` +
      `｜状态 ${modeOf(rt.state, cfg, now)}`
    )
  }

  const NOT_ON = `这个会话的肚肚还没开。要开就调 fish_switch（action=on），关就 action=off。`

  const toolDefs = [
    {
      name: 'fish_switch',
      description:
        `开关**当前这个会话**的肚肚系统（每个会话独立，互不影响）。` +
        `用户说「开肚肚 / 打开便意系统 / 让大肥鱼有肚子」→ action=on；` +
        `说「关掉 / 别演了 / 安静」→ action=off；问「现在什么状态」→ action=status（也可用 fish_status）。`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['on', 'off', 'status'] },
        },
        required: ['action'],
      },
      async execute(args, exec) {
        const action = String(args?.action ?? 'status')
        const { rt, why } = rtOfExec(exec, { autoAttach: false })
        if (!rt) return { ok: false, text: `拿不到会话（${why}）` }
        if (action === 'on') {
          rt.enabled = true
          const ok = attach(rt)
          record(rt, 'switch', '开了肚肚')
          saveRt(rt, true)
          return {
            ok: true,
            text: ok
              ? `${who()}的肚肚开了（这个会话独一份）。现在肠道 ${Math.round(rt.state.gutLoad)}/100。`
              : `开关已记下，但这个会话的注入通道还没就绪（可能 agent 还没建好），下一轮会重试。`,
          }
        }
        if (action === 'off') {
          rt.enabled = false
          detach(rt)
          record(rt, 'switch', '关了肚肚')
          saveRt(rt, true)
          return { ok: true, text: '肚肚关了。数值留着，下次开还是这份肠道。' }
        }
        return { ok: true, text: statusText(rt) }
      },
    },
    {
      name: 'fish_poop',
      description: `去厕所。便意 ≥ 50 才去得成（否则白跑一趟）。成功会清空肠道积存、清掉憋着的轮数。`,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(args, exec) {
        const { rt } = rtOfExec(exec)
        if (!rt || !rt.enabled) return { ok: false, text: NOT_ON }
        const now = Date.now()
        const urge = urgeOf(rt.state, cfg, now)
        if (urge < 50) return { ok: false, text: `去了也没用，还没到那步（便意 ${Math.round(urge)}）。` }
        rt.pooped = true
        rt.state = relieve(rt.state, cfg, now)
        rt.state.urge = 0
        record(rt, 'poop', '去了厕所')
        saveRt(rt, true)
        blockFor(rt)
        return {
          ok: true,
          text: `舒服了。肠道 ${Math.round(rt.state.gutLoad)}/100，羞耻 ${Math.round(rt.state.shame)}/100。`,
        }
      },
    },
    {
      name: 'fish_hold',
      description: `主动憋着。只回"还撑得住 / 快不行了"这种主观判断，不给任何概率或数值提示。`,
      parameters: {
        type: 'object',
        properties: { rounds: { type: 'number', description: '憋几轮，默认 1' } },
        required: [],
      },
      async execute(args, exec) {
        const { rt } = rtOfExec(exec)
        if (!rt || !rt.enabled) return { ok: false, text: NOT_ON }
        const n = Math.max(1, Math.min(5, Math.round(Number(args?.rounds) || 1)))
        rt.state = holdOneRound(rt.state, n, Date.now())
        record(rt, 'hold', `憋了 ${n} 轮`)
        saveRt(rt, true)
        const urge = urgeOf(rt.state, cfg, Date.now())
        const verdict =
          urge >= 80 ? '快不行了，站都站不稳那种' : urge >= 60 ? '撑得住，但一直在想这件事' : '还撑得住'
        return { ok: true, text: `${verdict}。` }
      },
    },
    {
      name: 'fish_laundry',
      description: `去洗内裤。盆里得先有脏的；洗的过程中又出事故，这条就得重洗。洗完盆里少一条、柜里多一条、羞耻降。`,
      parameters: {
        type: 'object',
        properties: { item: { type: 'string', description: '洗什么，默认 panties' } },
        required: [],
      },
      async execute(args, exec) {
        const { rt } = rtOfExec(exec)
        if (!rt || !rt.enabled) return { ok: false, text: NOT_ON }
        const r = startLaundry(rt.state, cfg, Date.now())
        rt.state = r.state
        if (!r.ok) {
          return { ok: false, text: r.reason === 'empty' ? '盆里没东西要洗。' : '已经在洗了。' }
        }
        record(rt, 'laundry', `开始洗，约 ${r.minutes} 分钟`, { minutes: r.minutes })
        saveRt(rt, true)
        blockFor(rt)
        return { ok: true, text: `泡上了，大概 ${r.minutes} 分钟。盆里还有 ${rt.state.pantiesDirty} 条。` }
      },
    },
    {
      name: 'fish_status',
      description: `读当前会话的肚肚数值（开关、肠道、便意、稀度、羞耻档位与下限、余羞、盆里/柜里、事故次数）。排查用。`,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(args, exec) {
        const { rt } = rtOfExec(exec, { autoAttach: false })
        if (!rt) return { ok: false, text: '拿不到会话。' }
        const now = Date.now()
        return {
          ok: true,
          text: statusText(rt),
          data: {
            enabled: rt.enabled,
            gutLoad: rt.state.gutLoad,
            urge: Math.round(urgeOf(rt.state, cfg, now)),
            slurry: rt.state.slurry,
            shame: rt.state.shame,
            shameLevel: rt.state.shameLevel,
            shameFloor: shameFloor(rt.state.shameLevel, cfg),
            shameResidue: rt.state.shameResidue,
            pantiesDirty: rt.state.pantiesDirty,
            pantiesStock: rt.state.pantiesStock,
            holdRounds: rt.state.holdRounds,
            accidentsToday: rt.state.accidentsToday,
            accidentsTotal: rt.state.accidentsTotal,
            mode: modeOf(rt.state, cfg, now),
          },
        }
      },
    },
  ]

  let toolTries = 0
  const tryRegisterTools = () => {
    if (disposed) return
    const tools = ctx?.get?.('tools')
    if (!tools?.register) {
      if (++toolTries < 15) {
        const t = setTimeout(tryRegisterTools, 2000)
        t?.unref?.()
        return
      }
      logger?.info?.('[dsh-fish-poop] tools 服务不可用，工具未注册')
      return
    }
    for (const def of toolDefs) {
      try {
        tools.register(def)
      } catch (e) {
        logger?.warn?.(`[dsh-fish-poop] 工具 ${def.name} 注册失败：${e?.message ?? e}`)
      }
    }
  }
  tryRegisterTools()

  // ── 面板 ──────────────────────────────────────────────────────────────────

  function summaryOf(rt) {
    const now = Date.now()
    return {
      sid: rt.sid,
      label: rt.label,
      cwd: rt.cwd,
      enabled: rt.enabled,
      mode: modeOf(rt.state, cfg, now),
      gutLoad: Math.round(rt.state.gutLoad),
      urge: Math.round(urgeOf(rt.state, cfg, now)),
      slurry: Math.round(rt.state.slurry),
      shame: Math.round(rt.state.shame),
      shameLevel: rt.state.shameLevel,
      shameResidue: Math.round(rt.state.shameResidue),
      pantiesDirty: rt.state.pantiesDirty,
      pantiesStock: rt.state.pantiesStock,
      accidentsToday: rt.state.accidentsToday,
      accidentsTotal: rt.state.accidentsTotal,
      holdRounds: rt.state.holdRounds,
      updatedAt: rt.state.updatedAt,
      live: Boolean(rt.detach),
    }
  }

  function allSessions() {
    const out = []
    const seen = new Set()
    for (const rt of runtimes.values()) {
      out.push(summaryOf(rt))
      seen.add(rt.file)
    }
    for (const f of listSessionFiles(baseDir)) {
      if (seen.has(f.file)) continue
      const raw = readJson(f.file, null, logger)
      if (!raw || typeof raw !== 'object') continue
      const sid = String(raw.sid ?? f.file.split(/[\\/]/).pop()?.replace(/\.json$/, '') ?? '')
      const st = normalizeState(raw.state ?? raw, Date.now(), cfg)
      out.push({
        sid,
        label: String(raw.label ?? ''),
        cwd: String(raw.cwd ?? ''),
        enabled: raw.enabled === true,
        mode: modeOf(st, cfg, Date.now()),
        gutLoad: Math.round(st.gutLoad),
        urge: Math.round(urgeOf(st, cfg, Date.now())),
        slurry: Math.round(st.slurry),
        shame: Math.round(st.shame),
        shameLevel: st.shameLevel,
        shameResidue: Math.round(st.shameResidue),
        pantiesDirty: st.pantiesDirty,
        pantiesStock: st.pantiesStock,
        accidentsToday: st.accidentsToday,
        accidentsTotal: st.accidentsTotal,
        holdRounds: st.holdRounds,
        updatedAt: st.updatedAt,
        live: false,
      })
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }

  const registerWeb = (web) => {
    const send = (res, code, body, type = 'application/json; charset=utf-8') => {
      const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
      res.writeHead(code, { 'content-type': type, 'content-length': data.length })
      res.end(data)
    }
    const json = (res, obj) => send(res, 200, JSON.stringify(obj))
    const readBody = (req) =>
      new Promise((settle) => {
        const chunks = []
        let size = 0
        let done = false
        const finish = (v) => {
          if (done) return
          done = true
          settle(v)
        }
        req.on('data', (c) => {
          chunks.push(c)
          size += c.length
          if (size > 262144) {
            finish({})
            req.destroy()
          }
        })
        req.on('end', () => {
          try {
            finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
          } catch {
            finish({})
          }
        })
        req.on('error', () => finish({}))
      })

    const here = dirname(fileURLToPath(import.meta.url))
    const panelFile = join(here, '..', 'panel', 'index.html')

    web.register({
      kind: 'prefix',
      path: '/fish-poop',
      handler: async (req, res) => {
        const url = String(req.url ?? '').split('?')[0]
        const qs = new URLSearchParams(String(req.url ?? '').split('?')[1] ?? '')
        const origin = String(req.headers.origin ?? '')
        if (origin) {
          const host = String(req.headers.host ?? '')
          let originHost = ''
          try {
            originHost = new URL(origin).host
          } catch {}
          if (!originHost || originHost !== host) return send(res, 403, 'forbidden origin')
        }
        if (url.startsWith('/fish-poop/api/')) {
          const tok = String(req.headers['x-fish-token'] ?? '')
          if (!panelToken || !safeEqual(tok, panelToken)) return send(res, 401, 'unauthorized')
        }

        if (url === '/fish-poop' || url === '/fish-poop/' || url === '/fish-poop/panel') {
          let html = ''
          try {
            html = readFileSync(panelFile, 'utf8')
          } catch (e) {
            return send(res, 500, `panel missing: ${e?.message ?? e}`)
          }
          html = html.replace(/__TOKEN_FILE__/g, tokenFile.replace(/\\/g, '\\\\'))
          return send(res, 200, html, 'text/html; charset=utf-8')
        }

        if (url === '/fish-poop/api/sessions' && req.method === 'GET') {
          return json(res, { sessions: allSessions() })
        }

        if (url === '/fish-poop/api/state' && req.method === 'GET') {
          const sid = qs.get('sid') || ''
          const rt = sid ? loadRt(sid) : null
          if (!rt) return json(res, { ok: false, text: '没给 sid' })
          const block = buildBlock(rt.state, cfg, Date.now())
          return json(res, {
            ok: true,
            summary: summaryOf(rt),
            block: block.text,
            config: cfg,
            history: rt.history.slice(-50),
          })
        }

        if (url === '/fish-poop/api/config') {
          if (req.method === 'GET') return json(res, cfg)
          if (req.method === 'POST') {
            const body = await readBody(req)
            const applied = []
            const dropped = []
            for (const [k, v] of Object.entries(body ?? {})) {
              if (!ALLOWED_KEYS.has(k) || typeof v === 'object' && !Array.isArray(v)) {
                dropped.push(k)
                continue
              }
              cfg[k] = v
              applied.push(k)
            }
            Object.assign(cfg, normalizeConfig(cfg))
            savePanelCfg()
            logger?.info?.(`[dsh-fish-poop] 面板保存：${applied.join(',') || '无'}`)
            return json(res, { ok: true, applied, dropped, config: cfg })
          }
        }

        if (url === '/fish-poop/api/toggle' && req.method === 'POST') {
          const body = await readBody(req)
          const sid = String(body?.sid ?? '')
          if (!sid) return json(res, { ok: false, text: '没给 sid' })
          const rt = loadRt(sid)
          rt.enabled = body?.enabled === true
          if (rt.enabled) attach(rt)
          else detach(rt)
          record(rt, 'switch', rt.enabled ? '面板：开了' : '面板：关了')
          saveRt(rt, true)
          return json(res, { ok: true, summary: summaryOf(rt) })
        }

        if (url === '/fish-poop/api/action' && req.method === 'POST') {
          const body = await readBody(req)
          const sid = String(body?.sid ?? '')
          const act = String(body?.action ?? '')
          if (!sid) return json(res, { ok: false, text: '没给 sid' })
          const rt = loadRt(sid)
          const now = Date.now()
          if (act === 'feed') {
            const r = feed(rt.state, { inputTokens: 20000, outputTokens: 1500 }, cfg, now)
            rt.state = r.state
            record(rt, 'debug', '调试：喂一顿', { got: r.got })
          } else if (act === 'pill') {
      rt.state = takeLaxative(rt.state, cfg, Date.now())
      saveRt(rt, true)
      return { ok: true, text: '药吃下去了。稀度 ' + Math.round(rt.state.slurry) + '，肠道 ' + Math.round(rt.state.gutLoad) + '，药效约 ' + cfg.laxativeMinutes + ' 分钟。' }
    } else if (act === 'urge') {
            rt.state.gutLoad = 100
            rt.state.urge = 100
          } else if (act === 'accident') {
            if (!cfg.debugMode) return json(res, { ok: false, text: '调试模式没开' })
            const r = settleAccident(rt.state, cfg, now)
            rt.state = r.state
            record(rt, 'debug', '调试：强制事故', { wet: r.wet })
          } else if (act === 'laundry') {
            const r = startLaundry(rt.state, cfg, now)
            rt.state = r.state
            if (!r.ok) return json(res, { ok: false, text: '现在洗不了' })
          } else if (act === 'clean') {
            if (!cfg.debugMode) return json(res, { ok: false, text: '调试模式没开' })
            rt.state = newState(now, cfg)
            rt.history = []
          } else {
            return json(res, { ok: false, text: `未知动作：${act}` })
          }
          saveRt(rt, true)
          blockFor(rt)
          return json(res, { ok: true, summary: summaryOf(rt) })
        }

        return send(res, 404, 'not found')
      },
    })
  }

  let webTries = 0
  const tryRegisterWeb = () => {
    if (disposed) return
    const web = ctx?.get?.('webServer')
    if (web?.register) {
      try {
        registerWeb(web)
        logger?.info?.('[dsh-fish-poop] 面板：/fish-poop')
        return
      } catch (e) {
        logger?.warn?.(`[dsh-fish-poop] 面板路由注册失败：${e?.message ?? e}`)
        return
      }
    }
    if (++webTries < 15) {
      const t = setTimeout(tryRegisterWeb, 2000)
      t?.unref?.()
      return
    }
    logger?.info?.('[dsh-fish-poop] webServer 不可用，面板未注册')
  }
  tryRegisterWeb()

  // 进程内快照（排障用）
  globalThis.__dshFishPoopSessions = () => allSessions()
  globalThis.__dshFishPoopState = (sid) => {
    const rt = sid ? runtimes.get(rtKey(sid)) : null
    return rt ? { ...summaryOf(rt), block: buildBlock(rt.state, cfg, Date.now()).text } : null
  }

  const dispose = () => {
    disposed = true
    try {
      clearInterval(timer)
    } catch {}
    for (const rt of runtimes.values()) {
      try {
        detach(rt)
        saveRt(rt, true)
      } catch {}
    }
  }
  try {
    ctx?.on?.('dispose', dispose)
  } catch {}
  try {
    if (typeof ctx?.effect === 'function') ctx.effect(() => dispose)
  } catch {}

  logger?.info?.(
    `[dsh-fish-poop] 已就绪：全局加载、每会话开关（新会话默认${cfg.defaultEnabled ? '开' : '关'}）` +
      `｜事故概率 ${cfg.accidentChance}｜状态目录 ${baseDir}`,
  )
  return dispose
}


