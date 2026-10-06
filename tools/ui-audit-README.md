# UI 统一改造 · 作战契约（子代理必读）

目标：让插件面板「看起来就是 DSH 的一部分」。依据是官方规范原文（见 §3），验收按官方 UI 验收清单。

---

## §1 铁律（违反即任务失败）

1. **你只能创建/修改 §2 分配给自己的文件。** 严禁改：`lib/client.js`（**只有总负责人能改**，它必须保持单文件——宿主按 `exports["./client"]` 整体物化，不能 import 兄弟模块）、`package.json`、`test/*`、`README*`、`CHANGELOG.md`、发布克隆目录、已安装的桌面 profile（`~/.dsh/**`）、以及**其它子代理的任何文件**。
2. 只读检查仓库任意文件是允许且鼓励的；**写**只允许写自己的文件。
3. 禁止：`pnpm/npm install`、git 操作、删除文件、改环境变量、联网写操作、修改插件运行期状态。
4. 禁止再开子代理。
5. **需要改别人文件的地方、需要做决策的地方、需要真机验证的地方 → 停手并写进报告的「待总负责人处理」一节**，不要自己绕过、不要临时凑合。
6. 保持插件对外的行为/工具契约零变化：这是纯 UI 改造。
7. **绝对安全红线**：不得引入任何可能让宿主启动失败的写法。特别地：`ctx.slots.inject`（槽位等待，安全）与 `ctx.inject`（cordis 服务等待，**曾导致桌面端 web boot 失败**）不是一回事；取宿主服务只能 `ctx.get(name)`。你的产物里若出现 `ctx.inject(` 的依赖等待，直接判失败。

## §2 文件所有权

| 角色 | 独占文件 | 交付 |
|---|---|---|
| A（CSS） | `F:\doment\_ui-work\A-css.css`、`F:\doment\_ui-work\A-check.mjs`、`F:\doment\_ui-work\A-notes.md` | 完整的新 CSS 文本（将被整体替换进 client.js 的 `const CSS = \`…\`` 模板）+ 自检脚本 + 说明 |
| B（适配层） | `F:\doment\_ui-work\B-adapter.js`、`F:\doment\_ui-work\B-adapter-test.mjs`、`F:\doment\_ui-work\B-notes.md` | 自包含代码块 + 独立测试 + 说明 |
| C（审计工具） | `tools/ui-audit.mjs`、`tools/ui-audit-fixture-good.js`、`tools/ui-audit-fixture-bad.js`、本文件 | 规则审计 CLI + 好坏样本自测 + 说明 |
| 总负责人（我） | `lib/client.js` 及仓库其余文件 | 集成：splice A/B、改造控件调用点、消除内联样式、跑全套测试、真机验证 |

**你的产物是"文本块"，不是要你直接改 client.js。** 块必须能原样插入/替换，且自包含（不 import 本地文件）。

## §3 官方规范（原文要点，务必遵守）

出处（可在线核对）：
- 《Web UI 样式参考》 https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/web-styling.zh.md
- 《DSH 统一圆角规范》 https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/ui-radius.zh.md

硬规则：
1. 功能组件使用 `--dsw-alias-*` 语义 token，**不得写颜色字面量**（`#hex`、`rgb()/rgba()/hsl()`、渐变里的色值都算）。
2. **平面中性边框与分割线一律 `0.5px`**；只有 dashed 记号与状态色边框保留 1px。
3. 高层级表面（菜单/浮层/对话框/面板/输入框）**`border: 0` + `box-shadow: var(--dsw-elevation-panel|prominent|soft)`**；**不得**把 `--dsw-alias-border-*` 边框与 elevation 阴影配对（elevation 自带 0.5px 发丝描边）。设置卡片例外，用下面的官方材质。
4. 圆角只用具名尺度，**不得新增 10px/14px/18px/24px 之类局部数值**：
   R4 `--dsw-radius-xs`｜R8 `--dsw-radius-sm`｜R12 `--dsw-radius-md`｜R16 `--dsw-radius-lg`｜R20 `--dsw-radius-xl`｜R28 `--dsw-radius-panel`。
   用途映射：H20–28 紧凑控件→R8；H32–40 标准控件/单行 cell→R12；大控件/多行 cell/嵌套表单组→R16；**独立内容卡片/设置卡片→R20**；**对话框与主面板→R28**。
5. 设置卡片统一材质：
   `border-radius: var(--dsw-radius-xl); border: 0.5px solid var(--dsw-alias-settings-card-stroke); background: var(--dsw-alias-settings-card-fill);`
6. 正圆与胶囊半径（`50%`、`999px`）**必须同规则配对 `corner-shape: round`**（主题默认给所有元素加 superellipse 平滑，会把圆压变形）。
7. 模态弹窗保留黑色半透明遮罩、**不模糊背景**（主题把 `--dsw-mask-blur` 设为 `none`）。
8. 字号与行高**成对**声明；能复用主题排版变量就复用。
9. 功能组件 CSS **不得包含主题选择器**（`prefers-color-scheme`、`[data-ds-dark-theme]`、`.dark`）；不得自定义滚动条选择器。
10. hover/动效不得牺牲键盘焦点可见性与 `prefers-reduced-motion` 行为。

参考数据（已为你生成，直接读）：
- `tools/tokens.md` —— **362 个 `--dsw-*` token 白名单**（从实际装机的官方/第三方包里取证，含来源）。**只用白名单里的 token**，且优先 `--dsw-alias-*` 语义别名。
- `tools/classes.txt` —— 现有 109 个 `nw*` 类名（CSS 定义 106 + JS 使用 80 的并集）。
- 官方组件与类型的解包副本：`F:\doment\_ui020\`（`dsh-client-ui-primitives`、`dsh-client-ui-sidebar`、`dsh-client-ui-settings`、`dsh-client-ui-layout` 等）。
- 可参考的第三方成熟写法：`C:\Users\zg\.dsh\profiles\desktop\node_modules\@linxin666\*\lib\client.js`（它们的 CSS 内嵌在 `const css = "…"` 里）。
- 待改造源码（只读）：`lib/client.js`（CSS 模板在文件开头 `const CSS = \`…\``，其余是 React 组件）。

## §4 A 的规格（CSS）

1. 产物 `A-css.css` = **完整的 CSS 文本**（不含外层的 `const CSS = \`` 与结尾反引号），将被整体替换进 client.js。保持同样的缩进风格（两空格）与紧凑写法（不要改成多行展开，避免体积暴涨）。
2. **不得删除/重命名任何现有类名**（`classes.txt` 全清单必须仍然存在）。可以把旧的死规则保留（后续再清）。
3. 必须修掉：90 处 `#hex` + 24 处 `rgba()` 颜色字面量 → 全部换成语义 token（无 fallback 字面量；若担心 token 缺失，用 `var(--a, var(--b))` 这种 token→token 兜底，仍不得出现色值）。
4. 必须修掉：15 处 `1px solid var(--dsw-alias-border…)` → `0.5px`；dashed 与状态色边框保留 1px。
5. 卡片/弹窗/面板等表面按 §3 第 3、5 条改用 `border: 0` + `--dsw-elevation-*`（或设置卡片材质），去掉 `--dsw-shadow-lv3` 这类旧 token（若白名单里存在也可保留，但优先新体系）。
6. 圆角全部改用 `--dsw-radius-*`；`999px`/`50%` 补 `corner-shape: round`。
7. 20 处 `font-size` 补 `line-height`（可用主题排版变量则优先）。
8. **新增以下类名并给出样式**（总负责人会把 JS 里的 51 处含色内联样式改成这些类）：
   - `nwBoxed` 内嵌分组/预览盒：`--dsw-alias-bg-layer-1` + 0.5px `--dsw-alias-border-l2` + R12 + padding 8px 12px
   - `nwSubCard` 嵌套编辑器盒：`--dsw-alias-bg-layer-1` + 0.5px border-l2 + **R16**
   - `nwChip` 小胶囊按钮：H24 + R8 + 0.5px border-l2 + `--dsw-alias-bg-layer-1` + 12/18
   - `nwTextInput` 单行输入：H32 + **R12** + 0.5px border-l2 + `--dsw-alias-bg-layer-1` + `--dsw-alias-label-primary` + 13/20
   - `nwTextArea` 多行输入：R12 + 0.5px border-l2 + min-height 56px + padding 10px 12px + 13/20
   - `nwSelect` 下拉：H32 + R12 + 0.5px border-l2 + `--dsw-alias-bg-layer-1`
   - `nwNote` 三级小字：`--dsw-alias-label-tertiary` + 11/16
   - `nwMuted` 二级文字：`--dsw-alias-label-secondary` + 13/20
   - `nwSignOk` 成功符号：`--dsw-alias-label-success`（白名单里若无则用最近的状态语义 token）+ width 12px + 居中
   - `nwSignBad` 失败符号：`--dsw-alias-label-error` + width 12px + 居中
   - `nwGutter` 序号/沟槽：`--dsw-alias-label-tertiary` + 13/18 + 居中
   - `nwDashedNote` 虚线提示块：1px dashed border-l2 + `--dsw-alias-bg-layer-1` + R12 + padding 10px 12px
   - `nwDividerRow` 分隔行：`border-bottom: 0.5px solid var(--dsw-alias-border-l2)`
   另外把已存在但没样式（或样式不足）的 `nwBtnPrimary` / `nwBtnGhost` / `nwBtnDone` / `nwModalInput` 补齐为语义 token 样式（主按钮用 `--dsw-alias-button-primary-fill` / `-hover` + `--dsw-alias-label-primary-foreground`；ghost 透明底 + 0.5px 边框；done 用成功语义）。
9. 自检脚本 `A-check.mjs`：读 `A-css.css` 断言——零颜色字面量、零非 0.5px 中性 solid 边框、零裸圆角数值（除 0 与配对 corner-shape 的胶囊）、每个 `var(--dsw-*)` 都在 `tokens.md` 白名单内、`classes.txt` 里每个类名都仍存在、字号都配行高、无主题选择器/滚动条选择器。把命令与输出写进 `A-notes.md`。

## §5 B 的规格（官方原语适配层）

产物 `B-adapter.js` = **自包含 JS 代码块**（无 import、无出口语句，直接插入 client.js 顶层区段）。对外只暴露一个工厂：

```js
var NW_UI = createNovelWriterUI(react, require);
```

`react` 是 client.js 里已有的 React 对象（用 `react.createElement`，**不要用 JSX**；client.js 是纯函数式 `createElement` 写法）；`require` 是宿主给的模块表 require。

返回对象 API（**冻结签名，我的调用点按此写**）：

| 键 | 语义 | props（我传的） |
|---|---|---|
| `available` | 官方 primitives 是否加载成功（布尔） | — |
| `Button` | 按钮 | `{ variant?: "primary"\|"ghost"\|"outline"\|"toolbar", size?: "sm"\|"md", disabled?, title?, onClick?, className?, children }` |
| `Switch` | 开关 | `{ checked, onChange(next:boolean), disabled?, label }` |
| `SegmentedControl` | 互斥分段 | `{ label, value, options: [{value,label,disabled?,title?}], onChange(next), disabled? }` |
| `Modal` | 居中对话框 | `{ open, title, description?, onClose, closeLabel, children?, footer? }` |
| `RiskConfirmation` | 敏感操作二次确认 | `{ open, title, description, acknowledgeLabel, cancelLabel, confirmLabel, acknowledged, disabled?, onAcknowledgedChange, onCancel, onConfirm }` |
| `Tag` | 只读胶囊徽标 | `{ tone?, children }` |
| `Tooltip` | 提示气泡 | `{ label, children }` |
| `DisclosureRow` | 紧凑折叠行 | `{ title, children, defaultOpen?, className? }` |

要求：
1. 先读真实类型定义：`F:\doment\_ui020\dsh-client-ui-primitives\lib\types\*.d.ts`（`Button.d.ts` / `Switch.d.ts` / `SegmentedControl.d.ts` / `Modal.d.ts` / `RiskConfirmation.d.ts` / `Tag.d.ts` / `Tooltip.d.ts` / `DisclosureRow.d.ts`），按**真实 props** 写适配；官方 props 与上表不同就由适配层转换，并在 `B-notes.md` 里列出差异对照。
2. `require("@deepseek-ai/dsh-client-ui-primitives")` 必须包在 `try/catch` 里；取不到模块、或某组件缺失、或官方组件渲染抛错时**自动回退**到自绘实现。**任何情况下都不得抛到上层**（宿主启动安全第一）。
3. 回退实现必须复用现有 `nw*` 类名（`nwSwitch`/`nwSwitchOn`/`nwSwitchKnob`/`nwSwitchSmall`/`nwSwitchSmallOn`/`nwSwitchSmallKnob`/`nwSeg`/`nwSegBtn`/`nwSegBtnOn`/`nwBtn`/`nwBtnPrimary`/`nwBtnGhost`/`nwBtnDanger`/`nwModal`/`nwModalBox`/`nwModalTitle`/`nwModalText`/`nwModalBtns`/`nwModalInput`），**且不得出现任何颜色字面量或内联色值**（样式全在 CSS 里）。
4. 官方组件需要本地化文案（它们读不到 locale），适配层把 `label` 等文案原样透传；缺省文案由我传入。
5. 官方 `Switch` 的必填 `label`、`Modal` 的 `closeLabel` 等，若我没传，适配层给一个安全默认（例如空字符串），但**不得**在适配层里硬编码中文。
6. 测试 `B-adapter-test.mjs`（`node B-adapter-test.mjs` 直接可跑）：用 `node:vm` 或 `new Function` 在沙箱里求值 `B-adapter.js`，注入假的 `react` 与假的 `require`，断言：
   - 假 require 返回完整官方模块 → `available === true`，8 个键齐全，传给官方组件的 props 与上表一致；
   - 假 require 抛错 → `available === false`，8 个键齐全（回退实现），渲染结果里用到 `nw*` 类名，且无 `#hex`/`rgba(` 字面量；
   - 假 require 返回残缺模块（缺 `Switch`）→ 不抛错；
   - 官方组件构造时抛错（用一个会抛的假组件）→ 被兜住且回退可用；
   - 全流程零 `console.error`/未捕获异常。
   把命令与输出写进 `B-notes.md`。

## §6 C 的规格（规则审计 CLI）

产物 `ui-audit.mjs`，用法 `node tools/ui-audit.mjs <client.js 路径> [--json]`，逐条检查并**带行号**报告；有违规时退出码非 0：

1. CSS 模板内零颜色字面量（`#hex` / `rgb(` / `rgba(` / `hsl(` / 渐变里的色值）。
2. JS 部分零内联 `style` 对象含色值/`linear-gradient`/裸圆角数值/裸 `fontSize` 数值。
3. 所有中性 `border`（含 `border-top/right/bottom/left`）为 `0.5px`；只允许 dashed 与含 `state-`/`error`/`success`/`warn` 语义色的边框为 `1px`。
4. 圆角只能为 `var(--dsw-radius-*)`、`0`，或 `50%`/`999px`（后者必须同行有 `corner-shape: round`）。
5. 使用了 `--dsw-elevation-*` 的表面不得同时有 `--dsw-alias-border-*` 边框。
6. 每条含 `font-size` 的规则（或同行）必须有 `line-height`。
7. 不得出现主题选择器（`prefers-color-scheme` / `[data-ds-dark-theme]` / `.dark`）或 `::-webkit-scrollbar`。
8. 每个 `var(--dsw-*)` 必须在 `tools/tokens.md` 白名单里（从该文件解析 token 名）。
9. 类名契约双向：`classes.txt` 里每个类名都要在 CSS 里定义；JS 里每个 `className` 用到的 `nw*` 类名也必须在 CSS 里定义。
10. 启动安全：JS 里不得出现 `ctx.inject(` 形式的 cordis 服务等待；`require("@deepseek-ai/dsh-client-ui-primitives")` 必须出现在 `try` 块内。
11. 输出格式：`文件:行 规则编号 说明`，末尾汇总各类计数。

必须自带自测：`tools/ui-audit-fixture-good.js`（全部通过）与 `tools/ui-audit-fixture-bad.js`（每条规则至少触发一次），并在本文件记录 `node tools/ui-audit.mjs tools/ui-audit-fixture-good.js` 退出 0、`node tools/ui-audit.mjs tools/ui-audit-fixture-bad.js` 退出非 0 的实测输出。**C 不对现有 client.js 的通过性负责**——它只做工具；违规是总负责人去修。

## §7 报告格式（必须按此结构）

```
## 交付
- 文件：<路径>（<字节数>）...
## 做了什么（要点）
## 实测证据
- 命令：`...`
- 输出：<原样粘贴关键行>
## 与契约的偏差 / 我做的判断
## 待总负责人处理（不要自己动手）
- <需要改 client.js / 别的子代理文件 / 需要真机验证 / 需要决策的事项>
## 我注意到的其它问题（只报告，不修）
```
