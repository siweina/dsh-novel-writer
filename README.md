# 📚 dsh-novel-writer — 小说写作助手 / Novel Writing Assistant

**中文** | [**English**](#english)

一个零第三方依赖（仅 Node 内置模块）的 **DeepSeek Harness (DSH / Cordis) 插件**，为 AI 提供小说章节库管理、剧情分析与续写辅助的能力。

A **zero-dependency** (Node built-ins only) **DeepSeek Harness (DSH / Cordis) plugin** that gives the AI novel-chapter-library management, plot analysis, and continuation-writing assistance.

---

## 功能 / Features

### 🇨🇳 中文

1. **章节库管理**：章节存放于 `novels/<书名>/第N章.md`（也支持 `.txt` / `.markdown`），
   插件提供 `novel_books` / `novel_chapters` / `novel_read` 让你（AI）浏览库、列出章节并逐章阅读。
2. **智能章号识别**：章节文件名中的序号支持**任意位置**与多种写法，
   例如 `第01章.md`、`01-标题.md`、`原稿件-单章-…第一章.txt`，
   阿拉伯数字与中文数字（第一章/第十四章/第三十章）均可识别，并自动按章号排序。
3. **编码自动探测**：UTF-8（含/不含 BOM）、UTF-16 LE/BE（含 BOM 或启发式）、GBK/GB18030（无 BOM）均可直接读取，无需手动转码（如记事本另存的 Unicode 文本）。
4. **关键词分析**：`novel_keywords` 确定性提取全书/单章高频关键词（中文相邻二字词组 + 高频单字 + 英文词），
   配合系统提示词引导 AI 分析剧情脉络、写作手法、词汇偏好与意象母题。
5. **续写辅助**：系统提示词规定续写工作流（先读后写、保持文风与伏笔一致），
   `novel_new_chapter` 自动创建下一章文件。

### 🇬🇧 English

1. **Chapter-library management**: chapters live under `novels/<book>/第N章.md` (also `.txt` / `.markdown`).
   `novel_books` / `novel_chapters` / `novel_read` let the AI browse, list, and read chapters.
2. **Smart chapter numbering**: chapter numbers may appear **anywhere** in the filename and in many forms,
   e.g. `第01章.md`, `01-title.md`, `raw-…Chapter-1.txt`. Both Arabic and **Chinese numerals**
   (第一章 / 第十四章 / 第三十章) are recognized and chapters are sorted by number automatically.
3. **Automatic encoding detection**: UTF-8 (with/without BOM), UTF-16 LE/BE (BOM or heuristic), and
   GBK/GB18030 (no BOM) are decoded on the fly — no manual transcoding needed.
4. **Keyword analysis**: `novel_keywords` deterministically extracts high-frequency words from a whole book
   or one chapter (Chinese bigrams + characters + English words), guiding the AI to analyze plot,
   writing style, vocabulary preferences, and imagery motifs.
5. **Continuation writing**: a system prompt enforces the workflow (read first, then write; keep style and
   foreshadowing consistent). `novel_new_chapter` creates the next chapter file automatically.

---

## 提供的工具 / Provided Tools

| Tool | 中文说明 | English |
|------|----------|---------|
| `novel_books` | 列出章节库全部作品（章节数、总字数） | List all books in the library (chapter count, total chars) |
| `novel_chapters` | 列出某作品章节清单（章号/标题/字数/行数/更新时间） | List a book's chapters (number/title/chars/lines/updated) |
| `novel_read` | 阅读某章正文（行号 + 字数统计，offset/limit 分段） | Read a chapter's body (line numbers + char count, paginated) |
| `novel_keywords` | 提取高频关键词（可单章或全书） | Extract high-frequency keywords (chapter or whole book) |
| `novel_new_chapter` | 创建新章节文件（自动取下一个章号） | Create a new chapter file (auto-next number) |

---

## 安装 / Installation

> 现代安装请优先参考 `INSTALL.md`，或使用 DSH CLI：

> Preferred install via DSH CLI, see also `INSTALL.md`:

```sh
dsh plugin --profile web add D:/path/to/dsh-novel-writer
```

或手动等价操作：在 profile 的 `package.json` 的 `dsh.profile.bundles` 中加入 `dsh-novel-writer`，
并在 profile `node_modules` 中链接本包（Windows 可建 junction：`mklink /J`）。安装后重启 web 应用生效。

Or the manual equivalent: add `dsh-novel-writer` to the `dsh.profile.bundles` array in the profile's
`package.json`, and link this package into the profile `node_modules` (on Windows, `mklink /J`).
Restart the web app after installing.

### （可选）安装技能 / (Optional) Install the Skill

把 `skills/novel-writing` 整个文件夹复制到工作区 `.dsh/skills/` 下，新会话即出现 `novel-writing` 技能：

Copy the whole `skills/novel-writing` folder into your workspace `.dsh/skills/`; a new session will surface the `novel-writing` skill:

```
<workspace>/.dsh/skills/novel-writing/SKILL.md
```

---

## 配置 / Configuration

插件 `config` 支持 `root`：章节库根目录（默认取**会话工作区**，即 `novels/` 所在位置）。
在 profile 的 `cordis.patch.yml` 中可覆盖：

The plugin `config` supports `root`: the library root directory (defaults to the **session workspace** where `novels/` lives). Override it in the profile's `cordis.patch.yml`:

```yaml
- patch:
    - id: novel-writer
      config:
        root: 'D:/我的小说库'
```

---

## 章节库约定 / Library Convention

```
<workspace or root>/novels/<书名>/
├── 第01章.md          # 或 .txt / .markdown
└── 原稿件-单章-…第一章.txt   # 序号在任意位置、中文数字均可识别
```

支持的命名与编码 / Supported naming & encoding:

- 章号任意位置：`第01章.md`、`01-标题.md`、`原稿件-单章-…第一章.txt`、`原稿件-单章-第25章 .txt`
- 阿拉伯数字 + 中文数字（第一章/第十四章/第三十章），自动按章号排序
- 编码自动探测：UTF-8（含/不含 BOM）、UTF-16 LE/BE（含 BOM 或启发式）、GBK/GB18030（无 BOM）

---

## 安全说明 / Security Notes

- 仅使用 Node 内置模块，无第三方运行时依赖、无网络请求、无 shell 执行。
- 所有文件读写均限定在章节库根目录下，并通过 `sanitizeSegment` 阻止路径穿越（拒绝 `.`/`..` 与 `\`/`/`）。
- 读取设有上限（单次最多 400 行 / 2 万字符），保护模型上下文。

- Uses only Node built-in modules: no third-party runtime deps, no network calls, no shell execution.
- All file reads/writes are confined to the library root, with `sanitizeSegment` blocking path traversal (rejects `.`/`..` and `\`/`/`).
- Reads are capped (400 lines / 20k chars per call) to protect the model's context window.

---

<!-- ENGLISH -->

## English

`dsh-novel-writer` is a self-contained **DSH (Cordis) bundle plugin** for novel-writing assistance, with **no third-party dependencies** (Node built-ins only). See the sections above for features, tools, install, config, and security notes. MIT licensed.
