# dsh-novel-writer v0.3.0 — 跨设备安装指南

本目录是一个**完整的、自包含的插件分发件**，宿主端零第三方依赖（仅 Node 内置模块），
浏览器端仅依赖 Web GUI 自带的 react。将其复制到任何安装了 DSH 的设备即可使用。

```
dsh-novel-writer-v0.3.0/
├── lib/
│   ├── index.js        # 宿主端插件本体（novel_* 工具 + state 路由）
│   ├── analysis.js     # 句式模式分析引擎（零依赖）
│   └── client.js       # 浏览器端（侧边栏「句式分析」开关面板）
├── package.json        # 包定义（bundle patch + dsh.client 声明）
├── cordis.patch.yml    # 挂载插件到 loader 树
├── README.md           # 功能与工具说明
└── skills/
    └── novel-writing/
        └── SKILL.md    # 可选：小说写作技能（含句式分析工作流）
```

## 一、安装插件

### 方式 A：dsh CLI（推荐）

把整个文件夹放到目标设备的任意位置（例如 `D:/tools/dsh-novel-writer`），然后：

```sh
dsh plugin --profile web add D:/tools/dsh-novel-writer
```

### 方式 B：手动等价操作

1. 把本文件夹（或链接）放入 profile 的 `node_modules`：

   ```sh
   # 在 <DSH_HOME>/profiles/<profile名> 目录下
   npm install D:/tools/dsh-novel-writer
   # 或手动建立 junction 链接（Windows）：
   # mklink /J <profile>\node_modules\dsh-novel-writer D:/tools/dsh-novel-writer
   ```

2. 编辑该 profile 的 `package.json`，在 `dsh.profile.bundles` 数组中加入：

   ```json
   "dsh-novel-writer"
   ```

3. **重启 web 应用**。宿主端注册 `novel_*` 系列工具（含新增的 novel_sentence_analysis / novel_sentence_config）
   与 `/api/dsh-novel-writer/state` 路由；浏览器端加载 client half，侧边栏出现「句式分析」入口。

> 插件的 `cordis.patch.yml` 由 bundle 自动应用（`package.json` 中 `dsh.bundle.patch` 已声明），无需手动往 profile 的 patch 文件里加条目。

## 二、（可选）安装技能 SKILL.md

把 `skills/novel-writing` 整个文件夹复制到工作区的 `.dsh/skills/` 下：

```
<工作区>/.dsh/skills/novel-writing/SKILL.md
```

新会话中即会出现 `novel-writing` 技能（含句式模式分析工作流）。

## 三、UI 开关（v0.3.0）

Web GUI 侧边栏会出现「句式分析」入口，点击打开面板：

- **启用句式分析（enabled）**：关掉后 `novel_sentence_analysis` 返回"已关闭"状态；
- **自动分析（autoAnalyze）**：关掉后 AI 仅在用户明确要求时使用句式分析。

状态实时写入宿主端 `~/.dsh/dsh-novel-writer/state.json`；
也可在对话中让 AI 执行 `novel_sentence_config` 查看/修改。若浏览器无法访问宿主端路由
（例如未重启/非 web 环境），开关降级保存在浏览器 localStorage，并以提示文字告知。

## 四、准备章节库

章节库存放于**会话工作区**（或插件 config `root` 指定的目录）下的 `novels/` 文件夹：

```
<工作区>/novels/<书名>/
├── 第01章.md          # 或 .txt / .markdown
└── 原稿件-单章-…第一章.txt   # 序号在任意位置、中文数字均可识别
```

支持的文件命名与编码：

- 章号任意位置：`第01章.md`、`01-标题.md`、`原稿件-单章-…第一章.txt`、`原稿件-单章-第25章 .txt`
- 阿拉伯数字 + 中文数字（第一章/第十四章/第三十章），自动按章号排序
- 编码自动探测：UTF-8（含/不含 BOM）、UTF-16 LE/BE（含 BOM 或启发式）、GBK/GB18030（无 BOM）

## 五、验证安装

安装并重启后，在会话中应能看到以下工具：`novel_books`、`novel_chapters`、
`novel_read`、`novel_keywords`、`novel_new_chapter`、`novel_sentence_analysis`、
`novel_sentence_config`。可先执行 `novel_books` 确认能列出书库，再执行
`novel_sentence_analysis` 验证句式分析。

若 `root` 需要指向其他目录（默认会话工作区），在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- patch:
    - id: novel-writer
      config:
        root: 'D:/我的小说库'
        sentenceAnalysis:
          enabled: true
          autoAnalyze: true
```

---

## 版本记录

### v0.3.0（本分发件）
- **新增**：句式模式分析引擎（lib/analysis.js）：陈述/对话/心理/疑问/反问/感叹/祈使/省略留白 的分布、
  排列规律（转移/模板/段首段尾）、句长节奏、情感曲线（喜/怒/哀/惧/惊）与风格指纹；
- **新增**：novel_sentence_analysis / novel_sentence_config 工具；
- **新增**：Web UI 开关（侧边栏「句式分析」面板，client half）+ 宿主端 /api/dsh-novel-writer/state 路由；
- 更新系统提示词与 SKILL.md 的句式分析工作流。

### v0.2.0
- 修复章节序号提取（任意位置、中文数字）；UTF-8/UTF-16/GBK 编码自动探测；37 章全量压力测试通过。

### v0.1.0
- 章节库管理、novel_keywords、novel_new_chapter。
