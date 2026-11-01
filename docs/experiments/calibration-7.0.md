# v7.0.0 Phase 0：参照集分位标定表

> **这是标定记录，不是接口文档。** 数值来自本机书库（`novels/` 下 3 本书、7 个可测章，其中 1 章 11,841 字、其余 6 章 100~379 字），
> 目的是给「症状判定」一个**有出处的相对尺子**，而不是给全站定死常数。
>
> **重要结论：绝对硬帽（`ABSOLUTE_SYMPTOM_CAPS`）在 v7.0.0 里保持关闭（`null`）。**
> 六审在真实书库上实测过：拍脑袋的常数要么永不触发（差 3~7 倍）、要么近一半误报。
> 因此症状判定**只用参照集分位**（p10 / p95），不用全局常数；`refStats` 为 `null` 时相对类症状一律不报。

## 测量口径

| 指标 | 来源 | 说明 |
| --- | --- | --- |
| `actionVerbsPer1000` | `lib/analysis.js` `densityOf` | **已去噪**（v7.0.0 上下文豁免层），全仓库唯一动作口径 |
| `objectNounsPer1000` | 同上 | 同上 |
| `sensePer1000` / 五通道 | 同上 | 同上；通道值是**次数**（不是千字密度），与 `chapter-diagnose` 的判定口径一致 |
| `abstractDensity` | `lib/style-metrics.js` `measureStyleMetrics` | 六维口径，**v7.0.0 未改动** |
| `bareDialogueRun` | `lib/chapter-diagnose.js` `maxBareDialogueRun` | 最长连续"裸台词段"游程 |

## 实测分位（7 章合并）

| 指标 | p10 | p50 | p85 | p95 |
| --- | --- | --- | --- | --- |
| `actionVerbsPer1000` | 24.2 | 29.0 | 39.7 | 50.0 |
| `objectNounsPer1000` | 18.5 | 32.3 | 34.3 | 39.5 |
| `sensePer1000` | 32.3 | 34.3 | 39.7 | 40.0 |
| `abstractDensity` | 0 | 3.73 | 7.41 | 11.51 |
| `sense.visual`（次数） | 2 | 6 | 8 | 97 |
| `sense.auditory`（次数） | 1 | 2 | 5 | 73 |
| `sense.tactile`（次数） | 0 | 0 | 1 | 65 |
| `sense.olfactory`（次数） | 0 | 1 | 3 | 22 |
| `sense.temperature`（次数） | 0 | 0 | 3 | 22 |
| `bareDialogueRun` | — | 1 | — | 8（max 8） |

## 用法与边界

1. **每次开写包现算**：`brief` 在装配时用当次参照集（默认全书、自定义时用勾选章）实时统计，不落盘、不复用旧表——
   这本书自己的分位才有意义，跨书套用就是又一次"拿词表当文本"。
2. **自定义参照集时**：诊断集只看目标章之前最近 1~3 章，且剔掉被勾成标杆的原著章（"要像它" 不等于 "它有病"）。
3. **已知局限**：样本仅 7 章且多为短章，`sense.*` 的 p95 被 11,841 字那一章拉高（长章命中次数天然更多）。
   所以 `sense_mono` 判定额外要求"该通道全章命中 ≤ 1 次"，避免拿长章的长处去判短章。
4. **修改本表的前提**：必须同时更新 `test/reference-set-test.mjs` 与 `test/chapter-diagnose-test.mjs` 的锁定断言，
   **不允许只改文档**。

## 复现方式

标定脚本不随包分发（属开发工具）。复现步骤：对每本书的每个可测章（正文 ≥ 40 字）分别跑
`densityOf` / `measureStyleMetrics` / `maxBareDialogueRun`，把结果喂给 `core.buildReferenceStats` 取分位。
脚本与本次记录见仓库外 `_cache/calibrate-7.mjs`（本机路径，不对外）。