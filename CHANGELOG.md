# 更新日志（Changelog）

## [4.1.1] - 2026-09-08

**修复渲染 + 上架官方 MCP Registry**：

- 修复 README.md / README.en.md / mcp/README.md 中代码围栏被误写成单反引号（`` `sh ``）的问题——
  此前安装段与 MCP 段会整段渲染成正文，Release 说明里也出现过同样的 `# MCP 客户端` 巨型标题；
- MCP 启动命令修正为实测可用的 `npx -y -p dsh-novel-writer dsh-novel-writer-mcp`：
  bin 名（`dsh-novel-writer-mcp`）与包名（`dsh-novel-writer`）不同，直接 `npx dsh-novel-writer-mcp` 会 404；
- `mcp/README.md` 去掉测试机器残留的绝对路径示例，改为 npx 与包内路径两种通用写法；
- 新增 `mcpName`（package.json）、`server.json`、`.github/workflows/publish-mcp.yml`：
  用 GitHub OIDC 免密钥发布到官方 MCP Registry，服务器名 `io.github.siweina/dsh-novel-writer`；
- 仓库根目录新增 `smithery.yaml`（供 Smithery 目录直接读取仓库配置收录；该文件随下一个版本进压缩包）。

功能与工具行为无任何变化。

## [4.1.0] - 2026-09-08

**新增：stdio MCP 服务器**——把 16 个工具原样暴露给任何 MCP 客户端（Claude Desktop / Cursor 等），
非 DSH 用户也能用。本地进程、零依赖、零联网，书库路径支持 --root / DSH_NOVEL_WRITER_ROOT / cwd。

- 新增 `mcp/server.mjs`（手写 JSON-RPC 2.0，stub ctx 启动插件并捕获 16 个工具定义）；
- 新增 `mcp/README.md`（客户端配置示例、工具清单、环境变量）；
- 新增 `test/mcp-test.mjs`（35 项断言：握手 / 工具列表 / 真实调用 / 错误隔离 / stdout 纯净）；
- package.json 增加 `bin.dsh-novel-writer-mcp` 与 files 中的 `mcp`；
- README 首屏重写（定位「给网文作者的本地章节体检」、痛点对照表、真实输出示例、对比表）。

验证：mcp-test 35/35；既有四套测试全绿；AST 扫描 0 语法错误 / 0 未定义引用。

## [4.0.1] - 2026-09-08

本版本为 **DSH STORE 上架契约合规版本**，不改变任何功能行为：

- manifest 补齐 repository / homepage / bugs，指向 canonical GitHub 仓库；
- 声明 DSH 兼容范围 dsh.engines.dsh = ">=0.1.1-rc.2"（Node 兼容沿用 engines.node）；
- 两个超出商店单文件上限（262144 字节）的数据文件改为 gzip 随包分发、加载时解压：
  tokenizer.json 439125 → 105433 字节；dutir_seven.json 382936 → 157713 字节；
- lib/index.js（299570 字节）拆分为 lib/index.js（166460）+ lib/core.js（123353）：
  仅移动声明与调整导入导出，16 个工具、2 个提示词段、5 条路由与全部行为逐字不变；
- README / README.en 补充「依赖、权限与失败边界」章节（运行时依赖、外部服务、权限边界、失败降级）。

验证：四套测试全绿；AST 扫描 0 语法错误、0 未定义引用；拆分冒烟 16 工具 / 2 段 / 5 路由 / 工具可调用。

## [4.0.0] - 2026-09-08

本次为**全量缺陷整修版本**。基于对 v3.9.5 的逐行审计（11 份报告、约 216 条问题），
按"致命缺陷 / 统计口径 / 死代码 / 性能 / 浏览器端 / 测试与发布"六组全部修复，
并追加完成原"已知限制"中的 4 项；四套自带测试由"假绿"升级为真实断言并全部通过。

### 一、修复统计

| 范围 | 负责范围 | 修复处数 |
|---|---|---|
| 致命缺陷组 | analysis.js / index.js / embedding.js / client.js | 17 |
| analysis.js + vibe.js + style-metrics.js | 统计口径 / 死代码 / 性能 / DUTIR | 28 |
| index.js | 口径 / 死代码 / 性能 | 41 |
| embedding.js + update-check.js | 索引缓存 / 语义引擎 / 更新检查 | 17 |
| client.js | 浏览器端缺陷 / 死代码 / 性能 | 33 |
| test/*.mjs + release.yml + SKILL.md | 测试加固 / CI / 文档 | 25 |
| 追加修复（第二轮） | vibe.js / analysis.js / index.js | 4 项 |
| 跨区域裁决 | prompts.js 语义对齐、版本号、收尾 | 5 |
| **新增功能** | 系统提示词三档开关（关闭/精简/完整） | index.js / client.js / prompts.js |
| **合计** | | **约 170 处** |

### 二、致命缺陷（会直接产出错误结果）

1. **情感否定把"别"当否定词**（analysis.js）：特别高兴/特别害怕 被整词丢弃。修后
   特别高兴 joy 0 → 1.5，别害怕 仍正确判为否定。
2. **祈使句判定误伤**（analysis.js）：裸 /吧/ 与硬词表无边界，酒吧/别人/马上/快乐/滚烫/莫大
   全被判祈使，导致句式分布与六维基线失真。修后误判归零，请坐/快睡吧/别走/站住 仍正确。
3. **情感曲线尾部伪造全零段**（analysis.js）：25 段文本 20 分段时出现 7 个 intensity=0 的
   "假平缓段"。修后 0 个。
4. **novel_settings 列表永远显示人物卡**（index.js）：按 category 取对应表。
5. **brief 报告输出"推荐容差 undefined%"并谎报 μ=0**（index.js）：空基线时走"测量不可用"分支。
6. **findChapter 子串回退读错章**（index.js）：findChapter("1") 不再命中第 10/11/12 章。
7. **章节号解析**（index.js）：书名-01 / 书名 07 / 第一千零一章 均可解析（1 / 7 / 1001）。
8. **嵌入降采样维度与落盘声明脱钩**（embedding.js）：非 512 维输入落盘后缓存被判损坏、
   每次全量重建。修后任意输入归一到 128 维且回读正常；落盘改用 MODEL_NAME / EMBED_DIM 常量。
9. **组合情感标签 3/7 永不命中**（analysis.js）：键序统一后"又爱又恨/哀怒交加/惊喜交加"可达。
10. **String.replace 替换串未转义**（index.js）：设定/钩子文本含 $& 时旧段被复制，改为函数式替换。
11. **baseline: null 违反输出 schema**（index.js）：改为空对象，避免宿主拒绝整次调用。
12. **数字口径两两配对**（index.js）：归一化后只对"同值不同写法"生成候选，并限 20 条。
13. **-0 触发宿主 lossless JSON 拒绝**（index.js / analysis.js）：输出统一过 cleanOutput、
    round() 归一化负零，工具不再"首次失败、重试成功"。
14. **浏览器端 rev 竞态**（client.js）：update-check 后台写入不再参与竞态计数，
    已关闭的开关不再被显示为"全部开启"。

### 三、统计口径（节选）

- 效价词表嵌套双计（悲痛欲绝 negWords 2 → 1）；隐性载体跨表/表内重叠双计（细雨 0.6 → 1）。
- implicit 单位混用（加权和与次数相加）：ambiguousRatio 0.27 → 0.13，另存 weightedTotal。
- topWords 未做否定过滤（害怕 count 2 → 1）。
- chapterDrift 改按章计算（meanEntropy 0 → 0.347，swinging 正确为 true；单章回退段级并标 basis）。
- 句长双口径对齐（10/24/40）；top 参数钳制（-1/0 → 返回最高频 1 条）。
- 截断采样口径统一（intensity 18.18 → 181.82，与单独分析一致）。
- "不太高兴"极性修正（joy 0.6 → 0）；弱副词不再覆盖强副词。
- 烛火 fragile 生效；"震惊"原型补映射（契约告警消失）。
- 单字词条（谜/抚）参与计分；容差 0/null 语义区分；留白指数量纲校准（112.5 → 93.75）。
- DUTIR 兜底由"仅二字组"改为 2–4 字最长优先 + 区间消费（3–4 字词命中 9/40 → 39/40，二字词无退化）。

### 四、死代码与无效代码

- 删除零调用函数：embedding.js 的 loadIndex / reset，analysis.js 的 matchAmbiguousCarriers /
  dutirEmotionOf；删除 semResolver 死分支、global 恒真分支、恒真/恒假条件多处。
- 删除未使用导入（writeFileSync / sep / statSync）、未使用变量（effective / now / ch）、
  未使用 catch 绑定、重复 engine 字面量、多余导出（embedding 导出精简为 13 个）。
- 修复 DUTIR 63% 词条不可达、单字词死词条、3 条不可达标签、无效兜底、恒真守卫等"看着没问题
  实则无效"的代码。

### 五、性能

- 词表扫描改单遍位图：4 万字 32.7ms → 4.3ms（7.6×，等价性 54 组 0 差异）。
- 语义结果命中路径回写缓存：第三次命中 934ms → 1ms。
- 六维测量缓存改为章序无关：style_report / style_check / new_chapter 互相命中。
- plot scan 预计算 plotKeywords；大纲模式不再全书读两遍；enabled=false 提前返回（300 章 26ms → 2ms）。
- GET /state 改异步遍历；densityOf 正则提升到模块级（127ms → 45ms）；原型向量缓存（544ms → 1ms）；
  嵌入张量改 subarray（8.24ms → 0.03ms）；失败负缓存（更新检查不再重复打 GitHub）。

### 六、浏览器端（client.js）

侧边栏入口挂载守卫与插入锚点、refresh 竞态、保存回写守卫、宿主错误信息透传、
saveFailed 清理、删除按钮条件、容差提示文案、工具计数与列表同源、useEffect 依赖、
observer 生命周期、createRoot 泄漏、setTimeout 清理等 33 处。

### 七、测试与发布流程

- 测试断言真实化：unit 14 → 20 条并落退出码；pattern 相似度检查真正生效；client 真正挂载 DOM；
  e2e 补 required/调用点断言、schema 校验器补 5 类宿主规则、状态隔离防回归、import apply 写盘路径、
  enabled=false 双行为、插件运行期告警即失败。
- release.yml：打包排除 node_modules（发布包体积 47MB → 约 17MB）；push（所有分支）与 PR 均跑测试，
  发布 job 用 needs: test 卡住；删除过时排除项。
- SKILL.md / prompts.js 补正"总开关 enabled=false"的准确语义（analysis 返回禁用桩、style_check 抛错）。

### 八、追加修复（第二轮，同日）

1. **题材联动门控补全**（vibe.js）：原门控只对噩梦轴生效，且用"累计归一化分"判定——通用信号
   （疑问句、雨、哈哈等）也会让 6 个轴白拿题材加成；另一侧有实词证据时反而漏给。现改为
   push 增 isEvidence 标记 + AXIS_EVIDENCE_WORDS 内容证据词表 + evidenceBase 门控。
   实测：纯标签 6/6 不联动；通用信号修前 6/6 白给 → 修后 0/6；有正文实词 6/6 联动；
   单提 1 词不触发、2 词起生效；各轴分数与修前逐位一致、无 NaN。
2. **情感词"套娃"重复计数**（analysis.js）：emotionOf 主词表改"最长匹配 + 区间消费"。
   实测：悲痛欲绝 sorrow 2 → 1、咬牙切齿 anger 2 → 1、特别悲痛欲绝 3 → 1.5；
   高兴/不太高兴/别害怕/副词强弱/否定/DUTIR 全部无回归。
3. **风格报告语义结果写回缓存 + 锚包全书等距抽样**（index.js）：
   - 语义隐性情感与歧义裁决结果写入分析缓存（含全书内容指纹），命中即复用。
     实测：第 1 次 4834ms → 第 2 次 6ms（约 805×），缓存文件含 semanticImplicit / semanticFp / implicitResolved。
   - 锚段与句式骨架改为全书等距抽样（旧版从开头顺序取）。实测 30 章书：锚段来源章 [1, 28, 14]，
     覆盖首章与中后段；条数契约（对话 2 / 心理 1 / 描写 2、骨架 4）不变。
4. **段落结构补"叙述"桶**（analysis.js + index.js）：新增 paragraphs.narrationOnly，
   使 dialogueOnly + psychologyOnly + mixed + narrationOnly === total 恒成立；
   output schema 同步新增该字段（严格模式），渲染改为"段落结构: 共 N 段（对话 X / 心理 Y / 混合 Z / 叙述 W）"。
   实测 61 段：60 混合 + 1 叙述 = 61。
5. **rawWriting 默认值三方不一致**（index.js）：featureEnabled() 对缺键一律返回 true，
   与 FEATURE_DEFAULTS.rawWriting = false 矛盾，导致 novel_sentence_config 工具在用户从未开启时
   谎报 rawWriting: true（UI 与提示词注入门控都按 false 处理）。实测：空状态由 true → false；
   显式开启 → true 且提示段注入 150 字符；再关闭 → false 且不注入；其余默认仍为 true。

### 九、新增功能：系统提示词三档开关（关闭 / 精简 / 完整）

侧边栏首页新增一个三档分段按钮，控制插件往系统提示词里注入多少内容（沿用 DSH 官方"动态 section"写法，
参照 yexi-by/dsh-unrestricted 与 masknull/dsh-session-prompt）：

| 档位 | 注入内容 | 实测长度 |
|---|---|---|
| 关闭 | 完全不注入（返回空串，DSH 自动丢弃该段） | 0 字符 |
| 精简（默认） | 一句话：有 novel_* 工具、详情见 novel-writing 技能 | 134 字符 |
| 完整 | 原 v3.9.5 的完整工作流说明（行为不变） | 2437 字符 |

- 档位保存在插件 state 文件（与其它开关同一份），GET/POST /api/dsh-novel-writer/state 读写；
  非法值一律忽略并回退"精简"；无 state 文件时默认"精简"。
- 组装提示词时实时读取，**改完下一轮对话即生效**，无需重启。
- 与"总开关 enabled"互不干扰：总开关管工具与句式分析，本开关只管系统提示词注入量。

### 十、行为变更与升级注意

1. **统计口径变更会导致旧缓存失效**：analysis 报告、风格画像、语义索引会在升级后首次调用时重建
   （语义索引因 chunkText 分块修正必然重建一次）。旧缓存文件不会被自动删除，只失效。
2. 插件版本号由 3.9.5 → 4.0.0，缓存键随之更新（PLUGIN_VERSION 取自 package.json）。
3. 发布包不再包含 node_modules（依赖按 README 说明自动安装）。
4. 题材联动、情感计数、段落结构三项的口径变化会让同一本书的新旧报告数值不完全可比，
   建议升级后重新生成一次基线。
5. **系统提示词默认档位为"精简"**：升级后每轮上下文里只多一行字（134 字符），不再是原来的 2437 字符；
   需要完整工作流说明的人，请在侧边栏首页把开关切到"完整"。

### 十一、已知限制（保留）

- 题材证据词表（AXIS_EVIDENCE_WORDS）为启发式，可能漏词或误命中，扩展只需改该表。
- 语义缓存的指纹不含模型/引擎版本；跨进程同时写同一本书的分析缓存时后写覆盖（原子 rename 不损坏）。
- 锚包按段落下标均匀抽样，长章节权重略高；骨架分类规则未动。
- narrationOnly 取"余项"口径（若坚持"仅全陈述句段"会破坏四类合计恒等式）。
- 引号内弱心理标记（明白/觉得）会把整句归为心理；isImperative 每句重建正则（微秒级）。

### 十二、验证结果

- 四套测试：unit 20/0（exit 0）、pattern ALL PASSED（exit 0）、client CLIENT OK（exit 0）、
  e2e ALL E2E TESTS PASSED（exit 0）。
- AST 全量静态扫描：0 语法错误、0 未定义引用；死代码项 44 → 22（剩余为跨文件使用的导出）。
- 针对性探针：原 13 项回归全过 + 追加 4 项前后对比全过（门控矩阵 6/6、嵌套双计 2→1、
  缓存 805×、锚段覆盖首章与中后段、narrationOnly 恒等式成立）。
- 系统提示词三档开关：实测 off=0 字符 / brief=134 / full=2437（与旧版逐字节一致）；
  GET 与 POST /state 读写正常，非法值被忽略；切换后 section 立即生效；client-test 真实挂载面板通过。
- 改动范围：16 个文件（lib 10 + 测试 4 + release.yml + SKILL.md + package.json + cordis.patch.yml）
  + 新增 CHANGELOG.md；node_modules 未改动；文件总数与 v3.9.5 一致（1234 + CHANGELOG）。

### 十三、审计与修复报告索引

F:\doment\_audit\ 下 11 份审计报告 + 7 份修复报告：
analysis-1/2.md、embedding.md、index-1/2/3/4.md、client-1/2.md、cross.md、tests.md、
fix-A-analysis.md、fix-B-index.md、fix-C-embedding.md、fix-D-client.md、fix-E-tests.md、
fix-P-A.md、fix-P-B.md。
