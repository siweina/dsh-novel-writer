# dsh-novel-writer — 小说写作助手插件（v0.7.0：全工具 UI 开关）

DSH（DeepSeek Harness）小说写作助手 bundle 插件。宿主端零第三方依赖（仅 Node 内置模块），
浏览器端仅依赖 Web GUI 自带的 react。
**v0.7.0 在 v0.6.0 基础上为全部 10 个工具增加独立 UI 开关（侧边栏「写作助手功能」面板统一管理）**：分析缓存与报告导出、风格自检、伏笔登记表、
关键词三字组/疑似人名、情感词典去噪、祈使句与环境分类改进、局域网开关可选放行。

## 工具清单（10 个，全部带独立 UI 开关）

| 工具 | 说明 |
|---|---|
| `novel_books` | 列出章节库全部作品 |
| `novel_chapters` | 列出某作品章节清单 |
| `novel_read` | 阅读某章正文（offset/limit 分段，编码自动探测） |
| `novel_keywords` | 关键词：二字组 + **三字组** + **疑似人名** + 英文词 |
| `novel_new_chapter` | 创建新章节文件 |
| `novel_import` | 原稿件批量导入/自动分类（含**异名同书提示**） |
| `novel_sentence_analysis` | 句式模式分析（九类/情感曲线/章节节奏/指纹，**带缓存与报告文件**） |
| `novel_sentence_config` | 查看/修改句式分析开关 |
| `novel_style_check` | **风格自检（v0.6.0 新增）**：章节 vs 全书指纹对比 + 偏差清单 |
| `novel_plot` | **伏笔/剧情线登记表（v0.6.0 新增）**：list/add/update/done/delete |

## v0.6.0 新增能力

1. **分析缓存 + 报告导出**：novel_sentence_analysis 结果自动缓存到 `~/.dsh/dsh-novel-writer/cache/<书名>-<hash>.json`，
   返回值带 `reportFile` / `cache`（hit/miss）字段；章节未改动时重复分析秒回，传 `fresh=true` 强制重算。
2. **风格自检 novel_style_check**：任意章节 vs 全书其余章节 → 余弦相似度 + 句式/句长/情绪偏差清单 + 续写建议（写完新章自动查一次，防止文风漂移）。
3. **伏笔登记表 novel_plot**：`novels 根目录/.novel-writer/<书名>.json` 持久化；续写前 list 查看未回收伏笔。
4. **关键词升级**：新增三字组与疑似人名（"XX说/道/问"与"XX小姐/导师"模式），人名不再被拆成"露西+西亚"。
5. **情感词典去噪**：单字词搭配排除（"叹气"不算"气"、"笑道"不算"笑"）、否定过滤（"不害怕"不计）、副词距离窗口化（"非常开心"才加权）。
6. **分类改进**：祈使句支持"快睡吧，明天还要上班"式（命令动词开头+吧）；环境词表扩充（晚风/晨曦/森林/群山…）。
7. **情感曲线粒度可调**：`curveSegments` 参数（1-50，默认 20）。
8. **novel_import 异名同书提示**：scan 结果中组名包含/高重合时列出 `maybe` 字段，提示用 `book` 合并。
9. **局域网开关可选放行**：config `allowLanState: true` 时，state 路由对同源局域网请求放行（默认仍仅 loopback）。

## UI 开关（v0.7.0：10 个工具全开关）

- **唯一开关位置：侧边栏「写作助手功能」面板**——总开关（enabled，控制句式分析/风格自检）+ 自动分析（autoAnalyze）+ **10 个工具各自独立开关**（全部默认开启）；
- 关闭的工具，AI 调用时会收到明确提示；novel_sentence_config 可查/改全部开关（含 tools 字段）；
- 设置 > 插件配置 卡片仅显示状态 + 「打开开关面板」跳转；
- 持久化 `~/.dsh/dsh-novel-writer/state.json`；兼容 v0.4.0 的 novel-writer.json / config.stylePattern；
- 默认开启；路由 `/api/dsh-novel-writer/state`（loopback 围栏，可选局域网放行）。

## 安装

```sh
dsh plugin --profile web add D:/tools/dsh-novel-writer
```

或手动：放入 profile 的 node_modules + `dsh.profile.bundles` 加 `dsh-novel-writer`；重启 web 应用。

## 配置

```yaml
- id: novel-writer
  config:
    root: 'D:/我的小说库'
    sentenceAnalysis:
      enabled: true
      autoAnalyze: true
    allowLanState: false   # true=局域网访问 GUI 时也允许保存开关

## v0.7.0 更新内容

- **10 个工具全部带独立 UI 开关**（侧边栏「写作助手功能」面板）：novel_books / novel_chapters / novel_read / novel_keywords / novel_new_chapter / novel_import / novel_sentence_analysis / novel_sentence_config / novel_style_check / novel_plot，默认全开；
- UI 更名：侧边栏入口/面板/横幅由「句式分析」改为「写作助手功能」；设置页卡片同步；
- novel_sentence_config 升级：支持 tools 参数（如 `{ novel_plot: false }`）与返回各工具开关状态；
- 关闭的工具调用时返回明确提示（模型可见）。
```
