/**
 * 状态与历史落盘：原子写 + 损坏自愈。
 *
 * v0.2 起是「每会话一份」：sessions/<sid>.json。
 * 坏文件不删、改名 .bad 留着看现场。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/** 原子写：先写 .tmp 再 rename，断电不会留下半个文件。 */
export function writeJsonAtomic(file, data, logger) {
  try {
    ensureDir(dirname(file))
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    try {
      renameSync(tmp, file)
    } catch {
      // Windows 上目标被占用时 rename 会失败：删掉目标再试一次
      try {
        unlinkSync(file)
      } catch {}
      renameSync(tmp, file)
    }
    return true
  } catch (e) {
    logger?.warn?.(`[dsh-fish-poop] 写入失败：${file} ${e?.code ?? ''} ${e?.message ?? e}`)
    return false
  }
}

export function writeTextAtomic(file, text, logger) {
  try {
    ensureDir(dirname(file))
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, String(text ?? ''), 'utf8')
    try {
      renameSync(tmp, file)
    } catch {
      try {
        unlinkSync(file)
      } catch {}
      renameSync(tmp, file)
    }
    return true
  } catch (e) {
    logger?.warn?.(`[dsh-fish-poop] 注入块写入失败：${file} ${e?.message ?? e}`)
    return false
  }
}

/**
 * 读 JSON。坏文件改名 .bad（只留最近一份），返回 fallback。
 * @param {string} file 路径
 * @param {*} fallback 读不到时的返回值
 * @param {object} logger 日志
 */
export function readJson(file, fallback, logger) {
  if (!existsSync(file)) return fallback
  try {
    const raw = readFileSync(file, 'utf8')
    if (!raw.trim()) return fallback
    return JSON.parse(raw)
  } catch (e) {
    try {
      renameSync(file, `${file}.bad`)
      logger?.warn?.(`[dsh-fish-poop] 状态文件损坏，已改名 .bad 并重建：${e?.message ?? e}`)
    } catch {}
    return fallback
  }
}

/** 历史环形写入：面板时间线只读这个。 */
export function pushHistory(history, entry, max) {
  const list = Array.isArray(history) ? history : []
  list.push(entry)
  const cap = Math.max(20, Number(max) || 500)
  return list.length > cap ? list.slice(list.length - cap) : list
}

/** 会话 id 不能直接当文件名：只留安全字符。 */
export function safeSid(sid) {
  return String(sid ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown'
}

export function sessionsDir(baseDir) {
  return join(baseDir, 'sessions')
}

export function sessionFile(baseDir, sid) {
  return join(sessionsDir(baseDir), `${safeSid(sid)}.json`)
}

/** 列出磁盘上所有会话状态（面板用）。坏文件跳过。 */
export function listSessionFiles(baseDir) {
  const dir = sessionsDir(baseDir)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => {
        const file = join(dir, n)
        let mtime = 0
        try {
          mtime = statSync(file).mtimeMs
        } catch {}
        return { file, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}
