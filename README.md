# dsh-novel-writer — 小说写作助手插件

DSH（DeepSeek Harness）小说写作助手 bundle 插件。零第三方依赖（仅 Node 内置模块），
为 AI 提供小说章节库管理、分析与续写辅助能力。

## 功能（对应需求）

1. **章节库**：章节存于 `novels/<书名>/第N章.md`（或 `.txt`/`.markdown`），
   插件提供 `novel_books` / `novel_chapters` / `novel_read` 让 AI 浏览并读取每一章内容。
   章节文件名中的序号支持任意位置与多种写法，例如：
   `第01章.md`、`01-标题.md`、`原稿件-单章-…第一章.txt`、`原稿件-单章-第25章 .txt`
   （阿拉伯数字与中文数字"第一章/第十四章/第三十章"均可识别，自动按章号排序）。
   文件编码自动探测：UTF-8（含/不含 BOM）、UTF-16 LE/BE（含 BOM 或启发式识别）、GBK/GB18030（无 BOM），
   无需手动转码即可读取（如记事本另存的 Unicode 文本）。
2. **分析**：`novel_keywords` 确定性提取全书/单章高频关键词（中文相邻二字词组 + 高频单字 + 英文词），
   配合系统提示词引导 AI 分析剧情脉络、写作手法、词汇偏好与意象母题。
3. **续写**：系统提示词规定续写工作流（先读后写、保持文风与伏笔一致），
   `novel_new_chapter` 创建新章节文件。
4. **原稿件批量导入/自动分类**：`novel_import` 扫描存放多本小说稿件的文件夹
   （支持子文件夹、UTF-16/GBK 等编码、任意位置章号），从文件名与文件头内容双通道
   提取书名候选并聚合成分组建议（scan 模式），AI 确认后可一键按书分类复制/移动到
   `novels/<书名>/`（apply 模式）；支持 `book` 强制归并异名同书、`files` 精确指定文件。

## 提供的工具

| 工具 | 说明 |
|---|---|
| `novel_books` | 列出章节库全部作品（章节数、总字数） |
| `novel_chapters` | 列出某作品章节清单（章号/标题/字数/行数/更新时间） |
| `novel_read` | 阅读某章正文（行号 + 字数统计，offset/limit 分段） |
| `novel_keywords` | 提取高频关键词（可单章或全书） |
| `novel_new_chapter` | 创建新章节文件（自动取下一个章号） |
| `novel_import` | 扫描原稿件文件夹，自动识别/分类多本小说章节到 `novels/<书名>/`（scan 预览 / apply 执行，支持 book 强制归并与 files 精确导入） |
| `novel_style_pattern` | **（受 stylePattern 开关控制）** 句式模式分析：把句子分为陈述/环境/心理/对话/疑问/反问/感叹七类，输出占比、高频组合与按章节的压缩排列序列，用于模仿原文叙事节奏 |

## 安装（web profile）

```sh
dsh plugin --profile web add D:/Deep\ Seek插件库/novel-writer
```

或手动等价操作：在 profile 的 `package.json` 的 `dsh.profile.bundles` 中加入
`dsh-novel-writer`，并在 profile `node_modules` 中链接本包。安装后重启 web 应用生效。

## 配置

插件 config 支持 `root`：章节库根目录（默认取会话工作区，即 `novels/` 所在位置）。
在 profile 的 `cordis.patch.yml` 中可覆盖（顶层数组元素直接是条目，无需 `patch:` 包装）：

```yaml
- id: novel-writer
  config:
    root: 'D:/我的小说库'
```

### stylePattern 开关（句式模式仿写拓展）

`stylePattern`（布尔，**默认 false 关闭**）：控制 `novel_style_pattern` 工具与
"句式模式仿写"提示词——分析原文陈述/反问/心理/对话等句子的排列节奏，引导续写时保持相近
叙事节奏。

> ⚠️ **已知风险**：该功能可能让整体文风变得更僵硬（机械套用句式模板）。默认关闭；
> 开启后模型侧也内置了"模式是参考、僵硬时优先自然表达"的约束，但仍建议按需使用。

**Web 设置开关（推荐）**：重启 web 后，打开 **设置 > 插件配置**，会看到
「小说写作助手 novel-writer」卡片，勾选「开启句式模式仿写（stylePattern）」即可——
改动写入 `$DSH_HOME/novel-writer.json`，**即时生效，无需重启**（工具未开启时调用会返回明确提示）。

也可在 profile 的 `cordis.patch.yml` 中配置（顶层数组元素直接是条目）：

```yaml
- id: novel-writer
  config:
    root: ''
    stylePattern: true
```

开关判定优先级：`$DSH_HOME/novel-writer.json` 中的持久化值 或 loader 配置的 `stylePattern`，任一为 true 即开启。
