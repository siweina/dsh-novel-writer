# dsh-novel-writer — 小说写作助手插件（v0.3.0）

DSH（DeepSeek Harness）小说写作助手 bundle 插件。宿主端零第三方依赖（仅 Node 内置模块），
浏览器端仅依赖 Web GUI 自带的 react。为 AI 提供小说章节库管理、分析与续写辅助能力；
v0.3.0 新增**句式模式分析**扩展与 **Web UI 开关**。

## 功能

1. **章节库**：章节存于 `novels/<书名>/第N章.md`（或 `.txt`/`.markdown`），
   插件提供 `novel_books` / `novel_chapters` / `novel_read` 让 AI 浏览并读取每一章内容。
   章节文件名中的序号支持任意位置与多种写法，例如：
   `第01章.md`、`01-标题.md`、`原稿件-单章-…第一章.txt`、`原稿件-单章-第25章 .txt`
   （阿拉伯数字与中文数字"第一章/第十四章/第三十章"均可识别，自动按章号排序）。
   文件编码自动探测：UTF-8（含/不含 BOM）、UTF-16 LE/BE（含 BOM 或启发式识别）、GBK/GB18030（无 BOM）。
2. **分析**：`novel_keywords` 确定性提取全书/单章高频关键词（中文相邻二字词组 + 高频单字 + 英文词）。
3. **句式模式分析（v0.3.0 新增）**：`novel_sentence_analysis` 对全书/单章输出——
   - 句式分布：陈述 / 对话 / 心理 / 疑问 / 反问 / 感叹 / 祈使 / 省略留白（比例、句数、均长、例句）；
   - 排列规律：句式转移、2/3 连句高频模板、段首/段尾句式、纯对话段/纯心理段/混合段统计；
   - 句长节奏：均值/中位数、短句/长句占比；
   - 主观情感：轻量情感词典（喜/怒/哀/惧/惊）+ 强度副词加权 → 主导情绪、情绪分布、情感曲线、主观性指数；
   - 风格指纹：一维紧凑签名，方便 AI 快速比对与复刻作者的句式习惯。
4. **UI 开关（v0.3.0 新增）**：Web GUI 侧边栏出现「句式分析」入口，面板内两个开关：
   - **启用句式分析（enabled）**：控制 novel_sentence_analysis 是否可用；
   - **自动分析（autoAnalyze）**：控制 AI 分析作品时是否主动附带句式报告。
   开关实时写入宿主端 `~/.dsh/dsh-novel-writer/state.json`，与 `novel_sentence_config` 工具双向同步；
   宿主端不可达时降级保存在浏览器 localStorage。
5. **续写**：系统提示词规定续写工作流（先读后写、保持文风与伏笔一致），
   `novel_new_chapter` 创建新章节文件。

## 提供的工具

| 工具 | 说明 |
|---|---|
| `novel_books` | 列出章节库全部作品（章节数、总字数） |
| `novel_chapters` | 列出某作品章节清单（章号/标题/字数/行数/更新时间） |
| `novel_read` | 阅读某章正文（行号 + 字数统计，offset/limit 分段） |
| `novel_keywords` | 提取高频关键词（可单章或全书） |
| `novel_new_chapter` | 创建新章节文件（自动取下一个章号） |
| `novel_sentence_analysis` | **句式模式分析**（句式分布/排列规律/段落结构/句长/情感曲线/风格指纹） |
| `novel_sentence_config` | 查看/修改句式分析开关（与 Web UI 开关同步） |

## 安装（web profile）

```sh
dsh plugin --profile web add D:/tools/dsh-novel-writer-v0.3.0
```

或手动等价操作：把本文件夹放入 profile 的 `node_modules`，并在 profile `package.json` 的
`dsh.profile.bundles` 中加入 `dsh-novel-writer`。安装后**重启 web 应用**生效：
宿主端注册新工具与 `/api/dsh-novel-writer/state` 路由，浏览器端挂载侧边栏「句式分析」开关。

## 配置

插件 config 支持 `root`（章节库根目录）与 `sentenceAnalysis`（默认开关）：

```yaml
- patch:
    - id: novel-writer
      config:
        root: 'D:/我的小说库'
        sentenceAnalysis:
          enabled: true      # 默认启用（UI 开关优先于此处）
          autoAnalyze: true   # 默认自动附带句式分析
```

## 版本记录

### v0.3.0（本版本）
- **新增**：句式模式分析（novel_sentence_analysis）：句式分布、排列规律、段落结构、句长节奏、情感曲线、风格指纹；
- **新增**：Web UI 开关（侧边栏「句式分析」面板）：enabled / autoAnalyze，宿主端 state 文件持久化 + 浏览器降级；
- **新增**：novel_sentence_config 工具，与 UI 开关双向同步；
- **新增**：宿主端 `/api/dsh-novel-writer/state` 路由（loopback 围栏）；
- 更新 SKILL.md / 系统提示词中的句式分析工作流。

### v0.2.0
- 修复章节序号提取（任意位置、中文数字）；新增 UTF-8/UTF-16/GBK 编码自动探测；通过 37 章全量压力测试。

### v0.1.0
- 章节库管理、novel_keywords、novel_new_chapter。
