/**
 * 可注入的随机源。
 *
 * 事故判定必须是真随机（1/2），但测试要可复现 —— 所以不用 Math.random()，
 * 一律走这个接口：生产用 makeRng()，测试用 makeRng(seed) 固定序列。
 */

/** mulberry32：小、快、够用，同 seed 同序列。 */
export function makeRng(seed) {
  if (seed === undefined || seed === null) return () => Math.random()
  let a = Number(seed) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
