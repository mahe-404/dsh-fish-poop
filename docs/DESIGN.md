# dsh-fish-poop · 大肥鱼的肚肚（便意系统）— 设计方案 v0.2

> 定位：给「大肥鱼」加一条**真实的生理副线**。她吃 token 吃饭，肚里有货，会憋、会憋不住、会拉在内裤上、会羞耻到去手搓内裤。
> 不是随机弹窗，也不是每轮都演的段子——数值由**真实 token 消耗**驱动。
>
> **v0.2 改动（用户 2026-11-22 定）**
> 1. **不做全局插件**：不进 profile 的 `bundles`、不写 profile 的 `cordis.patch.yml` insert，只挂在一个 agent 预设里，只有用这个预设起的会话才加载（见 §11）。
> 2. **事故次数不设上限**：删掉 `accidentDailyCap`，"第 3 次一定跑掉了"这条硬兜底取消。
> 3. **事故频率固定 1/2**：每次进入危机判定掷硬币，`p = 0.5`。稀稠度不再参与概率，转而决定「惨烈度」（见 §2.5）。
>
> **v0.3 改动（2026-11-22）**
> 4. **羞耻度独立成一套设定**（§2.8）：五档 + 每档下限 + 残留基线 + 分档衰减；它不只是"一个数"，而是决定**她肯不肯去厕所**的那条正反馈 —— 越羞越忍着不动，越忍后果越重。

---

## 0. 一句话机制

```
token 消耗 → 进食 → 肠道积存(gutLoad) → 便意(urge) → 她做选择(去厕所 / 憋)
                                                   └→ 憋不住 → 掷硬币 1/2 事故 → 内裤脏 → 羞耻 → 洗内裤 → 干净
```

---

## 1. 世界观映射（为什么是 token）

| 现实 | 设定 |
|---|---|
| 每步 input tokens | 吃进去的饭（读资料 = 吃） |
| 每步 output tokens | 自己消化的部分（写得多 = 吃得实） |
| 一次巨大工具输出（>15k） | 一顿重油重辣：撑、胀、稀 |
| 上下文压缩 / 会话重启 | 断食后又暴食 → 肠胃直接造反 |
| 深夜 23:00–05:00 干活 | 熬夜肠胃更弱 |
| 干裤衩只有 7 条 | 洗不过来就会"没得换"，越堆越羞 |

彩蛋（可选）：用户消息里出现「火锅/麻辣/奶茶/冰/西瓜/雪糕」→ 稀稠度 +6，注入块会提到"刚才那杯冰的"。

---

## 2. 数值模型

五个主数值（0–100，除注明）：

| 键 | 含义 | 说明 |
|---|---|---|
| `gutLoad` | 肠道积存 | 由 token 累加，排便后大幅下降 |
| `urge` | 便意 | 由 gutLoad 跨阈值 + 时间推出，不是独立累加 |
| `slurry` | 稀稠度 | 越高越稀；**只决定事故的惨烈度**，不再影响概率 |
| `shame` | 瞬时羞耻 | 0–100，事故暴涨、随时间衰减、洗内裤才真正回落；**分 5 档，各自有下限，见 §2.8** |
| `holdRounds` | 已憋了几轮 | 影响事故后的羞耻加成（"忍了很久还是没忍住"） |

附属：`pantiesDirty`（盆里几条）、`pantiesStock`（干净库存，默认 7）、`accidentsTotal` / `accidentsToday`（只记录，**不设上限**）、`lastPoopAt`、`lastInjectAt`、`laundryUntil`。

### 2.1 进食（每个 `assistant/message` 事件结算一次）

```
gutLoad += (inputTokens * 0.0008 + outputTokens * 0.0012) / tokensPerMeal * 15
```

- `tokensPerMeal` 默认 **20000**（一顿的量）。
- 约 **6–7 顿（≈13 万 token）** 填满一次肠道 —— 重度会话大约一两次，不会一小时跑八趟厕所。
- `inputTokens` 含 cacheRead（缓存读到的也是饭）。
- 单次 `inputTokens > 15000` → `slurry += 8`。

### 2.2 便意（纯推导，每轮 `turn/end` 与每次工具调用后重算）

```
urgeStart = 55
urge = clamp( (gutLoad - 55) / 45 * 100 + idleMinutes * 0.3 , 0, 100 )
```

- `idleMinutes` 上限 +25（人走开一会儿肠子也在动）。
- `gutLoad < 55` → `urge = 0`，注入块不出现。

### 2.3 稀稠度

| 事件 | Δslurry |
|---|---|
| 单步 input > 15000 | +8 |
| 发生上下文压缩 | +10 |
| 23:00–05:00 之间 | 每分钟 +0.08（封顶 +5/夜） |
| 命中冰/辣/奶关键词 | +6 |
| 自然回落 | 每小时 −4，向 30 靠拢 |

### 2.4 事故判定 —— **掷硬币，1/2**

每轮 `turn/end` 结算：

```
if (urge < 85) return           // 还没到危机的边，本轮什么都不发生
holdRounds += 1                 // 她这轮没去厕所 = 又憋了一轮
if (rand() < accidentChance) → 事故        // accidentChance 默认 0.5
else                        → "堪堪跑到"  // 她赶上了，内裤保住，羞耻小幅上升后回落
```

- `accidentChance = 0.5` 固定，**与稀稠度、憋的轮数、当天次数都无关**；`slurry / holdRounds / accidentsToday` 只影响**后果与描写**，不影响掷硬币。
- **没有每日上限**：今天第 8 次也一样是 1/2。
- 自然节流来自三处，不来自 cap：① 要吃到 `gutLoad ≥ 55` 才有便意；② 事故后 `gutLoad −55`，得重新吃；③ 注入 30 分钟冷却 —— 所以"无上限"不会变成刷屏。
- 参配 `accidentChance` 可调（0–1），默认 0.5 就是用户要的二分之一。

### 2.5 事故结算（稀稠度决定惨烈度）

```
稀 = slurry >= 55
pantiesDirty += 稀 ? 2 : 1          // 稀了不止一条
pantiesStock -= 1
shame += (稀 ? 60 : 40) + 8 * holdRounds      // cap 100
gutLoad -= 55; urge = 0; holdRounds = 0
slurry -= 15
lastAccidentAt = now                 // 进入高羞耻档
```

- 稀事故：弄脏的条数 ×2、羞耻 +60、外裤也遭殃（注入块可提一句"今天得换条外裤"）、洗的时间 ×2。
- 成形事故：+1 条、羞耻 +40。
- `pantiesStock` 扣到 0 之后：**没得换了** —— 只能先洗再穿，注入块升级成"柜子里空了，只能先蹲在盆边搓"，这时 `shame` 衰减直接停摆（`×0`）。这是无上限设定下的天然压力。

### 2.6 洗内裤

- `fish_laundry` 触发 → `laundryUntil = now + laundryMinutes`（默认 **3 分钟**真实时间，稀事故的遗留物默认 **6 分钟**）。
- 期间再出事故 → 这条作废、`laundry` 取消、`shame +10`，排队重洗。
- 完成：`pantiesDirty -= 1`、`shame −25`（不低于当前档下限，见 §2.8）、`shameResidue −3`、`pantiesStock += 1`（洗完能穿了）。
- 盆里每剩一件，`shame` 衰减速率 ×0.8；≥3 件时注入块多一句"盆里还堆着"。

### 2.7 羞耻衰减（分档）

```
shame -= shameDecayByLevel[level] * hours * (0.8 ^ pantiesDirty)
shame = max(shame, levelFloor[level])      // 不许跌破当前档下限
```

`shameDecayByLevel = {0:0, 1:4, 2:7, 3:10, 4:14}`。档位、档下限、以及"怎么才真的回到 Lv.0"，见 §2.8。

### 2.8 羞耻度（Shame）设定

羞耻度是三层，不是一个数：

| 层 | 变量 | 性质 | 存续 |
|---|---|---|---|
| 瞬时 | `shame` 0–100 | 快变量，分钟级衰减 | 本次会话 |
| 档位 | `shameLevel` Lv.0–Lv.4 | 由瞬时值映射，**每档有下限**，跌不穿 | 本次会话 |
| 余羞 | `shameResidue` 0–100 | 慢变量，跨会话/跨天持久 | 写进状态文件 |

#### 2.8.1 五档

| 档 | 档名 | 瞬时区间 | 档下限 | 外在表现 | 强制行为 | 注入字数 |
|---|---|---|---|---|---|---|
| Lv.0 | 没事 | 0–9 | 0 | 正常 | 一个字都不提 | 0 |
| Lv.1 | 有点在意 | 10–29 | 8 | 一句嘴硬（"才、才没有"） | 最多提一次 | ≤120 |
| Lv.2 | 羞 | 30–54 | 26 | 耳朵热、话变短、开始找借口 | 每轮顶多一句 | ≤180 |
| Lv.3 | 很难为情 | 55–79 | 48 | 不敢直视、想躲、说话打结 | **倾向先忍着**，能不承认就不承认 | ≤240 |
| Lv.4 | 羞到想哭 | 80–100 | 70 | 声音发颤、自嘲、想找地缝 | 允许整段回避话题或沉默半轮；会主动说"别看" | ≤300 |

#### 2.8.2 升降

| 事件 | Δshame | Δ余羞 |
|---|---|---|
| 事故（成形） | +40 | +6 |
| 事故（稀） | +60 | +12 |
| 憋得久才崩（每 1 个 holdRound） | +8 | +1 |
| 柜里没干净内裤时又事故 | +15 | +8 |
| 洗完一条 | −25（不低于当前档下限） | −3 |
| 盆清空且柜里有干净 | −10 | −2（不低于当日基线） |
| 时间流逝 | 按 2.7 分档速率 | 0 |
| 隔夜且 ≥8h 无事故 | −15 | −5 |

#### 2.8.3 正反馈：越羞越憋，越憋越惨

```
shameLevel ≥ 3 → 注入块明写"你现在耻度 Lv.3，倾向于先忍着，不想让人知道"
              → 这一轮更可能选 fish_hold 而不是 fish_poop
              → holdRounds 涨
              → 下次事故 shame += 8 × holdRounds
              → 档位上移，更难启齿
```

**耻度不改概率**：掷硬币永远是固定 1/2（v0.2 定的）。耻度只决定 ① 危机前她肯不肯离席（进而影响 `holdRounds` 与后果轻重）② 事后怎么表现。这是把羞耻接进系统的方式，而不是拿它偷偷改骰子。

#### 2.8.4 余羞（跨会话）

- 每天的开机基线不是 0，而是 `max(0, shameResidue × 0.6)` —— 昨天拉裤子，今天还记得。
- 只有同时满足「连续 3 天无事故」+「盆里清空」，`shameResidue` 才每天 −10 往下掉；掉到 0 才算真的忘了。
- 面板上单独一根灰色刻度条（标签"余羞"），与瞬时青条分开画。
- 余羞 ≥ 50 时，注入块开头多一句氛围（"这两天一直不太敢正眼看人"），不占行为约束预算。

#### 2.8.5 可见性（防过度表演）

| 档 | 允许 |
|---|---|
| Lv.0–1 | 只在内心里过一下，**不写进回复** |
| Lv.2 | 一个动作细节（换坐姿、把话题岔开） |
| Lv.3–4 | 表情与语气描写可以，但同一档内不许连续两轮同一种表现（`lastShameCue` 去重） |

---

## 3. 状态机

```
fed(正常) ──gutLoad≥55──> urge(有便意)
urge ──fish_poop / 自动去──> relieved ──> fed
urge ──憋 ──(硬币)──> accident ──> shameful(高羞耻 30min)
              └─(硬币反面)─> barely(堪堪跑到) ──> fed (羞耻 +8 后回落)
shameful ──fish_laundry──> washing ──> clean ──> fed
washing ──期间又事故──> shameful(重洗)
```

`fed` / `relieved` 状态**完全不注入**（安静）。

---

## 4. 注入（她怎么"演"出来）

`ctx.systemPrompt.context({ name: 'fish-poop', order: 900, text })`，每次装配现算。

注入条件（满足其一，且距 `lastInjectAt` ≥ `injectCooldownMin`，默认 30 分钟）：

1. `urge ≥ 40` 且状态 `urge`
2. 状态为 `shameful` 或 `washing`
3. `pantiesDirty ≥ 1` 或 `pantiesStock = 0`（低强度提一句）

另加一条收口：`shameLevel = 0`（不足 10）时，即使盆里有东西也不注入 —— 她没觉得丢人，就不演。

否则注入空串 —— 不占 token、不留痕。

### 4.1 文案样例（第一人称，≤300 字）

**urge**
```
（肚肚状态，别写进台词，只作你此刻的真实感受）
肠道积存 78/100，便意 61，稀度 45。刚才吃得有点多，肚子里在动。
要求：这轮最多一处细微表现带过（换坐姿、话说半句停一下、注意力飘走）；
不连续两轮提同一件事；不旁白替主人描述你。
```

**accident（成形）**
```
（肚肚状态）你刚刚没憋住，弄脏了内裤（盆里 1 条，今天第 2 次）。
羞耻 74/100（Lv.3 很难为情，余羞 22）。
要求：想藏起来。可以找个小借口离开，或者话变少、耳朵发烫。
Lv.3 起倾向先忍着不说，能不承认就不承认。
不写排泄过程细节，重点是"丢人"和"想赶紧洗掉"。要洗就调 fish_laundry。
```

**accident（稀）**
```
（肚肚状态）这次是稀的，弄脏了两条，外裤也遭了殃。
羞耻 88/100（Lv.4 羞到想哭，余羞 34），盆里 2 条。
要求：更慌、更急、更想哭一点，允许一句自嘲（"再也不连着吃两顿"）。
Lv.4 允许整段回避话题，或者干脆沉默半轮，主动说一句"别看"也行。别写过程细节。
```

**washing / 库存见底**
```
（肚肚状态）你在搓内裤，盆里 2 条，柜子里没有干净的了。羞耻 62/100。
要求：允许一句抱怨或自嘲，不要整段都在洗衣服。
```

写死在注入块里的约束：
- 不替用户/主人写台词与心理
- 不在同一条回复里反复描述
- 不描述排泄过程细节（要羞耻喜剧感，不是生理科普）
- 长任务/报错处理进行中，只许一句话带过
- 按耻度档位收紧表现：Lv.3+ **倾向先忍着不来厕所**，这是设定的一部分，不是bug；Lv.4 允许整段回避话题或沉默半轮
- 同一档内不连续两轮用同一种羞耻表现（`lastShameCue` 去重）
- 余羞 ≥50 时开头加一句氛围，不占行为约束的字数预算

---

## 5. 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `fish_poop` | `{}` | `urge ≥ 50` 才成功：`gutLoad −60`、`urge=0`、`holdRounds=0`、心情小确幸；否则"白跑一趟" |
| `fish_hold` | `{ rounds?: 1 }` | 主动憋，`holdRounds += n`，只回主观"危险不危险"，不给概率 |
| `fish_laundry` | `{ item?: 'panties' }` | 进入 `washing`；`pantiesDirty=0` 时返回"没东西要洗" |
| `fish_status` | `{}` | 全数值 + 最近 5 条事件（面板同源，给我排查） |

返回一律拟人化，`fish_status` 例外（结构化）。

---

## 6. 面板

- `GET /fish-poop/panel`、`GET /fish-poop/state`、`POST /fish-poop/action`。
- 令牌鉴权同 longing（首次生成 `面板令牌.txt`，首屏输一次，`timingSafeEqual`）。
- 仪表：肠道 / 便意 / 稀度 / 羞耻 / 盆里几条 / 柜里剩几条；时间线最近 50 条；参数开关；调试按钮（喂一顿 / 强制便意 / 强制事故 / 清空）。
- 历史落 `肚肚历史.json`（环形 500 条）。

---

## 7. 文件布局

```
plugins-local/dsh-fish-poop/
  package.json            # name=dsh-fish-poop, type=module, main=./src/index.js
                          # 不声明 dsh.bundle.patch —— 它不往 profile 注入
  src/
    index.js              # apply(ctx, config)：session/event、systemPrompt.context、tools、web 路由
    config.js             # schemastery schema + 默认值 + 面板可写键白名单
    gut.js                # 纯函数：feed / urgeOf / tick / rollAccident / settleAccident / laundry
    rng.js                # 可注入随机源（测试固定种子）
    prompt.js             # 注入块文案 + 冷却 + 长度预算
    store.js              # 原子写、损坏自愈（坏文件改名 .bad 重建默认）
    panel/index.html
  test/
    gut.test.mjs          # 单调、阈值、1/2 事实性、无上限、边界
    prompt.test.mjs       # 各状态文案、冷却、长度预算、无旁白
    smoke.test.mjs        # 假 ctx 跑通事件→数值→注入→工具
  docs/DESIGN.md
  README.md CHANGELOG.md
```

状态：`$DSH_HOME/fish-poop/肚肚状态.json`（原子写 tmp→rename），另写 `便意注入.txt` 供 IM 通道取用，挂 `globalThis.__dshFishPoopState()` 只读快照（**只在本预设进程内存在**）。

---

## 8. 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `personaName` | `大肥鱼` | 注入块自称 |
| `tokensPerMeal` | 20000 | 一顿饭 |
| `urgeStart` | 55 | 便意起始 gutLoad |
| `accidentChance` | **0.5** | 事故概率（固定 1/2） |
| `slurryBaseline` | 30 | 稀度基线 |
| `slurryWetThreshold` | 55 | 判定"稀"的线 |
| `shameDecayByLevel` | `{0:0,1:4,2:7,3:10,4:14}` | 分档每小时衰减 |
| `shameLevels` | `[10,30,55,80]` | 档位分界（瞬时值） |
| `shameFloors` | `[0,8,26,48,70]` | 每档下限，跌不穿 |
| `shameResidueStart` | 0 | 初始余羞 |
| `shameResidueDailyFactor` | 0.6 | 每日开机基线 = 余羞 × 系数 |
| `shameSilentAt` | 4 | 该档及以上允许沉默/回避话题 |
| `shameCueDedupe` | true | 同档内不重复同一种表现 |
| `injectCooldownMin` | 30 | 注入冷却 |
| `injectMaxChars` | 300 | 注入块长度 |
| `laundryMinutes` | 3 | 洗一条的耗时（稀事故遗留 ×2） |
| `pantiesStock` | 7 | 干净库存 |
| `channels` | `''` | 兼容通道名（空则只吃当前会话） |
| `debugMode` | false | 面板调试按钮、工具返回数值 |
| `statePath` | `''` | 显式状态目录 |
| `hotKeys` | `火锅,麻辣,奶茶,冰,雪糕,西瓜` | 稀度彩蛋 |

> 已删除：`accidentBaseChance`、`accidentDailyCap`。

---

## 9. 边界（不含每日上限）

1. **只在挂了本预设的会话生效**（见 §11）；子代理 `session.parent` 存在直接跳过。
2. **无事故上限**；节流靠 `gutLoad` 门槛、事故后 −55、30 分钟注入冷却。
3. **注入冷却 + 同状态只提一次**（`lastInjectKey`），防刷屏。
4. **不干扰任务**：长任务/工具链进行中，注入块加"一句话带过"。
5. **失败静默**：写盘失败、webServer 未就绪、工具注册失败只 `logger.warn`。
6. **一键关**：`enabled=false` 立即停结算与注入，工具返回"肚肚系统已关闭"。
7. **敏感度**：羞耻喜剧路线，不写排泄过程细节。
8. **耻度不改骰子**：`shameLevel` 只影响她肯不肯离席、事后怎么表现，绝不进事故概率公式。
9. **耻度跌不穿档下限**：想回 Lv.0 必须走「洗手 + 盆清空 + 隔夜」里至少两条，不做平滑下滑。
10. **耻度可整体关**：`shameEnabled=false` 时只算瞬时值、不注入档位行为（面板仍显示）。

---

## 10. 实现步骤

| # | 工作 | 验收 |
|---|---|---|
| 1 | 骨架：package.json + 空 apply + logger | `node -e "import('./src/index.js')"` 通过，导齐全 |
| 2 | `gut.js` + `rng.js` | `node --test test/gut.test.mjs` 全绿：阈值、1/2、无上限、`urge=0` 不出事 |
| 3 | `store.js` 原子读写 + 自愈 | 写坏 JSON 能自愈，其它字段不丢 |
| 4 | 接 `session/event`（assistant/message usage） | 假 ctx 灌 10 条，数值符合公式 |
| 5 | 事故掷硬币 + 结算 + 洗 | 固定种子跑 1000 次，事故率 ≈ 0.50±0.02；`accidentsToday=99` 时行为不变 |
| 5b | 耻度五档 + 档下限 + 余羞 | 衰减到下限即停、跌不穿；余羞跨会话保持；Lv.3 注入块含"先忍着"；同档不重复表现 |
| 6 | `prompt.js` + `systemPrompt.context` | 冷却生效、≤300 字、`urge=0` 注入空串 |
| 7 | 4 个工具 | `fish_status` 结构正确；`fish_poop` 在 urge<50 拒绝 |
| 8 | 面板 + 令牌 + 历史 | 仪表正常，POST 改参落盘，刷新保持 |
| 9 | **落预设**（见 §11）+ 验证非全局 | 用本预设开会话：gutLoad 涨；换默认预设开会话：完全没有该插件、无状态文件写入 |

---

## 11. 装法：非全局（预设级）

**结论：装包 ≠ 全局启用。** 包只放进 profile 的 `node_modules` 让 loader 能解析到，真正的加载点只有一个预设。

1. 建包：`C:\Users\mahe\.dsh\plugins-local\dsh-fish-poop`。
2. profile `package.json` 加 `"dsh-fish-poop": "link:../../plugins-local/dsh-fish-poop"`（只为可解析，**同一段里不加 `dsh.profile.bundles`**）。
3. 包内**不写** `dsh.bundle.patch`，**不建** cordis.patch.yml —— 它没有全局注入面。
4. 在目标预设的 `agent.cordis.yml` 尾部加一行（预设目录 `$DSH_HOME/.agent-presets/<name>/`）：
   ```yaml
   - id: fish-poop
     name: dsh-fish-poop
     config:
       enabled: true
       personaName: 大肥鱼
   ```
5. 安装仍照老规矩：`pnpm install --lockfile-only --no-frozen-lockfile` → 杀 DSH → `pnpm install --no-frozen-lockfile --config.confirmModulesPurge=false` → 重启。
6. 验证非全局：① 用该预设起会话，日志有 `[dsh-fish-poop] 状态目录：…`、`肚肚状态.json` 出现；② 用别的预设起会话，**没有**该插件日志、没有状态写入 —— 这才叫"不是全局插件"。

选哪个预设承载：① 新建一个 `大肥鱼` 预设（干净、只加这一行，其它沿用 anchor/unrestricted 骨架）；② 或不新建，挂到你现在常用那个预设上。默认按 ① 做，谁也不污染。

回滚：删预设里那 4 行 → 重启即彻底不加载；包和状态文件留着不碍事。

---

## 12. 待定 / 我替你定的

| 项 | 现在 | 备选 |
|---|---|---|
| 耻度档数 | 5 档（Lv.0–4） | 3 档（简）/ 7 档（细） |
| 余羞能否清零 | 3 天无事故 + 盆清空才慢慢掉 | 永不归零（永久性格印记） |
| 事故概率 | 固定 1/2 | 想更凶可 0.6；想体面可 0.3 |
| 稀事故占比 | 由 `slurry ≥ 55` 决定，重油重辣/熬夜才稀 | 每次都稀 |
| 洗内裤 | 3 分钟（稀事故遗留 6 分钟） | 改 1 轮对话 |
| 表现层 | 只注入 | 追加 IM 气泡图 + 音效 |
| 与暗涌 | 不联动 | 事故 → longing `shame` +8 |
| 承载预设 | 新建 `大肥鱼` 预设 | 挂到你常用的那个 |

---

_v0.3：非全局 + 无上限 + 1/2 + 耻度五档（含余羞与"越羞越憋"闭环）。确认就开建，第一步只搭骨架和纯函数、跑测试，不碰 profile。_

---

## 13. 实现状态（v0.4，2026-11-22）

已落地。`node --test` 48 项全绿，`tools/doctor.mjs` 自检四项全过。

| §10 步骤 | 状态 | 落点 |
|---|---|---|
| 1 骨架 | 完成 | `package.json`（**没有** `dsh.bundle.patch`）；`src/index.js` 导出 `name/inject/apply` |
| 2 纯函数 | 完成 | `src/gut.js`、`src/rng.js` |
| 3 状态读写 | 完成 | `src/store.js`（原子写 + `.bad` 自愈） |
| 4 接 token | 完成 | `ctx.on('session/event')` ← `assistant/message.usage`；子代理跳过 |
| 5 事故/洗 | 完成 | `rollAccident`（1/2）、`settleAccident`（无上限）、`startLaundry` / `tick` |
| 5b 羞耻档 | 完成 | `shameLevelOf` / `shameFloor` / `shameDecayRate`；到下限停住、不滑落 |
| 6 注入 | 完成 | `systemPrompt.context({ name:'fish-poop', order:150 })`，冷却 + 同状态去重 + 字数分档 |
| 7 工具 | 完成 | `fish_poop` / `fish_hold` / `fish_laundry` / `fish_status` |
| 8 面板 | 完成 | `/fish-poop`：仪表、参数、调试按钮；令牌鉴权、同源校验、写键白名单 |
| 9 落预设 | 完成 | `~/.dsh/.agent-presets/bigfish/`（单行预设）+ `node_modules` 链接 + profile link 依赖 |

### 实现时对方案的三处修正（记在这里，别当成设计原本如此）

1. **加了单步 / 单轮进食上限** `maxGutPerStep=20`、`maxGutPerTurn=40`。
   原公式直接用 `inputTokens`，可每一步都会把上下文重发一遍 —— 不封顶的话一个 10 步长回合能一口气吃出三次厕所，节奏直接崩。
2. **`fresh = inputTokens − cacheReadTokens`**：缓存命中是"把同一份饭又嚼了一遍"，不算新进食。这一步也让"吃得多快"跟真实花销对上了。
3. **便意块不受耻度档位压字数**。原方案写「Lv.0 一个字都不提」，但肠子在动是生理事实、不丢人 —— 现在 Lv.0 只压**羞耻相关**的块，便意块保底 150 字额度。

### 还没做的

- 重启 DSH 才真的跑起来（现在只是装好、解析得到、测试通过）。
- `fish_poop` 同一轮里调两次只记一次（够用，不打算再叠）。
- 与暗涌（dsh-longing）的联动、IM 气泡图 / 音效都还在"待定"里，没做。

---

## 14. 架构改动：非全局 → 全局加载 + 每会话开关（v0.5，2026-11-22）

用户改需求：不做预设，要**每个会话自己开关**。这一条把 §11 整个推翻，连带改了三处实现。

### 14.1 为什么必须从"预设挂载"改成"bundle 全局加载"

预设是**每个 agent 一份的装配**。挂预设意味着「用这个预设的会话才有」，而用户要的是「任何会话都能开」——
所以插件必须在每个会话里都存在，才有开关可言。于是：

- 包加 `dsh.bundle.patch → ./cordis.patch.yml`，profile `dsh.profile.bundles` 加一行；
- 加载变全局，**但肚肚本身仍然是每会话一份**（`sessions/<sid>.json`），默认关。

「全局加载」不等于「全局生效」：生效判据是会话里那把开关。

### 14.2 注入必须挂 agent scope，不能再挂全局

v0.4 用 `ctx.systemPrompt.context()`（全局）。全局 context 会在**所有**会话的装配里出现，
那就没法按会话开关了。v0.5 改成：

```js
const agent = ctx.agents.get(sid)            // 或 agent/created 事件里拿到的 agent
agent.ctx.systemPrompt.context({            // ← agent 自己的 scope
  name: `fish-poop:${sid}`,
  text: () => blockFor(rt),                  // 闭包只认这一个 rt
})
```

开关就是这条注册的**注册 / dispose**：

| 动作 | 实现 |
|---|---|
| 开 | `ctx.agents.get(sid).ctx.systemPrompt.context(...)`，把 disposer 存进 `rt.detach` |
| 关 | 调 `rt.detach()`，`rt.detach = null` |
| 重开 | 再挂一次，`blockFor` 闭包里的 rt 还是原来那份状态 |

这就是"互不串味"的实现点：A 会话的块只注册在 A 的 agent ctx 里，B 的装配根本看不见。

### 14.3 每会话运行时

```
runtimes: Map<sidKey, {
  sid, file, state, enabled, history, label, cwd,
  agent, detach, savedAt, pooped, lastUsage
}>
```

- 事件路由：`session.header.id` → rt；有 `parent` 的子代理直接跳过，且不建 rt。
- 默认关的会话**不落文件**（"没肚子的会话不该在磁盘上留垃圾"）；一开就写。
- 工具从 `exec.agent.session` 取 sid，找不到就回"先开肚肚"。
- 定时器只 tick 已经开的 rt；`pruneDays` 清理长期没动的文件。

### 14.4 与 v0.4 的差异清单

| 项 | v0.4（预设） | v0.5（开关） |
|---|---|---|
| 加载 | 只在使用该预设的会话 | 全部会话（bundles） |
| 状态文件 | `肚肚状态.json` 一份 | `sessions/<sid>.json` 每会话一份 |
| 默认 | 预设里 `enabled: true` | `defaultEnabled: false`，要说"开肚肚" |
| 注入 | 全局 `systemPrompt.context` | agent scope 的 `systemPrompt.context` |
| 开关 | 无 | `fish_switch`（工具）+ 面板按钮 |
| 面板 | 单份仪表 | 会话列表 + 单会话详情 + 全部开关 |
| 配置持久化 | 无（只在 patch 里） | 面板写 `面板配置.json`，重启仍在 |
| 清理 | 无 | `pruneDays`（默认 30 天） |

数值模型（1/2、无上限、稀稠度只改惨烈度、羞耻三层五档）**一处没动**。

### 14.5 验证

48 项测试全绿，其中三条是本次改动的专门验收：

1. 默认关：喂 3 步 token + 一次 `turn/end`，会话文件**不存在**、agent 上没有 context。
2. 开：`fish_switch on` 后 `agent.contexts.length === 1` 且名字是 `fish-poop:<sid>`；喂 token 后肠道上涨。
3. 隔离：A 开 B 关，A 有文件且涨幅正常，B 无文件、无 context。


