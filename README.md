# dsh-novel-writer — 小说写作助手插件（v0.5.0 合并版）

DSH（DeepSeek Harness）小说写作助手 bundle 插件。宿主端零第三方依赖（仅 Node 内置模块），
浏览器端仅依赖 Web GUI 自带的 react。
**v0.5.0 = v0.3.0（深度句式分析 + 侧边栏开关）与 v0.4.0（批量导入 + 设置页卡片）的合并版**。

## 功能

1. **章节库**：章节存于 `novels/<书名>/第N章.md`（或 `.txt`/`.markdown`），
   `novel_books` / `novel_chapters` / `novel_read` 浏览与读取。
   章号任意位置 + 中文数字识别；UTF-8 / UTF-16 LE/BE / GBK 编码自动探测。
2. **分析**：`novel_keywords` 提取全书/单章高频关键词（中文二字词组 + 英文词）。
3. **句式模式分析**：`novel_sentence_analysis` 对全书/单章输出——
   - 九类句式：陈述 / 环境 / 心理 / 对话 / 疑问 / 反问 / 感叹 / 祈使 / 省略留白（比例、句数、均长、例句）；
   - 排列规律：句式转移、2/3 连句高频模板、段首/段尾句式、**按章节的压缩节奏序列**（S×8 ENV×2 PSY×3…）；
   - 句长节奏：均值/中位数、短句/长句占比；
   - 主观情感：情感词典（喜/怒/哀/惧/惊）+ 强度副词加权 → 主导情绪、情绪分布、情感曲线、主观性指数；
   - 风格指纹 + 给模型的**节奏建议**（guidance）。
   ⚠️ 风险约束：句式模式是"参考节奏"而非"模板套用"，模型在机械复刻导致僵硬时会优先回归自然表达。
4. **原稿件批量导入**：`novel_import` 扫描存放多本小说的文件夹（支持子文件夹、多编码、任意位置章号），
   从文件名与文件头双通道提取书名候选并分组（scan 预览），AI 确认后一键复制/移动到 `novels/<书名>/`（apply）；
   支持 `book` 强制归并异名同书、`files` 精确指定、`move` 移动模式。
5. **续写**：先读后写、保持文风与伏笔一致，`novel_new_chapter` 创建新章节文件。

## 提供的工具

| 工具 | 说明 |
|---|---|
| `novel_books` | 列出章节库全部作品 |
| `novel_chapters` | 列出某作品章节清单 |
| `novel_read` | 阅读某章正文（offset/limit 分段） |
| `novel_keywords` | 提取高频关键词 |
| `novel_new_chapter` | 创建新章节文件 |
| `novel_import` | **原稿件批量导入/自动分类（v0.4.0）** |
| `novel_sentence_analysis` | **句式模式分析（v0.3.0 深度 + v0.4.0 节奏）** |
| `novel_sentence_config` | 查看/修改句式分析开关 |

## UI 开关（统一在一处）

- **唯一开关位置：侧边栏「句式分析」面板**——状态横幅 + **总开关「启用句式分析」**（enabled）+ 子开关「分析作品时自动使用」（autoAnalyze）；
- **设置 > 插件配置** 的 novel-writer 卡片仅**显示状态**（已启用/已关闭、自动分析开/关），并提供「打开开关面板」按钮跳转；
- 也可让 AI 用 `novel_sentence_config` 查看/修改。
- 状态写入 `~/.dsh/dsh-novel-writer/state.json`；同时**只读兼容** v0.4.0 的 `~/.dsh/novel-writer.json`（stylePattern）与 config.stylePattern。
- 开关默认**开启**；宿主端路由 `/api/dsh-novel-writer/state`（loopback 围栏 + 可选注入，headless 自动跳过）。

## 安装（web profile）

```sh
dsh plugin --profile web add D:/tools/dsh-novel-writer
```

或手动：把本文件夹放入 profile 的 `node_modules`，并在 profile `package.json` 的
`dsh.profile.bundles` 中加入 `dsh-novel-writer`。安装后**重启 web 应用**生效。

## 配置

```yaml
- id: novel-writer
  config:
    root: 'D:/我的小说库'
    sentenceAnalysis:
      enabled: true
      autoAnalyze: true
    # stylePattern: true   # v0.4.0 兼容写法（任一生效即开启）
```

## 版本记录

### v0.5.0（合并版）
- 合并 v0.3.0 与 v0.4.0：九类句式（新增"环境"）、章节压缩节奏序列、guidance 节奏建议、采样上限；
- 新增 novel_import 批量导入（v0.4.0）；开关同时出现在侧边栏面板与官方设置页；
- 路由改可选注入 ctx.inject(["webServer"])，headless 兼容；保留 loopback 围栏；
- 兼容读取 v0.4.0 的 novel-writer.json / config.stylePattern；提示词内置"僵硬时优先自然表达"约束。

### v0.4.0（他人改版，已并入）
- novel_import 批量导入自动分类；novel_style_pattern 轻量句式分析（环境类/压缩序列/guidance）；
- 官方设置页插件配置卡片；ctx.inject 可选注入；开关默认关闭 + 风险提示。

### v0.3.0（本系列）
- 句式模式分析深度版（情感曲线/句长/段落/指纹）；侧边栏开关面板；state 路由。

### v0.2.0 / v0.1.0
- 章节库、关键词、新建章节；编码探测。
