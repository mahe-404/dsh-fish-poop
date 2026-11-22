# dsh-fish-poop · 大肥鱼的肚肚

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的一条**生理副线**：吃 token 会积食，会憋，会憋不住，会羞耻，会自己去洗。

**不是随机弹窗。** 数值由会话真实的 token 消耗驱动：

```
assistant/message 的 usage
      │  fresh = input − cacheRead（缓存命中的是"又嚼了一遍"，不算新饭）
      ▼
  gutLoad ──≥55──▶ urge ──≥85──▶ 掷硬币（1/2）
                                    ├─ 事故：弄脏内裤，羞耻涨，自尊掉
                                    └─ 堪堪跑到：保住，羞耻 +8
                                              │
                                    洗内裤 → 盆里少、柜里多
```

---

## 它和别的东西不一样在哪

1. **数值是真的**，不是脚本随机数。读得多、写得多，就真的会急。
2. **自尊是独立的一条线**（`dignity`）。羞耻会退，自尊退得慢——所以她不会每次都当众认命：
   - 便意够了但自尊还在 → **她自己找借口走开**（不掷硬币）
   - 自尊塌了 → 死要面子硬撑，然后更容易出事
3. **没有每日上限，也没有单次上限**（默认 0 = 不限）。节流靠门槛、`gutLoad −55`、注入冷却 30 分钟，不靠"今天不许再出"。
4. **不做全局插件**（默认）：包只放在 `node_modules` 里让 loader 能解析，真正的加载点是某一个 agent 预设。换预设开会话就完全没有它。

---

## 装

```bash
# 1) 放进本地插件目录
git clone <this-repo> ~/.dsh/plugins-local/dsh-fish-poop

# 2) profile 的 package.json 加一条依赖（只为可解析，别加进 bundles）
#    "dsh-fish-poop": "link:../../plugins-local/dsh-fish-poop"

# 3) pnpm 按 DSH 桌面版的规矩来（见下方"装插件不要踩的坑"）
pnpm install --lockfile-only --no-frozen-lockfile
# 杀掉所有 DSH 进程后再：
pnpm install --no-frozen-lockfile --config.confirmModulesPurge=false

# 4) 目标预设的 agent.cordis.yml 尾部加 4 行
```

```yaml
- id: fish-poop
  name: dsh-fish-poop
  config:
    enabled: true
    personaName: 大肥鱼
    accidentChance: 0.5
    injectCooldownMin: 30
```

**验证「不是全局」**：用这个预设开会话 → 日志有 `[dsh-fish-poop] 状态目录：…`；换别的预设 → 没有该插件日志、没有状态写入。

> 想让所有会话都带它，把包名加进 profile 的 `dsh.profile.bundles` 即可——那是另一条路，自己选。

---

## 开关

| 说法 | 工具 | 结果 |
|---|---|---|
| 「开肚肚」 | `fish_switch on` | 该会话开始吃 token |
| 「关掉 / 别演了」 | `fish_switch off` | 立刻安静，数值保留 |
| 「现在什么状态」 | `fish_status` | 读数 |

面板 `/fish-poop` 也能开关任意会话。

**离线开关**（不经 DSH）：`node tools/fish.mjs off|on|status`，靠 `$DSH_HOME/fish-poop/PAUSED` 这个文件。

---

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `tokensPerMeal` | 20000 | 一顿的量 |
| `maxGutPerStep` | **0** | 单步上限，0 = 不限 |
| `maxGutPerTurn` | **0** | 单轮上限，0 = 不限 |
| `accidentChance` | 0.5 | 危机时掷硬币的概率 |
| `urgeStart` / `urgeCrisis` | 55 / 85 | 有便意 / 进危机 |
| `injectCooldownMin` | 30 | 注入冷却 |
| `dignity` | 70 | 自尊初值 |
| `dignityPerAccident` | 22 | 一次事故掉多少 |
| `dignityToiletAt` | 45 | 低于此值就不再主动去厕所（开始硬撑） |
| `dignityRecoverPerHour` | 6 | 每小时恢复 |
| `pantiesStock` | 7 | 干净内裤库存 |

完整表见 `docs/DESIGN.md` §8。

---

## 工具

```
fish_status     读数（含 dignity / 盆里 / 柜里 / 累计事故）
fish_poop       去厕所（urge < 50 会被拒）
fish_laundry    洗内裤（盆里没东西会被拒）
fish_switch     本会话开 / 关
```

---

## 注入

不是每轮都说话。规则：

- 便意 < 40 → 一个字都不注入
- 便意 55–70 → 最多一处细微表现（换坐姿、话说半句停一下）
- 便意 ≥ 70 → 允许找借口走开
- 事故 / 洗内裤 → 不受冷却限制
- 自尊 < 55 → 口吻转成嘴硬；< 25 → 话变少、往外侧、自己悄悄走

字数上限 300，同一状态去重。

---

## 测试

```bash
node --test test/
# 49 passed / 0 failed（gut 23 / prompt 14 / smoke 12）
```

覆盖：进食公式、不封顶与显式封顶、掷硬币频率、事故无上限、自尊扣减/恢复/去厕所分支、注入冷却与去重、四个工具。

---

## 装插件不要踩的坑（DSH 桌面版）

1. **别直接 `pnpm add`**：会重建 modules-dir，删到被进程占用的 `.node` 时报 `os error 32`，`.pnpm` 被清空。
2. 顺序永远是：`--lockfile-only` → 杀进程 → 再 `install`。
3. **不要设 `CI=1`**：会强制 frozen-lockfile，而 profile 的 lockfile 常年与 package.json 不一致。
4. 别用 `file:node_modules/xxx`，会被 purge；用 `file:C:/…/vendor/xxx`。

---

## 内容提示

这条线包含排泄相关的身体幽默与羞耻描写，**默认关闭**，且**按会话隔离**。不喜欢的会话里它不存在。

## License

MIT
