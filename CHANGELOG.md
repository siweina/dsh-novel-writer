# 📦 dsh-novel-writer 更新日志 — v3.9.5

> 发布日期:2026-09(桌面构建)
> 本版为 **3.9.1 → 3.9.5 的缺陷整修版**:对 7 路代码审查(约 81 项确认缺陷)做了全量修复与回归验证。同步产物:`dsh-novel-writer-v3.9.5.zip`(含 node_modules,解压即用)。

---

## 🔴 高危修复(6)

1. **H1 · schema 契约**:`novel_sentence_analysis` 关闭分支缺少 output schema 必填的 `totalChars`(此前渲染会出现“共 undefined 字”,严格宿主会拒绝该输出)。现在关闭时返回 `totalChars: 0`,并修正了与之矛盾的注释。
2. **H2 · 功能不可达**:`novel_settings` 的参数 schema 补齐 `bannedWords`(禁用词表)与 `recommended`(替代词映射)。此前模型按 SKILL.md 登记世界观词表必被参数校验拒绝,execute 中对应分支是死代码;e2e 亦改为真实路径验证。
3. **H3 · 测试安全**:`e2e-test.mjs` 退出处理器原先指向用户**真实** `~/.dsh/dsh-novel-writer/state.json`(env 隔离晚于路径解析),可能写回/删除真实配置。现改为:先隔离 env、测试根目录移入系统临时目录、退出时清理临时目录。
4. **H4 · 切句错误**:`style-metrics.js` 切句把连续句末标点拆成孤立“标点句”(`太好了！！！` 曾计 3 句)。现在连续终止符合并为一句,并过滤纯标点残片;与 analysis 引擎口径对齐。
5. **H5 · 意象双计**:`analysis.js` 隐性意象“变色龙词+单方向词”重叠双计(细雨+雨、灯火+灯、苦笑+笑 曾各计两条)。已按区间去重,极性/总量不再虚高。
6. **H6 · 量纲混算**:`resolveAmbiguousCarriers` 曾把 0~1 占比当“次数”与歧义词数量直接相加归一(100 正+1 负判可把负向抬到 33%)。现基于上游新透出的 `negHits/posHits/ambHits` 加权计数重算。

## 🟠 中危修复(26)

- **语义开关一致性**:`novel_style_report` 的意象裁决与语义风格距离补 `semanticImplicit/semanticStyle/semanticEmbedding` 门控(此前 UI 关闭后仍跑 embedding);`novel_settings detect` 路径同步。
- **缓存残留**:语义隐性情感在功能关闭/引擎不可用时会被清除并写回缓存,不再把旧(越界)结果原样返回。
- **世界观语用**:`bannedWords` 与 `speechStyle` 各自取“最近登记且含该字段”的条目(不再被后登记的 speechStyle 遮蔽);“语用冲突”detail 不再渲染 `undefined` 文化名;自动语用规范合并为单一判定(消除“中世纪”被裸正则误判 + 双块互覆);中式默认规范不再误报“XX小姐”。
- **编码探测**:无 BOM 的 UTF-16(含纯 ASCII)先做 NUL 分布探测,不再被严格 UTF-8 静默误收。
- **分析缓存**:缓存键纳入 `top/maxSentences/curveSegments/enabled/autoAnalyze`;指纹由 stat(mtime+size) 升级为“每章前 8KB 内容哈希+大小”。
- **并发**:`novel_new_chapter` 用 `wx`(O_EXCL)原子写入防同号互相覆盖;伏笔/摘要/设定三张表“读-改-写”按文件事务化(`withFileTx`),并发不再整表覆盖丢更新。
- **timeline 语义**:update/delete 定位与改名说明写入 schema 与错误提示(改名前置 name=旧标识 + day=新标识)。
- **settings scan**:按 category 真正分派(人物/地点/道具候选),不再任何类别都只回“人物候选”。
- **语义对比采样**:style_check 的基准向量由 `slice(0,20)`(只看开头)改为全书等距抽样。
- **语义检索缓存文本**:落盘截断 120→200 字,与首次构建结果一致。
- **仪式用语正则**:补正确量词“炷”与“两”(`上炷香/上两炷香` 此前全部漏检),兼容“柱”笔误。
- **称谓扫描**:仅当规范明确禁用“小姐”(如“不用'小姐XXX'式”)才扫描 XX小姐。
- **版本比较**:剥离 semver `+build` 元数据(`1.0.0-rc.1+build.5` 不再误判比 `1.0.0-rc.1` 新)。
- **依赖漂移**:node_modules 的 onnxruntime-web 由 `1.26.0-dev.20260416` 对齐回 lock 的 **1.24.3**(npm install + prune 已执行,本地=CI 环境)。
- **嵌入健壮性**:embedMany 失败块自动重试一轮;降采样抽为共享函数并做 L2 重归一;缓存逐向量校验长度;引擎失败 30s 冷却自动重载(不再“粘性”永久降级)。
- **vibe 数据源**:dark/fight 词群改为直扫正文(原先扫文化词表,交集基本为 0,属死路径)。
- **客户端竞态**:初次 load() 接入 rev 守卫(慢 GET 不再覆盖用户刚切的开关);保存成功后回读宿主完整 next(tools/features/容差/设定);报告读取 catch 补请求序号守卫;面板容器重建前先 unmount 旧 React root(修订阅泄漏)。
- **连续标点/文末空行/否定词/采样**:analysis 的 splitBlocks 文末空行判定修正;否定处理统一(不要/不再/不是/丝毫不等双三字前缀,主表/DUTIR/valence 三处共用;`不开心。` 不再计 +0.7);maxSentences 截断时在 guidance 中明示采样提示。
- **README/CI 相关**:release workflow 说明见“已知取舍”;包内不再含 extraneous 依赖。

## 🟡 低危修复(23)

- 删除死代码:死 import `CATEGORY_LABELS` 转为实际复用(本地 TYPE_CODE 重复定义删除);`metricBaseline`/`lastSettingName` 死变量;`cjkChars` 只写不读的单字统计;`QUESTION_WORDS`;`if(false)` 分支;`formatRead` 不可达 else-if;Map 恒真 `a!==b` 判断;`HEDGE_SET`;`EMOTION_EXCLUDE` 失效表(词表无单字词);vibe 未用 `C`/`absurd`/`blaze` 信号;死文案 `emotionDeep/styleDetect`;只写不读的 `reportLoading`。
- 功能修复:`numberToCjk` 支持到 9999(100~9999 不再拼“undefined十”);导入重名兜底不再产生同章号文件(空格/长横分隔名与中文章号>99 场景);`novel_summary delete` 不存在时如实报错不再空写盘;`normalizePlotEntry` 时间字段不再让 null 穿透 schema;`cleanOutput` 补 Date/Map/Set/RegExp/NaN 处理;brief 命中/未命中文案抽公共函数保持一致;style_report schema 声明 baseline/brief/anchors/skeletons;`readSentenceStateSync` 与异步版结构对齐(补 styleTolerance)。
- 分析引擎:祈使句判定重写(`别走。/请坐。/别走！/站住！` 正确归类,感叹不再抢占);第一人称补计 俺/咱;五感词去重(冷热凉暖烫只归温度通道);修饰密度排除名词“地”(原地/当地/土地 等不再当状语);style-metrics 剥 Markdown 标题行(与 analysis 口径一致)。
- 客户端:设置页卡片与 applied 防重入补说明注释(宿主契约依赖见“已知取舍”)。

## ⚪ 提示级处理与说明(设计取舍,非缺陷)

- 版本号统一 3.9.5:package.json / package-lock(根与 packages[""])/ cordis.patch.yml / lib 头注释;历史修复注释保留原版号不改写。
- `updated` 时间戳按 UTC 展示(UTC+8 早晨修改会显示前一天)——产品既有设计,未改。
- 语义检索恒返回 top-k、无最低分阈值——有意设计,如需可后续加 score 下限开关。
- 预发布与同号正式版视为同版本(beta→正式不提示升级)——沿用既有设计注释。
- `settings.plugin.item` 卡片为 keyed slot:是否渲染取决于宿主 settingsScope 是否登记 `novel-writer-config`;未实现时仅侧边栏入口生效。
- client `applied` 防重入依赖宿主 module materialize 语义(HMR disable→enable 需宿主重载模块)。
- embedding 512→128 为“每 4 维取 1”的有损降采样(缓存体积优化),未声明信息量保证;运行期已自洽。
- zstd 压缩实为 Node ≥23.8 引入:22.3–23.7 自动回退纯 JSON 缓存(安全),注释已修正。
- 部分导出(embedding 的 loadIndex/cachePath/textHash 等)无仓库内消费方——作为公共 API 保留。
- e2e/unit/pattern 已补充大量回归断言(连续标点、否定、祈使、意象权重、schema、disabled 契约、brief 一致性、语用 undefined、scan 分派等)。

## ✅ 验证结果(全部通过)

| 项目 | 结果 |
|---|---|
| `node test/unit-test.mjs` | 14 通过 / 0 失败 |
| `node test/pattern-test.mjs` | ALL PATTERN TESTS PASSED |
| `node test/client-test.mjs` | CLIENT OK |
| `node test/e2e-test.mjs` | ALL E2E TESTS PASSED(16 工具 + 新增 3.9.5 回归) |
| 模块加载 | index/embedding/vibe/analysis 等全部正常;embed 512 维、norm=1.0 |
| onnxruntime-web | node_modules = lock = 1.24.3 |
| 打包 | `dsh-novel-writer-v3.9.5.zip`(含 node_modules)1242 项,内 package.json version 3.9.5 |

> 备份:修复前原版源码保存在 `F:\doment\_bak-dsh-3.9.1`(27 个文件),如需对照可自行查看。
