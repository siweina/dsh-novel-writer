# dsh-novel-writer v0.2.0 — 跨设备安装指南

本目录是一个**完整的、自包含的插件分发件**，零第三方依赖（仅 Node 内置模块）。
将其复制到任何安装了 DSH（DeepSeek Harness）的设备即可使用，无需联网下载任何依赖。

```
dsh-novel-writer-v0.2.0/
├── lib/index.js           # 插件本体（含全部修复，见下文"版本记录"）
├── package.json           # 包定义（bundle patch 指向 cordis.patch.yml）
├── cordis.patch.yml       # 挂载插件到 loader 树
├── README.md              # 功能与工具说明
└── skills/
    └── novel-writing/
        └── SKILL.md       # 可选：小说写作技能（增强 AI 工作流）
```

---

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

3. 重启 web 应用，`novel_*` 系列工具即会注册到会话。

> 插件的 `cordis.patch.yml` 由 bundle 自动应用（`package.json` 中
> `dsh.bundle.patch` 已声明），无需手动往 profile 的 patch 文件里加条目。

## 二、（可选）安装技能 SKILL.md

技能用于增强 AI 的小说写作工作流提示（与插件工具配合使用）：

- 把 `skills/novel-writing` 整个文件夹复制到工作区的 `.dsh/skills/` 下：

  ```
  <工作区>/.dsh/skills/novel-writing/SKILL.md
  ```

- 新会话中即会出现 `novel-writing` 技能。

## 三、准备章节库

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

## 四、验证安装

安装并重启后，在会话中应能看到以下工具：`novel_books`、`novel_chapters`、
`novel_read`、`novel_keywords`、`novel_new_chapter`。可先执行 `novel_books`
确认能列出书库。

若 `root` 需要指向其他目录（默认会话工作区），在 profile 的
`cordis.patch.yml` 中覆盖：

```yaml
- patch:
    - id: novel-writer
      config:
        root: 'D:/我的小说库'
```

---

## 版本记录

### v0.2.0（本分发件）
- **修复**：章节序号提取支持任意位置（含中文数字"第一章/第十四章/第三十章"），
  修复 `原稿件-单章-…第N章` 命名下章号全部丢失、排序混乱、
  `novel_read(book,"1")` 误命中"第31章"、`novel_new_chapter` 自动取号错乱的问题。
- **新增**：文件编码自动探测（UTF-8 / UTF-16 LE/BE / GBK），
  修复 UTF-16/GBK 章节文件读取乱码与字数统计错误的问题。
- 通过 37 章全量压力测试（463,475 字 / 13,231 行，全书读取+关键词统计 < 200ms）。

### v0.1.0（初始）
- 章节库管理：novel_books / novel_chapters / novel_read
- 分析：novel_keywords（中文二字词组 + 英文词）
- 续写：novel_new_chapter（自动取下一个章号）
