# dsh-novel-writer — stdio MCP 服务器

把 **dsh-novel-writer** 插件的 16 个 `novel_*` 小说写作工具，以标准 **MCP（Model Context Protocol）stdio 服务器**暴露给
Claude Desktop、Cursor 等任何 MCP 客户端。

- **零业务复制**：服务器不重写任何逻辑，而是用 stub ctx 启动插件（`lib/index.js` 的 `apply()`），捕获它注册的
  `{ name, description, parameters, execute, output }` 工具定义，再把 MCP 的 `tools/list` / `tools/call` 映射过去。
  插件升级后本服务器无需改动。
- **零外部依赖**：只使用 Node 内置模块，手写 JSON-RPC 2.0（不依赖 `@modelcontextprotocol/sdk`）。
- **stdout 只走协议帧**，所有日志写 stderr，绝不污染协议通道。

要求：Node.js **>= 22.3**（与插件 `engines.node` 一致）。

---

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
| `--root <path>` / `--root=<path>` | 命令行 | 书库根目录。**优先级最高**。 |
| `DSH_NOVEL_WRITER_ROOT` | 环境变量 | 书库根目录。优先级低于 `--root`，高于 `process.cwd()`。 |
| `DSH_NOVEL_WRITER_STATE` | 环境变量 | 插件状态文件路径。默认 `~/.dsh/dsh-novel-writer/state.json`。 |
| `DSH_HOME` | 环境变量 | 插件 UI 配置目录基准（`<DSH_HOME>/novel-writer.json`），默认 `~/.dsh`。 |

**root 优先级**：`--root` > `DSH_NOVEL_WRITER_ROOT` > `process.cwd()`。

**root 注入规则**：每次 `tools/call` 时，若调用方**未显式**在 `arguments` 中传 `root`（或传空串），服务器会把上面解析出的
书库根目录注入 `arguments.root`；调用方显式传的 `root` 一律以调用方为准。

**状态文件共享**：MCP 服务器与 DSH 插件使用同一个状态文件（`DSH_NOVEL_WRITER_STATE` 可覆盖）。
因此 DSH 侧边栏「写作助手功能」面板里关闭的工具，在 MCP 侧调用会返回
`错误：工具 novel_xxx（…）当前已在「写作助手功能」UI 中关闭。…`——用 `novel_sentence_config` 或 GUI 重新开启即可。

---

## 4. 工具清单（16 个）

| # | 工具 | 用途 |
|---|---|---|
| 1 | `novel_books` | 列出书库全部作品（章节数、总字数） |
| 2 | `novel_chapters` | 列出某作品全部章节（章号/标题/字数/行数/更新时间） |
| 3 | `novel_read` | 读取章节正文（带行号，可 `offset`/`limit` 分段） |
| 4 | `novel_keywords` | 高频关键词统计（二字/三字词组与英文词） |
| 5 | `novel_new_chapter` | 创建新章节文件（自动附风格基线 μ 摘要与原著锚包） |
| 6 | `novel_import` | 批量导入原稿件（scan 预览 / apply 落盘） |
| 7 | `novel_sentence_analysis` | 句式模式分析（九类句式、转移、节奏、情感曲线、风格指纹） |
| 8 | `novel_sentence_config` | 查看/修改功能开关（enabled / autoAnalyze / 各工具开关） |
| 9 | `novel_style_check` | 章节风格自检（与全书基线对比，输出偏差与锚段） |
| 10 | `novel_plot` | 伏笔/剧情线登记表（open 待回收 / done 已回收） |
| 11 | `novel_settings` | 五张设定表（人物/地点/道具/时间线/世界观用语规范） |
| 12 | `novel_summary` | 章节摘要的增删改查 |
| 13 | `novel_continuity_check` | 连贯性审计（矛盾候选、衔接、OOC、大纲对照） |
| 14 | `novel_semantic_search` | 本地语义检索（embedding，无需关键词） |
| 15 | `novel_style_report` | 风格画像报告（六维基线 + 锚包） |
| 16 | `novel_outline` | 创作资料维护（创作设定/人物/大纲/钩子/状态卡） |

每个工具的 `inputSchema` 就是插件注册时声明的 `parameters`（原样透传，未做任何改写）。

---

## 5. 协议实现

| 方法 | 行为 |
|---|---|
| `initialize` | 返回 `protocolVersion: "2024-11-05"`、`capabilities: { tools: {} }`、`serverInfo: { name: "dsh-novel-writer", version: <package.json version> }` |
| `notifications/initialized` | 通知，无响应（`notifications/cancelled`、`notifications/progress` 等同样静默） |
| `tools/list` | `{ tools: [{ name, description, inputSchema }] }`，共 16 个 |
| `tools/call` | 参数 `{ name, arguments }`；成功 → `{ content: [{ type: "text", text }] }` |
| `ping` | `{}` |
| 未知方法 | JSON-RPC error `-32601` |
| 非法 JSON 行 | 记 stderr 后**忽略并继续**，不会退出 |
| 批量请求（JSON 数组） | 逐条处理并返回响应数组（通知类不产生响应） |

**工具执行出错**（含参数校验失败、书目录不存在等）不会中断进程，也不会返回协议级错误，而是：

```json
{
  "content": [{ "type": "text", "text": "错误：<message>" }],
  "isError": true
}
```

调用不存在的工具名同样返回 `isError: true` 的可读消息（附带工具数提示），避免客户端会话中断。

**输出文本规则**：优先使用插件 `output.render(args, value)` 的返回值——仅当其返回**字符串**时采用；
插件侧 `render` 按 DSH 宿主契约返回 `[{ type: "text", text }]` 数组，此时回退为
`JSON.stringify(value, null, 2)`，即 MCP 客户端收到的是结构化 JSON 文本。

**通道纪律**：stdout 只写 JSON-RPC 帧；启动信息、工具错误堆栈、非法行告警等**全部写 stderr**。
服务器还会把插件内部的 `console.log/info/debug` 改道 stderr 作为兜底保护。

**生命周期**：stdin 关闭 → 等待在途请求完成并冲刷 stdout → `exit 0`；5 秒兜底强制退出。
`unhandledRejection` 只记日志不退出，`uncaughtException` 记日志后退出 1。

---

## 6. 测试

```bash
node --check mcp/server.mjs     # 语法检查
node test/mcp-test.mjs          # 33 项协议/工具断言，exit=0 为通过
```

`test/mcp-test.mjs` 会在系统临时目录里现造一本 2 章的书，`spawn` 真实服务器进程，覆盖：
握手与版本、通知无响应、16 工具清单与 schema 透传、`novel_books`/`novel_read`/`novel_sentence_config` 真实调用、
root 注入与显式 root 优先、工具抛错隔离、未知工具/未知方法、非法 JSON 行容错、stdout 纯净性、stdin 关闭后 exit=0。

---

## 7. 排障

| 现象 | 处理 |
|---|---|
| 工具返回空书库 | 用 `novel_books` 看返回的 `root` 字段是否为目标书库；检查 `--root` 是否写成了 `novels/` 子目录。 |
| `错误：工具 … 当前已在「写作助手功能」UI 中关闭` | 用 `novel_sentence_config` 重新开启，或在 DSH 侧边栏面板打开。 |
| 首次语义检索/风格分析较慢 | `novel_semantic_search` 会加载本地 embedding 模型并建索引，首次调用耗时较长属正常。 |
| 正文乱码 | 章节文件需为 UTF-8；GBK 文件请先转码。 |
| 客户端看不到工具 | 确认 `args` 中 `server.mjs` 为绝对路径、`node` 在 PATH；查看客户端 MCP 日志中的 stderr 输出（应能看到「已注册 16 个工具」）。 |
| Windows 路径报错 | JSON 中反斜杠需转义 `\\`，或直接使用正斜杠 `/`。 |
