# dsh-novel-writer — stdio MCP 服务器

把 **dsh-novel-writer** 插件的 18 个 `novel_*` 小说写作工具，以标准 **MCP（Model Context Protocol）stdio 服务器**暴露给
Claude Desktop、Cursor 等任何 MCP 客户端。

- **零业务复制**：服务器不重写任何逻辑，而是用 stub ctx 启动插件（`lib/index.js` 的 `apply()`），捕获它注册的
  `{ name, description, parameters, execute, output }` 工具定义，再把 MCP 的 `tools/list` / `tools/call` 映射过去。
  **工具数（当前 18）与 stub ctx 暴露的服务面不变时本服务器无需改动**；插件新增工具或改用别的宿主服务
  （如新增 `ctx.xxx` 注入）时，需同步 `mcp/server.mjs` 的 `ctx` 桩。工具数不再硬编码——`server.mjs` 启动时从
  `lib/core.js` 的 `ALL_TOOLS` 派生并与实际注册表比对（v5.0.0 起），所以改名/增删工具只需改 `ALL_TOOLS` 一处。
- **零外部依赖**：只使用 Node 内置模块，手写 JSON-RPC 2.0（不依赖 `@modelcontextprotocol/sdk`）。
- **stdout 只走协议帧**，所有日志写 stderr，绝不污染协议通道。

要求：Node.js **>= 22.3**（与插件 `engines.node` 一致）。

---

## 0. 安全边界（v4.3.0 起）

| 限制 | 说明 | 放开方式 |
|---|---|---|
| 工具参数 `root` 必须落在 `--root` 之内 | 调用方显式传的 `root` 若越界，会被**拒绝并回退**到启动时的书库根，stderr 留一行日志 | 直接把 `--root` 指到你要用的书库根 |
| `novel_import` 的 `src` 默认限根内 | 防止"文档注入 → 把任意目录的 `.md/.txt` 复制进书库再读出"（`mode:"apply"` + `move:true` 还会**删除源文件**） | 确认来源可信后加 `--allow-external-src` 启动 |
| 单行报文上限 4 MiB | 超限整行丢弃（stderr 记长度，不记内容），后续行照常处理 | 无（正常 MCP 报文远小于此） |
| stderr 不打印正文与堆栈 | 非法 JSON 行只记字符数；错误只记一行摘要（避免绝对路径/书名进入客户端日志文件） | 需要完整堆栈时用 `DEBUG=1` 启动 |

## 1. 快速开始

```bash
# 推荐：不用先安装，npx 直接拉起（-p 指定包名，bin 名为 dsh-novel-writer-mcp）
npx -y -p dsh-novel-writer dsh-novel-writer-mcp --root /abs/path/to/novels-workspace

# 或已装进项目后，直接用包内文件启动
node /abs/path/to/dsh-novel-writer/mcp/server.mjs --root /abs/path/to/novels-workspace
```

服务器启动后从 stdin 读取换行分隔的 JSON-RPC 2.0 请求，向 stdout 写响应。手动冒烟：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"novel_books","arguments":{}}}' \
| node mcp/server.mjs --root /abs/path/to/novels-workspace
```

---

## 2. 客户端配置

### Claude Desktop

配置文件位置：

- Windows：`%APPDATA%\Claude\claude_desktop_config.json`
- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux：`~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "dsh-novel-writer": {
      "command": "npx",
      "args": ["-y", "-p", "dsh-novel-writer", "dsh-novel-writer-mcp", "--root", "/绝对路径/novels-workspace"]
    }
  }
}
```

也可以不用 npx，直接把 `command` 写成 `node`、`args` 指向包内文件（需先 `npm install dsh-novel-writer`）：

```json
{
  "mcpServers": {
    "dsh-novel-writer": {
      "command": "node",
      "args": ["/绝对路径/node_modules/dsh-novel-writer/mcp/server.mjs", "--root", "/绝对路径/novels-workspace"]
    }
  }
}
```

`args` 里的路径必须是**绝对路径**；Windows 上可用正斜杠 `/`（无需转义），或用双反斜杠 `\\`。
若 `node` / `npx` 不在 PATH 中，把 `command` 写成可执行文件的绝对路径（如 `"C:/Program Files/nodejs/node.exe"`）。

### Cursor

项目级 `.cursor/mcp.json` 或全局 `~/.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "dsh-novel-writer": {
      "command": "node",
      "args": [
        "/abs/path/to/dsh-novel-writer/mcp/server.mjs",
        "--root",
        "/abs/path/to/novels-workspace"
      ],
      "env": {
        "DSH_NOVEL_WRITER_STATE": "/home/me/.dsh/dsh-novel-writer/state.json"
      }
    }
  }
}
```

### 通用说明

- `--root` 指向**书库根目录**（其下应有 `novels/<书名>/第01章.md` 结构，可先用 `novel_import` 或 DSH 插件创建）。
- 不写 `--root` 时，依次回退到环境变量 `DSH_NOVEL_WRITER_ROOT`、`process.cwd()`。
- 客户端配置里的 `env` 会与父进程环境合并后传给服务器，可用于固定状态文件或书库路径。

---

## 3. 命令行参数与环境变量

| 名称 | 类型 | 说明 |
|---|---|---|
| `--root <path>` / `--root=<path>` | 命令行 | 书库根目录。**优先级最高**，同时是 `root`/`src` 越界判定基准。 |
| `--allow-external-src` | 命令行 | 放开 `novel_import` 的 `src` 限制，允许导入书库根之外的目录（`tools/call` 里 `root` 的限制不受影响）。 |
| `--ignore-plugin-load-error` | 命令行 | 插件 `apply()` 失败时不 `exit(1)`，改为照常应答 `initialize`、其余请求回 `-32603`（见第 5 节"启动失败"）。 |
| `DEBUG=1` | 环境变量 | stderr 输出完整错误堆栈（默认只输出一行摘要）。 |
| `DSH_NOVEL_WRITER_ROOT` | 环境变量 | 书库根目录。优先级低于 `--root`，高于 `process.cwd()`。 |
| `DSH_NOVEL_WRITER_STATE` | 环境变量 | 插件状态文件路径。默认 `~/.dsh/dsh-novel-writer/state.json`。 |
| `DSH_HOME` | 环境变量 | 插件 UI 配置目录基准（`<DSH_HOME>/novel-writer.json`），默认 `~/.dsh`。 |

**root 优先级**：`--root` > `DSH_NOVEL_WRITER_ROOT` > `process.cwd()`。

**root 注入规则**：每次 `tools/call` 时，若调用方**未显式**在 `arguments` 中传 `root`（或传空串），服务器会把上面解析出的
书库根目录注入 `arguments.root`；调用方显式传的 `root` **必须落在该根之内**（越界则拒绝并回退，v4.3.0 起）。

**src 限制**：`novel_import` 的 `arguments.src` 默认必须落在书库根内，越界时返回 `isError: true` 并提示加
`--allow-external-src`；加该开关后不再检查 `src`（这是唯一的文件系统例外，见 README 的「权限与外部服务」）。

**状态文件共享**：MCP 服务器与 DSH 插件使用同一个状态文件（`DSH_NOVEL_WRITER_STATE` 可覆盖）。
因此 DSH 侧边栏「写作助手功能」面板里关闭的工具，在 MCP 侧调用会返回
`错误：工具 novel_xxx（…）当前已在「写作助手功能」UI 中关闭。…`——用 `novel_sentence_config` 或 GUI 重新开启即可。

---

## 4. 工具清单（18 个）

| # | 工具 | 用途 |
|---|---|---|
| 1 | `novel_books` | 列出书库全部作品（章节数、总字数） |
| 2 | `novel_chapters` | 列出某作品全部章节（章号/标题/字数/行数/更新时间） |
| 3 | `novel_read` | 读取章节正文（带行号，可 `offset`/`limit` 分段） |
| 4 | `novel_keywords` | 高频关键词统计（中文相邻二字/三字词组、英文词，以及 `kind:"name-candidate"` 的**疑似人名**；单字不输出） |
| 5 | `novel_new_chapter` | 创建新章节文件（自动附风格基线 μ 摘要与原著锚包） |
| 6 | `novel_import` | 批量导入原稿件（scan 预览 / apply 落盘） |
| 7 | `novel_sentence_analysis` | 句式模式分析（九类句式、转移、节奏、情感曲线、风格指纹） |
| 8 | `novel_sentence_config` | 查看/修改功能开关（enabled / autoAnalyze / 各工具开关 / `promptScene` 提示词场景 / `leanWorkflow` 精简工作流） |
| 9 | `novel_style_check` | 章节风格自检（与全书基线对比，输出偏差与锚段） |
| 10 | `novel_plot` | 伏笔/剧情线登记表（open 待回收 / done 已回收）；新增 `action:"graph"` 结构视图（伏笔埋设跨度 / 人物连续缺席 / 剧情线空档 / 时间线顺序 / 大纲对照，只读） |
| 11 | `novel_settings` | 五张设定表（人物/地点/道具/时间线/世界观用语规范） |
| 12 | `novel_summary` | 章节摘要的增删改查 |
| 13 | `novel_continuity_check` | 连贯性审计（矛盾候选、衔接、OOC、大纲对照） |
| 14 | `novel_semantic_search` | 本地语义检索（embedding，无需关键词） |
| 15 | `novel_style_report` | 风格画像报告（六维基线 + 锚包） |
| 16 | `novel_outline` | 创作资料维护（创作设定/人物/大纲/钩子/状态卡） |
| 17 | `novel_chapter_brief` | 开写包：动笔前一次调用取齐材料（上一章承接口/本章方向/相关人物/待回收伏笔/用语规范/风格基线/锚段与骨架/禁用清单/开写清单），只读不写盘 |
| 18 | `novel_fix_plan` | 改稿台：把风格诊断变成按优先级排好的待办（带行号定位与锚段），`plan`/`verify`/`mark` 三态，只给方向不生成正文 |

每个工具的 `inputSchema` 就是插件注册时声明的 `parameters`（原样透传，未做任何改写）。

---

## 5. 协议实现

**版本协商（v4.3.0 起）**：支持 `2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05`。
按 MCP 生命周期规范，客户端在 `initialize` 里请求的版本**若受支持就原样回**；不受支持时回本服务器的最新支持版本
（`2025-11-25`）。

| 方法 | 行为 |
|---|---|
| `initialize` | 返回协商后的 `protocolVersion`、`capabilities: { tools: {} }`、`serverInfo: { name: "dsh-novel-writer", version: <package.json version> }` |
| `notifications/initialized` | 通知，无响应（`notifications/cancelled`、`notifications/progress` 等同样静默） |
| `notifications/cancelled` | 通知，无响应；**会真的取消在途请求**：`params.requestId` 命中的 `tools/call` 会被 abort（服务器把 `exec.signal` 传给插件） |
| `tools/list` | `{ tools: [{ name, description, inputSchema }] }`，共 18 个 |
| `tools/call` | 参数 `{ name, arguments }`；成功 → `{ content: [{ type: "text", text }] }` |
| `tools/call`（未知工具） | 回**协议错误 `-32602`**（`Unknown tool: <name>`），可读提示在 `error.data.hint`/`availableToolCount`（v4.3.0 起符合规范） |
| `ping` | `{}` |
| 未知方法 | JSON-RPC error `-32601` |
| 非法 JSON 行 | 回 **`-32700` Parse error**（`id: null`）后继续读流，不退出（v4.3.0 起；旧版只记 stderr 不回帧） |
| 带 `id` 的 `notifications/*` | 按无效请求回 **`-32600`**（v4.3.0 起；旧版无条件静默 → 该请求永不结算） |
| 批量请求（JSON 数组） | **按协商版本**：`2024-11-05` / `2025-03-26` 会话下逐条处理并返回响应数组；协商到 **`2025-06-18` 及以后则回 `-32600`**（该版本起 JSON-RPC batching 已被规范移除） |

### 规范符合性说明（v4.3.0）

v4.3.0 曾有两处**刻意保留的偏差**，v4.3.0 已全部按规范修正：

1. ✅ **未知工具现在回协议错误 `-32602`**（原为 `isError` 内容响应）。依据 MCP《Tools → Error Handling》：
   *Unknown tools* 属 Protocol Error，规范示例即 `{"code": -32602, "message": "Unknown tool: invalid_tool_name"}`。
2. ✅ **批量请求按协商版本门控**（原为无条件支持）。JSON-RPC batching 自 MCP `2025-06-18` 起被移除，
   协商到该版本及以后时按无效请求回 `-32600`；仅在更早版本的会话里保留（向后兼容旧客户端）。

### 启动失败（插件加载不了）

默认行为：`lib/index.js` 加载或 `apply()` 抛错时，服务器记 stderr 后 **`exit(1)`**——此时客户端只会看到"管道被关闭"，
拿不到 JSON-RPC 错误帧。需要错误帧时加 `--ignore-plugin-load-error`：服务器照常应答 `initialize`、
`tools/list` 返回**空清单**（结构合法，客户端能优雅展示"没有工具"），其余请求统一回 `-32603`
（`服务器初始化失败：插件加载出错…`）。

### 输出文本规则（v4.3.0 修正）

优先使用插件 `output.render(args, value)` 的返回值：

- 返回**字符串** → 直接采用；
- 返回 **`[{ type: "text", text }]` 数组**（DSH 宿主契约，本插件 18 个工具全部是这种）→ 过滤出 `type === "text"` 的
  `text` 后 `join("\n")` 作为 MCP 文本内容；
- 两者都不是 / `render` 抛错 → 回退 `JSON.stringify(value, null, 2)`。

> 旧实现只认字符串，而插件 `render` 全部返回数组 → **快速路径 16/16 不可达**，MCP 客户端永远收到整包 JSON、
> DSH 侧精修文本（带 `<path>/<type>/<content>` 标记）被丢弃。v4.3.0 已修复。

**工具执行出错**（含参数校验失败、书目录不存在等）不会中断进程，也不会返回协议级错误，而是：

```json
{
  "content": [{ "type": "text", "text": "错误：<message>" }],
  "isError": true
}
```

调用不存在的工具名会返回**协议错误 `-32602`**（`Unknown tool: <name>`，可读提示在 `error.data`）——按 MCP《Tools》
规范它属于请求结构问题，规范客户端不会把它当作工具执行结果；v4.3.0 及更早版本曾返回 `isError` 内容，v4.3.0 已修正。

**通道纪律**：stdout 只写 JSON-RPC 帧；启动信息、工具错误摘要、非法行告警等**全部写 stderr**。
服务器还会把插件内部的 `console.log/info/debug` 改道 stderr 作为兜底保护。
`stdout.write()` 返回 `false`（客户端读得慢）时，服务器会等 `drain` 事件再写下一帧，不会无界堆积。

**隐私**：stderr 默认只写一行错误摘要，不打印错误堆栈、不回显非法 JSON 行内容（避免你的正文/书名/绝对路径
被客户端写进它的日志文件）；`DEBUG=1` 可显式打开完整堆栈。

**生命周期**：stdin 关闭 → 等待在途请求完成并冲刷 stdout（最多等 1 秒 drain）→ `exit 0`；5 秒兜底强制退出。
`unhandledRejection` 只记日志不退出，`uncaughtException` 记日志后退出 1。

---

## 6. 测试

测试**不在 npm 包里**（`package.json` 的 `files` 只发布 `lib`、`mcp`、`skills`、`server.json`、`smithery.yaml`、
`cordis.patch.yml`、两个 README）。要跑测试请用 Git 仓库副本：

```bash
git clone https://github.com/siweina/dsh-novel-writer.git
cd dsh-novel-writer
node --check mcp/server.mjs     # 语法检查
node test/mcp-test.mjs          # 67 项协议/工具断言，exit=0 为通过
node test/client-test.mjs       # 客户端模块加载 + 面板渲染断言，末行 CLIENT OK 为通过
```

`test/mcp-test.mjs` 会在系统临时目录里现造一本 2 章的书，`spawn` 真实服务器进程，覆盖：
握手与版本、每条响应含 `jsonrpc:"2.0"`、通知无响应、18 工具清单与 schema 透传、
`novel_books`/`novel_read`/`novel_sentence_config`/`novel_sentence_analysis`/`novel_style_report` 真实调用、
render 精修文本（非 JSON 兜底）、`novel_import` 的 src 越界拦截、root 注入与显式 root 优先、
工具抛错隔离、未知工具/未知方法、带 id 的通知类请求、`-32700` 与 `-32600` 错误帧、
批量请求、非法 JSON 行容错、stderr 不回显正文、stdout 纯净性、收尾无游离响应、stdin 关闭后 `exit=0`、
插件加载失败的两种行为（默认 `exit=1` / `--ignore-plugin-load-error` 下 `initialize` 正常 + `tools/list` 空清单 + 其余 `-32603`）。

---

## 7. 排障

| 现象 | 处理 |
|---|---|
| 工具返回空书库 | 用 `novel_books` 看返回的 `root` 字段是否为目标书库；检查 `--root` 是否写成了 `novels/` 子目录。 |
| `错误：src 必须位于书库根…内` | `novel_import` 的 `src` 默认限根内；确认来源后加 `--allow-external-src` 重启服务器。 |
| 调用方传的 `root` 被忽略、结果回到另一个书库 | 越界 `root` 会被拒绝并回退（v4.3.0 起），stderr 有 `拒绝越界 root：…` 日志；把 `root` 指到 `--root` 之内。 |
| stderr 出现 `-32700` / `非法 JSON 行` | 客户端发的某一行不是合法 JSON（常见于把多行 JSON 拆错了）。服务器已回错误帧并继续运行，不会中断会话。 |
| stderr 出现 `已丢弃超长行` | 单行报文超过 4 MiB，整行被丢弃。正常 MCP 报文不会这么大，检查客户端是否把文件内容塞进了参数。 |
| 客户端报「连接已关闭」且 stderr 说插件加载失败 | 默认 `exit(1)`（客户端看不到错误帧）。加 `--ignore-plugin-load-error` 可保留进程并收到 `-32603` 错误帧，再照提示修依赖。 |
| `错误：工具 … 当前已在「写作助手功能」UI 中关闭` | 用 `novel_sentence_config` 重新开启，或在 DSH 侧边栏面板打开。 |
| 首次语义检索/风格分析较慢 | `novel_semantic_search` 会加载本地 embedding 模型并建索引，首次调用耗时较长属正常；中途不想等可发 `notifications/cancelled`（带 `requestId`）取消。 |
| 正文乱码 | 章节文件需为 UTF-8；GBK 文件请先转码。 |
| 客户端看不到工具 | 确认 `args` 中 `server.mjs` 为绝对路径、`node` 在 PATH；查看客户端 MCP 日志中的 stderr 输出（应能看到「已注册 18 个工具」）。用 `npx` 时必须写 `-p dsh-novel-writer dsh-novel-writer-mcp`（包名 ≠ bin 名）。 |
| Windows 路径报错 | JSON 中反斜杠需转义 `\\`，或直接使用正斜杠 `/`。 |
