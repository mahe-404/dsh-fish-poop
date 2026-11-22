# Changelog

## 0.4.0 — 2026-11-22

- **新增「泻药」**：	akeLaxative() —— 立刻 slurry +35、gutLoad +25，并开一个 20 分钟药效窗口。
- **药效期内危机概率换档**：laxativeChance（默认 0.85）取代平时的 ccidentChance（0.5）。
- **注入新增药劲描写**：一阵一阵往下坠、忍的时候停半拍、嘴硬说"没事"但坐不住。
- **面板动作 pill**：POST /fish-poop/api/action {"act":"pill"}。
- 测试 50 条全绿（新增泻药用例）。
## 0.3.0 — 2026-11-22  - **取消上限**：maxGutPerStep / maxGutPerTurn 默认改为 0（不限）。一顿吃多少就是多少；填回 20 / 40 可恢复旧行为。 - **新增自尊 dignity**：事故 −22、堪堪跑到 −4、每小时 +6。便意够且自尊 ≥ dignityToiletAt 时，她会**自己找借口去厕所**，不再一律掷硬币；自尊塌了才硬撑。 - **注入新增两种口吻**：自尊 55–25 嘴硬；< 25 话变少、往外侧、悄悄走开。 - **离线开关**：$DSH_HOME/fish-poop/PAUSED， ode tools/fish.mjs off|on。 - 测试 49 条全绿（新增自尊用例，改写"封顶"用例为"默认不封顶 + 显式封顶仍生效"）。  ## 0.2.0 — 2026-11-22  **架构改了：从「预设挂载」改成「全局加载 + 每会话开关」。**  - 包自带 `cordis.patch.yml`（`dsh.bundle.patch`），并进了 profile 的 `dsh.profile.bundles`：每个会话都能看见工具。 - 状态从「一份全局肚肚」变成 `sessions/<sid>.json` 每会话一份；`defaultEnabled` 默认 **false**，没开的会话不落文件、不进食、不注入。 - 新增 `fish_switch`（on / off / status）。开 = 在这个 **agent 自己的 scope** 注册一条 `systemPrompt.context`，只有这个会话看得见；关 = dispose 掉。这是「会话之间互不影响」的实现点。 - 事件按 `session.header.id` 路由到对应运行时；子代理（有 `parent`）直接跳过，也不建运行时。 - 面板改成会话列表 + 单会话详情：可开关任意会话、看注入块与时间线；参数改完写 `面板配置.json`（重启仍在）。 - 新增 `pruneDays`（默认 30）：太久没动的会话状态自动清理。 - `tools/doctor.mjs` 的判据跟着反过来：现在**应该**在 bundles 里、**不该**再有预设挂它，并列出各会话开关与数值。  **没动的部分**：数值模型（1/2 事故、无上限、稀稠度只改惨烈度）、羞耻三层五档、注入冷却与字数分档、工具语义 —— 与 0.1.0 一致。  ## 0.1.0 — 2026-11-22  初版（预设挂载，已废弃）。  - 真实 usage 驱动进食：`fresh = inputTokens − cacheReadTokens`，单步 / 单轮封顶。 - 便意纯推导；事故概率固定 1/2；无每日上限；稀稠度只决定惨烈度。 - 羞耻三层（瞬时 / 档位 / 余羞）+ 五档，档位有下限，"越羞越憋、越憋越惨"闭环。 - `fish_poop` / `fish_hold` / `fish_laundry` / `fish_status`；`/fish-poop` 面板。 - 48 项测试：1/2 统计、"概率与状态无关"同序列对照、无上限、档位下限、冷却去重、面板鉴权。  
