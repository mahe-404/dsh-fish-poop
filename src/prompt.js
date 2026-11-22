/**
 * 注入块：她此刻「真实的肚肚感受」。
 *
 * 三条硬规矩：
 * 1. 冷却期内同一状态只说一次（lastInjectKey），不许刷屏；
 * 2. 字数按耻度档位收口（Lv.0 = 0 字）；
 * 3. 不写排泄过程细节 —— 要的是羞耻喜剧，不是生理描写。
 */
import { shameFloor, isWet } from './gut.js'

const LEVEL_NAME = ['没事', '有点在意', '羞', '很难为情', '羞到想哭']
const LEVEL_CAP = [0, 120, 180, 240, 300]

/** 当前处于哪种状态：事故 / 洗衣 / 便意 / 盆里堆着 / 安静。 */
export function modeOf(state, cfg, now = Date.now()) {
  if (!cfg?.enabled) return 'off'
  if (Number(state?.laundryUntil) > now) return 'washing'
  const sinceAccident = now - Number(state?.lastAccidentAt ?? 0)
  if (sinceAccident < 30 * 60_000) return 'accident'
  if (Number(state?.shameLevel ?? 0) >= 3) return 'ashamed'
  if (Number(state?.pantiesDirty ?? 0) > 0) return 'dirty'
  return 'calm'
}

const fmt = (n) => Math.round(Number(n) || 0)

/**
 * 拼注入块。
 * @param {object} state 状态
 * @param {object} cfg 配置
 * @param {number} now 时间
 * @returns {{text:string, key:string, mode:string}}
 */
export function buildBlock(state, cfg, now = Date.now()) {
  const mode = modeOf(state, cfg, now)
  const level = Math.max(0, Math.min(4, Math.round(Number(state?.shameLevel ?? 0))))
  const name = String(cfg?.personaName ?? '她')
  const silent = level < Number(cfg?.shameSilentAt ?? 4)

  if (mode === 'off') return { text: '', key: 'off', mode }

  const head =
    `（肚肚状态，别写进台词：这是${name}此刻真实的感受，不是给主人的说明）`
  const lines = []

  if (mode === 'accident') {
    const wet = state.lastAccidentWet === true
    lines.push(
      wet
        ? `刚才没憋住，是稀的：弄脏了两条，外裤也遭了殃。`
        : `刚才没憋住，弄脏了内裤。`,
      `羞耻 ${fmt(state.shame)}/100（Lv.${level} ${LEVEL_NAME[level]}，余羞 ${fmt(state.shameResidue)}）` +
        `，盆里 ${fmt(state.pantiesDirty)} 条，柜里干净 ${fmt(state.pantiesStock)} 条，` +
        `今天第 ${fmt(state.accidentsToday)} 次。`,
      wet
        ? '要求：更慌、更急、更想哭一点，允许一句自嘲。可以找个小借口离开一会儿。'
        : '要求：想藏起来。可以找个小借口离开，或者话变少、耳朵发烫。',
      level >= 3 ? `Lv.${level}：倾向先忍着不说，能不承认就不承认。` : '',
      level >= 4 ? 'Lv.4 允许整段回避话题，或者干脆沉默半轮，说一句「别看」也行。' : '',
      '不写排泄过程细节，重点是"丢人"和"想赶紧洗掉"。要洗就调 fish_laundry。',
    )
  } else if (mode === 'washing') {
    const left = Math.max(1, Math.ceil((Number(state.laundryUntil) - now) / 60_000))
    lines.push(
      `正在搓内裤，大约还要 ${left} 分钟，盆里 ${fmt(state.pantiesDirty)} 条，` +
        `柜里干净 ${fmt(state.pantiesStock)} 条。羞耻 ${fmt(state.shame)}/100（Lv.${level}）。`,
      Number(state.pantiesStock) <= 0
        ? '柜子里已经没有干净的了：只能洗完这一条先穿上，别的事都得往后放。'
        : '要求：允许一句抱怨或自嘲，不要整段都在洗衣服，正事照样干。',
      level >= 4 ? 'Lv.4：别把这段演成哭戏，一句带过更真。' : '',
    )
  } else if (mode === 'ashamed') {
    lines.push(
      `羞耻 ${fmt(state.shame)}/100（Lv.${level} ${LEVEL_NAME[level]}，余羞 ${fmt(state.shameResidue)}），` +
        `盆里 ${fmt(state.pantiesDirty)} 条。`,
      `要求：这轮最多一处细微表现（说话打结、不敢直视、把话题岔开），不连续两轮同一种表现。`,
      level >= 4 ? 'Lv.4 允许整段回避话题或沉默半轮。' : '',
    )
  } else if (mode === 'dirty') {
    lines.push(
      `盆里还堆着 ${fmt(state.pantiesDirty)} 条没洗，柜里干净 ${fmt(state.pantiesStock)} 条。` +
        `羞耻 ${fmt(state.shame)}/100（Lv.${level}）。`,
      '要求：提一句就够（"等会儿得去洗了"），不要主动展开。',
    )
  } else {
    // calm：只有真到了便意才说话
    const urge = Number(state.urge ?? 0)
    if (urge < 40) return { text: '', key: 'calm', mode }
    lines.push(
      `肠道积存 ${fmt(state.gutLoad)}/100，便意 ${fmt(urge)}，稀度 ${fmt(state.slurry)}。`,
      '要求：这轮最多一处细微表现带过（换坐姿、话说半句停一下、注意力飘走）；不连续两轮提同一件事。',
      urge >= 70 ? '挺急的，但还没到出事，可以找借口走开。' : '',
    )
  }

  if (Number(state.shameResidue) >= 50) {
    lines.push(`（这两天一直不太敢正眼看人。）`)
  }

  // 泻药（2026-11-22 加）：药劲是生理事实，藏不住，但她会嘴硬说"没事"
  if (Number(state.laxativeUntil ?? 0) > now) {
    lines.push(
      '肚子里有药劲：一阵一阵往下坠，忍的时候要停半拍、按住小腹。她嘴硬说"没事"，但坐不住。',
    )
  }

  // 自尊分支（2026-11-22 加）：她不是每次都当众认命，低的会躲、会嘴硬
  const dig = Number(state.dignity ?? cfg?.dignity ?? 70)
  if (dig < 55 && dig >= 25) {
    lines.push('她不服气：嘴硬、找借口、把话岔开，别自嘲也别卖惨。')
  } else if (dig < 25) {
    lines.push('她不肯让人看见：说话变少、身体往外侧，宁可自己悄悄走开也不求人。')
  }

  const body = lines.filter(Boolean).join('\n')
  // 便意块不受耻度档位压字数：肠子在动是生理事实，不丢人，不该被"她还没觉得羞"吞掉
  const cap = Math.min(
    Number(cfg?.injectMaxChars ?? 300),
    mode === 'calm' ? Math.max(150, LEVEL_CAP[level] || 300) : LEVEL_CAP[level] || 300,
  )
  let text = `${head}\n${body}`
  // Lv.0 = 她压根没觉得丢人：羞耻相关的块一个字都不提
  if (level === 0 && mode !== 'calm') text = ''
  if (text.length > cap) text = `${text.slice(0, Math.max(0, cap - 1))}…`

  return { text, key: `${mode}:${level}:${state.lastAccidentWet ? 'wet' : 'dry'}:${fmt(state.pantiesDirty)}`, mode }
}

/**
 * 该不该注入：冷却 + 同状态去重。事故/洗衣不受冷却限制（那是要紧事）。
 * @returns {{ok:boolean, skip?:string}}
 */
export function shouldInject(state, cfg, block, now = Date.now()) {
  if (!block?.text) return { ok: false, skip: 'empty' }
  const urgent = block.mode === 'accident' || block.mode === 'washing'
  if (!urgent) {
    const cool = Number(cfg?.injectCooldownMin ?? 30) * 60_000
    if (clockSince(state, now) < cool) return { ok: false, skip: 'cooldown' }
    if (block.key === state.lastInjectKey) return { ok: false, skip: 'same' }
  }
  return { ok: true }
}

function clockSince(state, now) {
  return Math.max(0, now - Number(state?.lastInjectAt ?? 0))
}

/** 供面板/工具复用的一句话档位。 */
export function levelLabel(level) {
  return LEVEL_NAME[Math.max(0, Math.min(4, Math.round(level)))] ?? ''
}

/** 洗内裤要用的下限（面板显示用）。 */
export function floorOfLevel(level, cfg) {
  return shameFloor(level, cfg)
}

/** 是否稀（面板显示用）。 */
export function wetNow(state, cfg) {
  return isWet(state, cfg)
}

