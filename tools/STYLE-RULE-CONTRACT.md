# STYLE-RULE-CONTRACT —— v6.4.0 世界观用语规范的接口契约

> **所有参与 v6.4.0 的子代理必须先读本文**（很短，读完即可动手，不要去整读 `lib/index.js` / `lib/brief.js` 等大文件）。
> 协调方已完成的**核心部分**在 `lib/core.js`；你的任务是消费它，**不要重写它**。

---

## 1. 背景：这次要修什么

用户在**欧式/中世纪**设定下写作，AI 却写出「掌柜」「多谢提点」这类中式市井/客套词。复核确认代码侧有 **6 处独立断点**（详见桌面 `dsh-novel-writer-中式语用渗透-归因与修复方案.md`）。

**其中 2 处已由协调方修掉**（P0-2 合并语义、P0-4 统一词源）。你负责剩余部分。

---

## 2. 已完成的接口：`resolveStyleRule()`（**唯一裁决点**）

位置：`lib/core.js`（`export function resolveStyleRule`），已 `export`，已由 `lib/index.js` 与 `lib/brief.js` 所依赖的 `core.js` 提供。

### 调用方式

```js
import { resolveStyleRule } from "./core.js";   // brief.js / index.js 都是同目录
const rule = resolveStyleRule(settings, chapterTexts);
```

- `settings`：`readSettings(root, book)` 的返回值（容忍 `undefined`）
- `chapterTexts`：**强烈建议传**。接受 `string[]` 或 `{ file, text }[]` 两种形状。
  仅在**未登记 worldview** 时用于按正文检测文化基准；不传则落默认欧式。

### 返回值（逐字段，稳定契约）

| 字段 | 类型 | 含义 |
|---|---|---|
| `culture` | `"western" \| "eastern" \| "modern" \| "mixed"` | 生效的文化基准 |
| `cultureSource` | `"worldview" \| "detected" \| "default"` | 该基准从哪来（登记 / 正文检测 / 落默认） |
| `cultureName` | `string` | 用于文案的基准名（如 `"王国纪事"` 或 `"西方/欧式中世纪"`） |
| `speechCultureName` | `string` | 语用规范条目名（`speechEntry.name` 优先，缺则回落 `cultureName`） |
| `bannedWords` | `string[]` | **合并后**的禁词（= 用户登记 ∪ 文化基准对应的默认表，去重） |
| `recommended` | `Record<string,string>` | 合并后的替代词（用户登记优先覆盖默认） |
| `speechStyle` | `object \| null` | **合并全部 worldview 条目**的语用规范：`{ title, honorBad[], honorGood{}, ritualBadPatterns[], ritualGoodNote, tone }` |
| `userBannedWords` | `string[]` | 用户显式登记的禁词（未含默认表） |
| `defaultEnabled` | `boolean` | 默认表是否生效（显式 `bannedWords: []` 时为 `false`） |
| `registered` | `boolean` | 是否登记过**任何** worldview 条目 |
| `sources` | `{ userCount, defaultCount, total, hint }` | 诊断用计数 |

### 合并语义（**已定，不许改**）

```
bannedWords = 去重( 用户登记 ∪ 该文化基准对应的默认表 )
显式 bannedWords: []  ⇒  defaultEnabled=false ⇒ 只用用户表（= "我不要默认表"）
默认表按 culture 选：
  western → DEFAULT_BANNED_WORDS.bannedWords   （欧式默认表：老夫/上香/掌柜/客栈/银两/衙门/郎中…，词表以源码为准）
  eastern → SPEECH_STYLE_RULES.eastern.honorBad （**禁西式词**：Miss/先生/教堂/神甫…）
  modern  → 空
```
> ⚠️ 方向别搞反：`eastern` 的默认表是"禁西式词"，不是"禁中式词"。

### 另一个工具：`hintCulture(text)`

`lib/core.js` 导出。用于**只看一段登记文本**（basis/name）判断文化基准，返回 `{ culture, confidence, ... }` 同 `detectCulture` 的形状。
`resolveStyleRule` 内部用的就是它；若你在别处需要"按登记文本判文化"，**必须调它**，不要另写正则。

---

## 3. 本次已改动的既有位置（你可能会碰到）

| 位置 | 改动 |
|---|---|
| `lib/core.js` | 新增 `hintCulture()` 与 `resolveStyleRule()`；`markers.js` 的 import 增加了 `DEFAULT_BANNED_WORDS, SPEECH_STYLE_RULES` |
| `lib/index.js:16` | `markers.js` 的 import **移除了 `DEFAULT_BANNED_WORDS`**（已无直接使用者，统一走 `resolveStyleRule`） |
| `lib/index.js` 的 import from `./core.js` | 增加了 `hintCulture, resolveStyleRule` |
| `lib/index.js` 约 L3059–L3092（`novel_continuity_check` 全书用语扫描） | **内联 ~40 行已整段替换为 `const styleRule = resolveStyleRule(settings, chapterTexts)`**；后续的 `speech` 变量改为读 `styleRule.speechStyle`（合并全部条目，不再是单个条目） |
| `lib/index.js` 约 L2460（`novel_settings` add/update 自动推导语用规范） | 内联的 east/west 正则改为调 `hintCulture(basisText)` |

**这些位置不要再改回去**；如你的任务需要在其附近编辑，请只做增量。

---

## 4. 纪律（踩过坑，务必遵守）

1. **不要整读大文件**：`lib/index.js`、`lib/brief.js`、`lib/core.js` 等大文件（体量以 `(Get-Content <文件>).Count` 现量为准）。用 `grep` 定位，再用 `read` 带 `offset/limit` 看片段。整读会耗尽你的上下文，让你"只能读不能判"。
2. **改完必须跑**：`cd F:\doment\dnw-work && node test/run-tests.mjs` → 必须末尾为 `All 10 test suites passed.`（套数以 `test/run-tests.mjs` 输出为准）。**回退基线是全绿**，你若弄红就是你的责任。
3. **另跑** `node tools/check-release.mjs`（必须 exit 0）。
4. **同步文档**：改了工具的参数或返回结构，必须同步改 `docs/tools/novel-*.html` 对应页面（返回结构/参数表的字面描述）。改了什么就在报告里列出来。
5. **写文件用** `[System.IO.File]::WriteAllText($p,$s,[System.Text.UTF8Encoding]::new($false))`（UTF-8 无 BOM）；读文件用 `read` 工具（`Get-Content` 会把 UTF-8 当 GBK，中文乱码）。
6. **不要改版本号**（协调方最后统一提到 6.4.0）。
7. **不要动** `lib/analysis.js`、`lib/style-metrics.js`、`lib/embedding.js`、`lib/vibe.js`、`lib/graph.js`、`lib/fixplan.js`、`mcp/**`、`lib/client.js`。
8. 保持既有代码风格：ES module、2 空格缩进、`const/let`、中文注释、**注释里写清"为什么"并标 `v6.4.0`**。

---

## 5. 报告格式

- 改了哪些文件（精确相对路径）
- 每处改动：改前 → 改后（含 `文件:行号`）
- `run-tests.mjs` 与 `check-release.mjs` 的**末几行输出 + 真实 exit code**
- 同步更新了哪些 docs 页面
- `gaps`：你无法实现或无法判定的部分 —— **如实写，不要粉饰**
