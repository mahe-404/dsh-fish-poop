#!/usr/bin/env node
/**
 * 自检：确认这个插件是「全局加载、每会话开关」的正常形态。
 *
 * 用法：node tools/doctor.mjs
 * 只读，不改任何文件。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profile = join(dshHome, 'profiles', 'desktop')

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`)
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`)
const info = (m) => console.log(`    ${m}`)

console.log('\n大肥鱼的肚肚 · 自检（v0.2 全局加载 / 每会话开关）\n' + '─'.repeat(52))

// 1. 包本体
console.log('\n[1] 包本体')
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
ok(`name=${pkg.name} version=${pkg.version}`)
if (pkg.dsh?.bundle?.patch) ok(`声明了 bundle patch：${pkg.dsh.bundle.patch}（这是全局加载的入口）`)
else bad('没有 dsh.bundle.patch：DSH 不会把它插进配置树，工具不会出现')

const patchFile = join(pkgRoot, 'cordis.patch.yml')
if (existsSync(patchFile)) {
  const text = readFileSync(patchFile, 'utf8')
  const hasId = /id:\s*fish-poop/.test(text)
  const hasName = /name:\s*['"]?dsh-fish-poop/.test(text)
  if (hasId && hasName) ok('cordis.patch.yml 里 id/name 正确')
  else bad('cordis.patch.yml 缺 id: fish-poop 或 name: dsh-fish-poop')
} else {
  bad('缺 cordis.patch.yml')
}

// 2. profile
console.log('\n[2] profile 装载')
const linked = join(profile, 'node_modules', pkg.name)
if (existsSync(linked)) ok(`node_modules/${pkg.name} 可解析`)
else bad(`node_modules/${pkg.name} 不存在：bundle 行会加载失败`)

let declared = false
let inBundles = false
try {
  const pj = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  declared = Boolean(pj.dependencies?.[pkg.name])
  inBundles = (pj.dsh?.profile?.bundles ?? []).includes(pkg.name)
} catch {}
if (declared) ok('profile package.json 有 link 依赖')
else bad('profile package.json 没有声明这个依赖')
if (inBundles) ok('在 dsh.profile.bundles 里（所以每个会话都能看见 fish_switch）')
else bad('不在 dsh.profile.bundles 里：插件不会被加载')

// 3. 不该还有预设挂载
console.log('\n[3] 预设（应该没有）')
const presetRoot = join(dshHome, '.agent-presets')
const leftovers = []
if (existsSync(presetRoot)) {
  for (const d of readdirSync(presetRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const f = join(presetRoot, d.name, 'agent.cordis.yml')
    if (!existsSync(f)) continue
    const live = readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n')
    if (live.includes('dsh-fish-poop')) leftovers.push(d.name)
  }
}
if (!leftovers.length) ok('没有预设再挂它（已经改成全会话开关）')
else bad(`这些预设还挂着它，会和 bundles 重复加载：${leftovers.join(',')}`)

// 4. 每会话状态
console.log('\n[4] 会话状态')
const sessDir = join(dshHome, 'fish-poop', 'sessions')
if (existsSync(sessDir)) {
  const files = readdirSync(sessDir).filter((n) => n.endsWith('.json'))
  if (!files.length) info('还没有任何会话开过肚肚（默认关，等你说"开肚肚"）')
  for (const n of files.slice(0, 12)) {
    try {
      const s = JSON.parse(readFileSync(join(sessDir, n), 'utf8'))
      const st = s.state ?? {}
      info(
        `${s.enabled ? '开' : '关'}  ${String(s.sid ?? n).slice(0, 22)}  ` +
          `肠道 ${Math.round(st.gutLoad ?? 0)}｜羞耻 ${Math.round(st.shame ?? 0)} Lv.${st.shameLevel ?? 0}` +
          `｜盆 ${st.pantiesDirty ?? 0}/柜 ${st.pantiesStock ?? 0}｜事故 ${st.accidentsTotal ?? 0}`,
      )
    } catch {}
  }
  if (files.length > 12) info(`…… 还有 ${files.length - 12} 个`)
} else {
  info('sessions 目录还不存在 —— 说明插件还没在这个进程里跑过（正常，重启后会出现）')
}

console.log('\n' + '─'.repeat(52))
console.log('生效需要：重启 DSH → 随便哪个会话说「开肚肚」（模型调 fish_switch on）')
console.log('面板：<web>/fish-poop —— 令牌在 ' + join(dshHome, 'fish-poop', '面板令牌.txt'))
console.log('关掉只影响那个会话；主机总闸是 cordis.patch.yml 里的 enabled\n')
