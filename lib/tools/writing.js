/**
 * dsh-novel-writer — lib/tools/writing.js（建章、开写包、草稿镜像、大纲与必用词表工具）
 */

import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { computeBaselineFromPerChapter, METRIC_LABELS, METRIC_ORDER } from "../style-metrics.js";
import { RAW_MODE_HINT } from "../prompts.js";
import { buildChapterBrief } from "../brief.js";
import { checkPlanFulfillment, diagnoseChapterSymptoms } from "../chapter-diagnose.js";
import { SINGLE_CLAUSE_STEP_HINT } from "../obligations.js";
import { logEvent } from "../log.js";
import { assert, assertToolEnabled, atomicWriteJson, auditLexicon, bookDir, buildStyleAnchorPackage, CHAT_PROMPT_THRESHOLD_CHARS, cleanOutput, createOutlineTool, extractKeywords, featureEnabled, findChapter, GLOBAL_LEXICON_BOOK, groupLexiconByKind, isAbort, isInsideBookDir, LEXICON_KINDS, lexiconEntryLine, lexiconFile, MAX_CHAPTER_NUMBER, mergeLexiconEntries, metricChaptersCached, normalizeLexiconEntry, normalizeLexiconList, noteRoot, optionalInt, optionalString, parseLexiconLine, readBookAllText, readLexicon, readLexiconFile, readSentenceState, readTextFile, requiredString, resolveBaselineScope, resolveDraftTarget, resolveRoot, sanitizeSegment, scanChapters, withFileTx, writeLexicon } from "../core.js";
import { dropNullDeep, isLeanWorkflow } from "./shared.js";

/**
 * v5.0.0：把章节标题清洗成可安全入文件名的片段（novel_new_chapter 用）。
 * 走 sanitizeSegment（剥路径分隔符/Windows 保留字符/首尾点与空格，保留名加下划线），
 * 再限长 24 字——文件名只是给人和 findChapter 用的标识，过长反而难读。
 * 标题全是非法字符时返回空串，退回不带标题的文件名，**不因此拒绝创建章节**。
 */
function safeTitleSegment(title) {
  try {
    // v7.3.0 修正（真实数据暴露）：模型常把「第03章」写进 title，而文件名前面已经拼了章号，
    // 于是出现「第03章 第03章 证词里的空白.md」。这里先把开头那种「第N章」剥掉再清洗。
    const stripped = String(title).replace(/^\s*第\s*[0-9〇零一二三四五六七八九十百千两]+\s*章\s*[：:、.．\-—－_]*\s*/, "").trim();
    if (stripped === "") return "";  // 标题只有章号 → 文件名不带标题，也不重复
    return sanitizeSegment(stripped, "title").slice(0, 24);
  } catch {
    return "";
  }
}

function registerNovelNewChapter(ctx, config) {
  ctx.tools.register({
    name: "novel_new_chapter",
    description: "创建新章节文件(默认下一章)。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名" },
        chapter: { type: "integer", description: "章号" },
        title: { type: "string", description: "标题" },
        // v7.0.0（v2.1 模块 4）：动笔前的具象计划。**排在 content 之前**是经验做法
        //（多数模型按 schema 顺序生成参数，计划先落笔会形成"自我承诺"）；它不是协议保证，
        // 即使模型把它生成在 content 之后，兑现核对照样工作，只是承诺效应弱一些。
        // **绝不写入正文文件**：只用于写盘后的兑现核对。
        plan: { type: "string", description: "写前具象计划(器物/动作/落点，不入正文)" },
        content: { type: "string", description: "初始正文" },
        root: { type: "string", description: "书库根" }
      },
      required: ["book"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          book: { type: "string" },
          number: { type: "integer" },
          file: { type: "string" },
          path: { type: "string" },
          chars: { type: "integer" },
          // v3.7.0：强制风格基线——创建章节时自动附全书六维基线摘要（模型动笔前必得数据）
          baseline: { type: "string" },
          // v6.5.5：基线范围披露（按全书 / 自定义 N 章）。**必须登记**：本输出 additionalProperties:false，
          // 多返回一个未登记字段会被严格校验的宿主整条拒收。
          baselineScope: { type: "string", description: "上面 baseline 摘要的取样范围（按全书 / 自定义基线 N 章；选择全部失效回退时文案里会注明）" },
          baselineMode: { type: "string", enum: ["all", "custom"] },
          reminder: { type: "string" },
          // v3.8.0：风格锚包——原著代表性段落 + 句式骨架（照样例写，数字只做校验）
          anchors: { type: "array", items: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, text: { type: "string" } }, required: ["label", "text"] } },
          skeletons: { type: "array", items: { type: "object", additionalProperties: false, properties: { type: { type: "string" }, text: { type: "string" } }, required: ["type", "text"] } },
          // v6.9.0：非净化模式提示（开关打开时才有；关闭时该键不存在）
          rawMode: { type: "string", description: "非净化模式开启时的写作约束（与开写包的【非净化模式·目标带】同源）；关闭时该键不存在" },
          // v7.0.0（v2.1 模块 6）：写盘即时体检——**零额外调用的触点**。
          // 事后审计（style_check / fix_plan）在默认工作流里很少被主动调用（v5.0.0 降本），
          // 所以把最要紧的几条结论挂到"本来就会被模型看到"的建章返回里。
          postWriteAudit: { type: "array", items: { type: "object", additionalProperties: false, properties: { key: { type: "string" }, severity: { type: "integer" }, title: { type: "string" }, detail: { type: "string" } }, required: ["key", "severity", "title", "detail"] }, description: "v7.0.0 写盘即时体检（最多 5 条，按严重度降序）：未兑现的 plan 子句 / 章末升华 / 连续站桩对话 / 高频套话。只告警、不阻断保存" }
        },
        required: ["book", "number", "file", "path", "chars"]
      },
      render: (_args, value) => {
        // v6.2.0 修正（旧清单第 92 条）：<path> 统一为书库根相对路径——旧版直接打绝对路径，
        // 与 novel_chapters/novel_read 的形态各不相同，且把用户本机路径送进模型上下文。
        // 口径与 core.js 同批统一后的三处一致（novels / novels/<书> / novels/<书>/<文件>）。
        const lines = [`<path>novels/${value.book}/${value.file}</path>`, "<type>novel-chapter-created</type>", "<content>", `已创建 第${String(value.number).padStart(2, "0")}章（${value.chars} 字）`];
        // v6.5.5：渲染里也要带取样范围——模型读的是这段渲染文本，不带就等于把"用户选的那几章"
        // 说成"整本书的基线"。独立复核（渲染路径实测）指出此处漏了，已补。
        if (value.baseline) { lines.push("", "【风格基线 μ】" + value.baseline + (value.baselineScope ? "（取样范围：" + value.baselineScope + "）" : "")); }
        if (Array.isArray(value.anchors) && value.anchors.length > 0) {
          // v6.5.5：按部分时的锚段未必来自"原著"（用户可能正是勾了他自己满意的续写章），
          // 标签随范围变（与开写包同口径）。
          const custom = value.baselineMode === "custom";
          lines.push("", custom
            ? "【风格锚·取样章节】动笔照此味道写（取样范围：" + (value.baselineScope || "") + "；数字基线只做事后校验）："
            : "【风格锚·原著段落】动笔照此味道写（数字基线只做事后校验）：");
          for (const a of value.anchors) lines.push("  [" + a.label + "] " + a.text);
        }
        if (Array.isArray(value.skeletons) && value.skeletons.length > 0) {
          lines.push("", "【句式骨架·只用来校准语感，不要照这个形状造句】");
          for (const sk of value.skeletons) lines.push("  [" + sk.type + "] " + sk.text);
        }
        if (value.reminder) lines.push("", value.reminder);
        // v7.0.0：写盘即时体检（与诊断函数同一实现；只告警、不阻断保存）
        if (Array.isArray(value.postWriteAudit) && value.postWriteAudit.length > 0) {
          lines.push("", "【写盘即时体检·只告警不阻断】");
          for (const it of value.postWriteAudit) lines.push("  - " + it.title + "：" + it.detail);
          lines.push("  说明：这是**刚写入的这一章**的自动体检结论；要改就逐处改，别整章重写。");
        }
        // v6.9.0：非净化模式提示（渲染文本才是模型读到的东西）
        if (value.rawMode) lines.push("", value.rawMode);
        lines.push("</content>");
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_new_chapter");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      // v7.0.1 修正（审查 #9）：上限必须与底层的 MAX_CHAPTER_NUMBER（9999）一致。
      // 旧版允许到 99999：一旦建出「第10000章.md」，scanChapters 认不出 5 位章号，
      // 后续重号防护/摘要归一/全书扫描口径全部失守（该章从此不可被按章号读取）。
      const explicit = optionalInt(args, "chapter", 1, MAX_CHAPTER_NUMBER, void 0);
      const title = optionalString(args, "title");
      // v7.0.0：动笔前的具象计划——**只用于写盘后核对，不参与文件拼接**（见 parameters 里的说明）
      const plan = optionalString(args, "plan");
      const content = optionalString(args, "content");
      const root = resolveRoot(config, args, exec);
      const dir = bookDir(root, book);
      await mkdir(dir, { recursive: true });
      let chapters = [];
      try {
        chapters = await scanChapters(dir);
      } catch (e) {
        // v6.6.0：扫描失败按「空目录」处理会让**章号从 1 重算**（可能撞上已存在的章），
        // 与真的空目录无法区分；非 ENOENT 必须留痕（同样要看 cause：scanChapters 会包 ENOENT）
        if (e?.code !== "ENOENT" && e?.cause?.code !== "ENOENT") {
          logEvent("silent_skip", { book, level: "warn", detail: "建章前章节扫描失败（章号按空目录推算）：" + String(e?.message ?? e) });
        }
        /* 空目录 */
      }
      let number = explicit;
      if (number === void 0) {
        const maxNumber = chapters.reduce((max, c) => c.number !== void 0 ? Math.max(max, c.number) : max, 0);
        number = maxNumber + 1;
        // v7.3.2 修（N8）：自动章号也必须止于 MAX_CHAPTER_NUMBER。本工具**不经过** nextFreeChapterFile
        // （那只在 novel_import 的改名路径被调用），旧版 maxNumber+1 无任何上界：书占满 9999 章时
        // 仍会产出「第10000章」，而 parseChapterNumber 认不出 5 位章号 → 孤章（章表消失、重号防护与
        // 摘要归一键同时失守）。口径与 nextFreeChapterFile 的 assertBumpInRange 保持一致：显式报错。
        if (number > MAX_CHAPTER_NUMBER) {
          throw new Error("章号已用尽：自动分配需要第 " + number + " 章，超出支持上限 " + MAX_CHAPTER_NUMBER +
            "——请把 10000 章以上的书拆分成多本，或把本章改成 4 位以内章号（第1~9999章）。");
        }
      }
      // v5.0.0 修正：把标题带进文件名（本书既有命名约定「第01章 夜航.md」）。
      // 旧实现文件名恒为「第NN章.md」，标题只写进一级标题，而 novel_chapters 的标题取自文件名
      // → 用 title 建的章在清单里显示为空标题；顺带也让 findChapter 的"标题子串"能命中新章。
      const titleSegment = title === void 0 ? "" : safeTitleSegment(title);
      const fileName = `第${String(number).padStart(2, "0")}章${titleSegment === "" ? "" : " " + titleSegment}.md`;
      const filePath = join(dir, fileName);
      // v3.5.0 #2/M14：防覆盖——章号归一化查重（第1章/第一章/第01章 视为同号，避免同号重复章并存）
      // v4.0.0 修正：复用上方已扫描的 chapters——目录刚 mkdir，重扫一次纯冗余，且第二次不在 try 内会抛裸 ENOENT
      const sameNo = chapters.find(function (c) { return (c.number ?? -1) === number; });
      if (sameNo) {
        throw new Error(`第 ${number} 章已存在（${sameNo.file}）——不会覆盖旧稿；如需更新请先确认或使用其他章号`);
      }
      const parts = [];
      let strippedLeadingH1 = false;
      let cleanContent = content;
      if (title !== void 0) {
        parts.push(`# ${title}`, "");
        if (cleanContent !== void 0 && /^\s*#\s+[^\r\n]+/.test(cleanContent)) {
          cleanContent = cleanContent.replace(/^\s*#\s+[^\r\n]+(?:\r?\n[ \t]*\r?\n|\r?\n|$)/, "");
          strippedLeadingH1 = true;
        }
      }
      if (cleanContent !== void 0) parts.push(cleanContent, "");
      const text = parts.join("\n");
      try {
        // v3.9.5 修正：wx(O_EXCL) 原子写入——查重-写入非原子，并发同号创建不再静默互相覆盖
        await writeFile(filePath, text, { encoding: "utf8", flag: "wx", signal: exec.signal });
      } catch (e) {
        if (e && e.code === "EEXIST") {
          throw new Error(`第 ${number} 章刚被并发创建（${fileName}），本次写入已放弃；请重试或指定其他章号`);
        }
        throw e;
      }
      // v6.2.0 修正（旧清单第 24 条）：wx/O_EXCL 只保护**完全相同的文件名**，而文件名自 v5.0.0 起含标题，
      // 故并发指定同章号、标题不同时两边都能通过上方查重（查重与写入非原子）→ 该书出现两份同章号章节，
      // 此后 findChapter 对同章号多文件拒绝按章号读取。写入后复检：同章号出现多份时按**文件名最小者胜出**
      // （两边用同一条规则，故必然只有一方保留），败者回滚自己刚写的文件并报错。
      let sameNumberFiles = [];
      try {
        sameNumberFiles = (await scanChapters(dir))
          .filter((c) => c.number === number)
          .map((c) => c.file)
          .filter((f) => f !== fileName)
          .concat([fileName])
          .sort();
      } catch {
        // v6.6.0：复检失败 → 同章号多文件（撞号）检测被跳过，工具照旧回"已创建成功"，
        // 而撞号之后 findChapter 会拒绝按章号读取（用户会以为章丢了）
        logEvent("silent_skip", { book, chapter: number, level: "warn", detail: "建章后的同章号复检扫描失败（本次未检测撞号）" });
      }
      if (sameNumberFiles.length > 1 && sameNumberFiles[0] !== fileName) {
        const winners = sameNumberFiles.filter((f) => f !== fileName);
        try { await rm(filePath, { force: true }); } catch { /* 回滚失败：下面的报错仍会暴露撞号事实 */ }
        throw new Error(`第 ${number} 章刚被并发创建（${winners.join("、")}），本次写入已回滚；请重试或指定其他章号`);
      }
      // v3.7.0：强制风格基线——创建章节时自动计算全书六维基线附在返回中（即使模型没先调 novel_style_report，也能拿到基线）
      let baselineLine = void 0;
      let baselineScopeText = void 0;
      let baselineModeText = void 0;
      let anchorPkg = { anchors: [], skeletons: [] };
      let bTexts = [];
      let anchorTexts = [];
      try {
        const allChs = await scanChapters(dir);
        // v7.4.0 修（#5）：先对章节清单做范围裁决，只把命中基线范围的既有章节纳入 anchorTexts，
        // 避免某章读盘抛错跳入 catch 时向 buildStyleAnchorPackage 泄漏未选中的章节正文。
        const anchorScope = await resolveBaselineScope(root, book, allChs, fileName, exec);
        const anchorAllowed = new Set(anchorScope.items.map((c) => c.file));
        for (const ch of allChs) {
          // v4.0.0 修正：测量集合纳入新章——与 style_report 的"全章集合"一致，顺序无关的指纹才能互相命中
          //（旧版排除新章，缓存键与 style_report/style_check 都不同，三者交替调用全部 miss）
          const chText = ch.file === fileName ? text : await readTextFile(join(dir, ch.file), exec);
          bTexts.push({ file: ch.file, text: chText });
          // 锚包仍只用既有章节（新章是刚创建的稿子，不能当"原著样例"）
          if (ch.file !== fileName && anchorAllowed.has(ch.file)) anchorTexts.push({ file: ch.file, text: chText });
        }
        if (bTexts.length > 0) {
          const perCh = await metricChaptersCached(root, book, bTexts);
          // 基线排除新章本身（新章不参与自己的基线）；无其他章节时不输出"μ=0"的假基线
          // v6.5.5：范围走单一裁决点（按全书 / 按用户选中的部分章），与 style_check / fix_plan / brief 同口径。
          // 注意 bTexts 含新章（与 style_report 的全章集合一致，保证缓存键互相命中），
          // 所以这里由 resolver 把新章排除掉——它内部**总是排除传入的目标章**。
          const newScope = await resolveBaselineScope(root, book, perCh, fileName, exec);
          const excluding = newScope.items;
          // v6.5.5 / v7.4.0（#44）：仅当 excluding.length > 0 可计算出基线时写入 baseline / baselineScope / baselineMode；
          // 无法计算时保持 undefined，由 cleanOutput 自然省略缺失。
          if (excluding.length > 0) {
            baselineScopeText = newScope.scope;
            baselineModeText = newScope.mode;
            const bl = computeBaselineFromPerChapter(excluding);
            baselineLine = METRIC_ORDER.map(function (k) { return METRIC_LABELS[k] + " " + (bl[k] && typeof bl[k].mu === "number" ? bl[k].mu : "-"); }).join(" / ");
          }
        }
      } catch (e) {
        if (isAbort(e)) throw e;
        anchorTexts = [];
        // v6.6.0：基线计算失败 → 建章返回里的 baseline 省略（模型会当成"这本书没有基线"），真因留痕
        logEvent("silent_skip", { book, chapter: number, level: "warn", detail: "建章时的六维基线计算失败（返回的 baseline 为空）" });
      }
      try {
        anchorPkg = await buildStyleAnchorPackage(root, book, chapters, exec, anchorTexts); // 复用基线计算已读文本
      } catch (e) {
        if (isAbort(e)) throw e;
        // v6.6.0：锚包是"照着原著写"的样例；失败后 anchors/skeletons 为空数组，
        // 与"这本书章太少、抽不出锚段"完全一样——新章正文照样返回，模型却少了语感样例
        logEvent("silent_skip", { book, chapter: number, level: "warn", detail: "建章时的原著锚段/句式骨架不可用（返回空 anchors/skeletons）" });
      }
      const reminder = "本章已创建（第" + String(number).padStart(2, "0") + "章）。【基线怎么用】① 动笔前：anchors 读一遍校准语感即可（**不要照 skeletons 造句**），baseline 六维只做写完后的校验；② 写完：**建议**跑一次 novel_style_check，只有偏离明显（≥2 倍容差）或那一处读起来确实别扭时才逐句修正跑偏处（不得整章重写）——单一维度轻微出带属正常波动，不要为对齐数字改文。";
      await noteRoot(root); // v3.9.0：新章创建记录书库根
      // v6.9.0：非净化模式——建章返回也带一条写作约束（模型拿到的最后一段文字），
      // 与开写包的【非净化模式·目标带】同一份文本（prompts.js 单一事实源）
      let rawModeHint = "";
      try {
        if ((await readSentenceState())?.features?.rawWriting === true) rawModeHint = RAW_MODE_HINT;
      } catch { /* 读不到开关就不加提示，不影响建章 */ }
      // v7.0.0（v2.1 模块 6）：写盘即时体检——零额外调用的触点。
      // 只跑**结构性**症状（章末升华 / 站桩 / 套话）+ plan 兑现核对：相对分位类症状需要参照集，
      // 那是下一章开写包的事，这里不做（避免为了一个提示再算一遍全书）。
      let postWriteAudit = [];
      try {
        const bodyText = cleanContent ?? "";
        if (bodyText.trim() !== "") {
          const found = diagnoseChapterSymptoms(bodyText, null).slice(0, 5);
          const extraH1 = (bodyText.match(/^[ \t]*#\s+\S/gm) || []).length;
          if ((title !== void 0 && extraH1 >= 1) || (title === void 0 && extraH1 >= 2)) {
            found.push({
              key: "duplicate_h1",
              severity: 3,
              title: "正文含多个一级标题",
              detail: "正文中出现多处 # 一级标题，请确认是否误把多章内容合写或重复写了章名。"
            });
          } else if (strippedLeadingH1) {
            found.push({
              key: "duplicate_h1",
              severity: 2,
              title: "正文开头含重复一级标题（已自动合并）",
              detail: "已传 title 参数时，content 开头不必再写 # 标题，本次已自动去重。"
            });
          }
          if (plan !== void 0) {
            const fulfil = checkPlanFulfillment(plan, bodyText);
            if (fulfil.qualified === true && fulfil.unfulfilled.length > 0) {
              found.unshift({
                key: "plan_unfulfilled",
                severity: 5,
                title: "计划里有 " + fulfil.unfulfilled.length + " 条没兑现",
                detail: "动笔前写下的这些物象/动作在正文里找不到："
                  + fulfil.unfulfilled.slice(0, 4).join("、")
                  + (fulfil.unfulfilled.length > 4 ? " 等" : "")
                  + "——要么补写，要么下次计划写小一点"
              });
            } else if (fulfil.qualified !== true) {
              found.push({
                key: "plan_unqualified",
                severity: 1,
                title: "plan 格式不合格，已跳过兑现核对",
                detail: "每条计划至少写一个具体器物或动作（例如「柜台上的铜钱：他数了三枚推过去」），否则无法核对"
              });
            }
          }
          postWriteAudit = found.slice(0, 5).sort(function (a, b) { return (b.severity || 0) - (a.severity || 0); });
        }
      } catch (e) {
        // 体检失败不该影响"章已经写好了"这个事实：记一条事件日志，返回里不带 postWriteAudit
        logEvent("silent_skip", { book, chapter: number, level: "warn", detail: "建章即时体检失败（本章照常保存，未返回 postWriteAudit）：" + String(e?.message ?? e).slice(0, 80) });
      }
      // v7.0.1 修正（审查 #36）：baselineMode 只在**确实算出了基线范围**时才返回。
      // schema 是 enum:["all","custom"]，基线计算失败/被取消时旧版留在 ""，严格校验的宿主会把
      // 整条建章返回拒收（章已写盘，用户却看到"创建失败"）。这里改为条件展开——无有效值就不返回该键
      //（schema.required 不含 baselineMode；render 里读 value.baselineMode === "custom" 对 undefined 安全）。
      // v7.3.0：实时聊天写作——**插件自己**在定稿落盘时留一条镜像记录，AI 不需要（也不该）管这件事。
      // 规则：镜像里**已经有逐段内容** → 只写一行「定稿落盘」标记（否则镜像会与正文等长，
      //       看起来像"镜像没多写"——真实用户反馈过；只追加的镜像应当比正文长）；
      //       镜像里**一个字都没有**（刚开开关、AI 没走 commit）→ 补写一次定稿正文，保证人打开镜像有东西可看。
      try {
        const featState = await readSentenceState();
        if (featureEnabled(featState, "chatWriting")) {
          const target = resolveDraftTarget(root, book, String(number));
          assert(!isInsideBookDir(root, book, target.file), "草稿镜像不能放在正文目录内——会污染章节扫描");
          await mkdir(dirname(target.file), { recursive: true });
          const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
          // 看一眼镜像里有没有逐段内容（只数段头，不把内容读进上下文）
          let hasSegments = false;
          try {
            hasSegments = /^## 第\s*\d+\s*段/m.test(await readFile(target.file, "utf8"));
          } catch { /* 文件不存在 = 还没有段 */ }
          const head = "## 定稿落盘 · 第" + number + "章 · " + stamp + "\n\n"
            + "> 本章已写入正式章节：" + fileName + "（" + text.length + " 字）。本文件是草稿镜像，只追加、只给人看。\n\n";
          await appendFile(target.file, hasSegments ? head : head + text.replace(/\s+$/, "") + "\n\n", "utf8");
        }
      } catch (e) {
        // 镜像失败不影响"章已经写好了"这个事实，只留一条事件
        try {
          logEvent("silent_skip", { book, chapter: number, level: "warn", detail: "定稿镜像写入失败（本章照常保存）：" + String(e?.message ?? e).slice(0, 80) });
        } catch { /* 日志失败忽略 */ }
      }
      return cleanOutput({ book, number, file: fileName, path: filePath, chars: text.length, baseline: baselineLine, baselineScope: baselineScopeText, ...(baselineModeText ? { baselineMode: baselineModeText } : {}), reminder, anchors: anchorPkg.anchors, skeletons: anchorPkg.skeletons, ...(rawModeHint === "" ? {} : { rawMode: rawModeHint }), ...(postWriteAudit.length === 0 ? {} : { postWriteAudit }) });
    }
  });
}

/**
 * v5.0.0：开写包——动笔前一次性装配「写这一章需要的一切材料」。
 *
 * 设计动机：此前这些材料分散在 6~8 次工具调用里，靠系统提示词叮嘱模型去取；
 * 而**漏读正是文风漂移与设定矛盾的头号来源**。本工具把它压成一次调用，从结构上消灭漏读。
 * 材料来源与 novel_new_chapter 附带的「基线 + 锚段 + 骨架」同源，这里是抽离与扩容。
 */
function registerNovelChapterBrief(ctx, config) {
  ctx.tools.register({
    name: "novel_chapter_brief",
    description: "开写包(只读)：返回承接口/大纲/人物/伏笔/用语/基线/锚段/骨架/禁用与清单，写前先调。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名" },
        chapter: { type: "string", description: "目标章(默认next)" },
        budget: { type: "string", enum: ["compact", "full"], description: "compact省上下文/full全量" },
        root: { type: "string", description: "书库根" }
      },
      required: ["book"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          book: { type: "string" },
          chapter: { type: "object", additionalProperties: true, description: "{ file, number, title }；无法唯一确定目标章时整键省略（原因见 degraded）。" },
          isNext: { type: "boolean" },
          anchor: { type: "string" },
          previousHook: { type: "string" },
          outlineDirection: { type: "string" },
          characters: { type: "array", items: { type: "object", additionalProperties: true }, description: "相关人物卡：{ name, role, description, mentions, sources[], offstage? }" },
          openPlots: { type: "array", items: { type: "object", additionalProperties: true }, description: "未回收伏笔：{ id, content, priority, type, firstChapter?, distance?, ... }，按 优先级 → distance 降序" },
          worldview: { type: "object", additionalProperties: true, description: "v6.4.0 起为 { basis, bannedWords, recommended, speechStyle, culture, cultureName, cultureSource }；**恒在**（v6.9.5 起不再省略）——未登记任何 worldview 条目时，按文化基准（登记文本 → 正文检测 → 默认欧式）注入默认禁用词表，`cultureSource` 为「default」。bannedWords = 去重(用户登记 ∪ 文化基准对应的默认禁用词表)，与 novel_continuity_check 的用语扫描**同源**（同一个 resolveStyleRule 裁决点）；cultureSource 说明基准来自 worldview 登记 / 正文检测 / 默认" },
          lexicon: { type: "object", additionalProperties: true, description: "v6.2.0 必用词表（lexiconFirst 开启且已登记时给出）：{ enabled, total, shown, truncated, groups:[{ kind, terms:[{ term, avoid[], scene?, note?, priority?, scope? }] }], counts, files }；未登记或开关关闭时省略" },
          // v6.9.0：非净化模式的目标带（开关打开时给出）——把"直白度"放到动笔那一刻
          rawMode: { type: "object", additionalProperties: true, description: "v6.9.0 非净化模式（rawWriting 开启时）：{ on, hint, sample:{chapters,chars}, baseline:{softeningPer1000,dialogueRatio}, target, checklist }；关闭时省略。baseline 是原著里「把场面绕过去」的写法密度（处/千字，启发式）" },
          chatWriting: { type: "object", additionalProperties: true, description: "v7.3.0 实时聊天写作（chatWriting 开启时）：{ on, mirrorDir, draftFile, chapterKey, threshold, checklist, howTo }；关闭时省略。mirrorDir/draftFile 指向**独立目录** .novel-writer/drafts/<书>/，不在 novels/<书>/ 内——正式章节在用户确认前不被改动" },
          baseline: { type: "object", additionalProperties: true, description: "六维基线 { <metric>: { mu, sigma, recTol } }；书太短等情况下省略" },
          sceneBaselines: { type: "object", additionalProperties: true, description: "多场景分带基线摘要（至少存在 2 个有效场景带时返回）" },
          // v6.5.5：基线范围披露（按全书 / 自定义 N 章）。**必须登记**：本输出 additionalProperties:false，
          // 多返回一个未登记字段会被严格校验的宿主整条拒收。
          baselineScope: { type: "string", description: "六维基线与锚段的取样范围：按全书 = 「全书除本章外的 N 章」；按部分 = 「自定义基线 N 章（选中 M 章…）」；选择全部失效而回退时为「…（自定义选择已失效，已回退全书）」" },
          baselineMode: { type: "string", enum: ["all", "custom"], description: "基线范围档位：all = 按全书（默认），custom = 按用户选中的部分章" },
          anchors: { type: "array", items: { type: "object", additionalProperties: true }, description: "原著锚段 [{ label, text }]" },
          skeletons: { type: "array", items: { type: "object", additionalProperties: true }, description: "句式骨架 [{ type, text }]" },
          // v7.0.0（v2.1 模块 2/3/4/6）：动笔前的"近距护航"材料——全部可空、且受 enhanceChars 总预算约束。
          actionChains: { type: "array", items: { type: "string" }, description: "v7.0.0 原著典型颗粒度动作链（参照集 p60~p85 分位 + 按目标章号确定性轮换；完整句、不截断）。只用来判断「动作有没有连起来」，不是造句模板" },
          clauseFrames: { type: "array", items: { type: "object", additionalProperties: true }, description: "v7.0.0 本章大纲子句框架 [{ clause, category, label, format }]：只做切分与动词元类标注，具体物象由模型在 novel_new_chapter 的 plan 里填" },
          prevChapterIssues: { type: "array", items: { type: "object", additionalProperties: true }, description: "v7.0.0 上一章遗留问题 [{ key, severity, title, detail }]（最多 3 条，来自与写盘返回同一个诊断函数）" },
          symptomPrescriptions: { type: "array", items: { type: "object", additionalProperties: true }, description: "v7.0.0 本章症状处方 [{ key, severity, text }]：相关性门控（大纲无交谈/交易则不发防站桩）+ 3 章 2 中滞回 + 每章最多 3 条；新书前 3 章为固定 3 条极简底线" },
          referenceProvenance: { type: "string", enum: ["custom", "all-unverified"], description: "v7.0.0 参照集来源：custom = 用户勾选的标杆章；all-unverified = 全书（可能含 AI 续写章，degraded 里另有一句披露）" },
          lastVerdict: { type: "string" },
          avoid: { type: "array", items: { type: "object", additionalProperties: true }, description: "本章禁用清单 [{ kind, detail }]" },
          plan: { type: "object", additionalProperties: true, description: "{ previousState, goal, checklist[] }" },
          degraded: { type: "array", items: { type: "string" } }
        },
        required: ["book", "isNext", "anchor", "previousHook", "outlineDirection", "characters", "openPlots", "anchors", "skeletons", "lastVerdict", "avoid", "plan", "degraded"]
      },
      render: (_args, value) => {
        const out = [`<path>novels/${value.book}</path>`, "<type>novel-chapter-brief</type>", "<content>", ""];
        out.push(value.chapter
          ? `目标：第 ${value.chapter.number ?? "?"} 章《${value.chapter.title || "（无标题）"}》${value.isNext ? "（尚未创建，文件名推导为 " + value.chapter.file + "）" : ""}`
          : "目标：无法唯一确定要写哪一章（见文末降级说明）");
        if (value.outlineDirection) out.push("", "【本章方向】" + value.outlineDirection);
        if (value.previousHook) out.push("", "【上一章钩子】" + value.previousHook);
        if (value.anchor) out.push("", "【上一章结尾原文·承接口】", value.anchor);
        if (value.openPlots.length > 0) {
          out.push("", "【待回收伏笔】");
          for (const p of value.openPlots) {
            // v6.2.1 修正：登记章号在目标章之后的伏笔本章还没埋下（brief.js 标 notYetPlanted）——
            // 旧版会打成「第 5 章埋下，已过 0 章」，与事实相反。
            // v7.3.3 修（#1）：原来写「本章将首次埋下」，**与 brief.js 的 degraded / plan.checklist 正相反**
            //（那两处明说「本章尚未埋下（后文才埋），不要提前泄露」）。同一份开写包给出两个相反指令，
            // 渲染这句会诱导模型提前埋设、剧透后文。
            out.push(p.notYetPlanted === true
              ? `  - [${p.id}] ${p.content}（${p.priority}｜后文才埋：本章**尚未**埋下，不要提前埋设或剧透）`
              : `  - [${p.id}] ${p.content}（${p.priority}｜第 ${p.firstChapter ?? "?"} 章埋下，已过 ${p.distance ?? "?"} 章）`);
          }
        }
        if (value.characters.length > 0) {
          out.push("", "【相关人物】");
          for (const c of value.characters) out.push(`  - ${c.name}${c.offstage === true ? "（已退场，勿写其出场）" : ""}：${c.description || c.role || ""}`);
        }
        if (value.worldview) {
          const w = value.worldview;
          // v6.4.0（P0-3 补齐）：此处原为 `w.bannedWords.slice(0, 10)`，**没有注明总数**——
          // 于是同一份 render 里出现两个口径：【世界观用语】行 10 个、【本章禁用清单】69 个，
          // 读者无从知道还有多少。独立验证子代理抓到这处漏改（我当时的 CHANGELOG 声称"两处已取消"，
          // 实际只改了 brief.js 那一处）。
          // 现在：摘要取前 8 个 + 明写总数 + 指向清单；完整词表由 avoid 的「禁词」条目承载。
          const words = Array.isArray(w.bannedWords) ? w.bannedWords : [];
          const head = words.slice(0, 8).join("、");
          const banned = words.length === 0
            ? ""
            : words.length <= 8
              ? "禁用：" + head
              : "禁用：" + head + " 等 " + words.length + " 条（完整见【本章禁用清单】）";
          out.push("", "【世界观用语】" + [w.basis || w.cultureName, w.pack?.name ? "题材包:" + w.pack.name + "(" + w.pack.id + ")" : "", banned].filter(Boolean).join("｜"));
        }
        // v6.2.0 修正（增量清单第 1 条）：lexicon 分区此前**从未渲染**——brief.js 已经产出词表载荷并在
        // checklist 里写下「完整表见上方【必用词·优先使用】」，而这里才是模型可见内容的唯一来源：
        // 缺这一段，那句硬指令就指向一个不存在的分区，avoid（勿用替身词）一条都到不了模型。
        if (value.lexicon) {
          const lex = value.lexicon;
          const shown = typeof lex.shown === "number" ? lex.shown : 0;
          const total = typeof lex.total === "number" ? lex.total : shown;
          out.push("", "【必用词·优先使用】凡涉及以下概念，必须用表内词写成；标了「勿用」的通用说法一个都不要出现：");
          for (const group of Array.isArray(lex.groups) ? lex.groups : []) {
            out.push("〔" + (group.kind ?? "其他") + "〕");
            for (const t of Array.isArray(group.terms) ? group.terms : []) {
              const bits = [t.term + (t.priority === "high" ? "★" : "")];
              const avoid = Array.isArray(t.avoid) ? t.avoid.filter(Boolean) : [];
              if (avoid.length > 0) bits.push("（勿用：" + avoid.join("/") + "）");
              // 两层合并视图：来自全局层（跨书惯用词）的条目标一下，书级层是本表默认来源、不加噪音
              if (t.scope === "global") bits.push("全局层");
              if (t.scene) bits.push("场景:" + t.scene);
              if (t.note) bits.push(t.note);
              out.push("  - " + bits.join("｜"));
            }
          }
          if (lex.truncated === true && total > shown) out.push("  （共 " + total + " 条，本章只注入 " + shown + " 条；完整表用 novel_lexicon action=list）");
        }
        if (value.baseline) {
          const mu = Object.keys(value.baseline).map((k) => `${k} μ=${value.baseline[k].mu}`).join("  ");
          // v6.5.5：把取样范围写进**渲染文本**——模型读的是这段文字而不是 JSON 字段。
          // 不在这里说明，它会以为这些 μ 是整本书的，而实际可能只来自用户勾选的那几章。
          out.push("", "【风格基线】" + mu + (value.baselineScope ? "（取样范围：" + value.baselineScope + "）" : ""));
        }
        if (value.sceneBaselines && typeof value.sceneBaselines === "object") {
          const sbMap = value.sceneBaselines.bands || value.sceneBaselines;
          const sbKeys = Array.isArray(value.sceneBaselines.availableBands)
            ? value.sceneBaselines.availableBands
            : Object.keys(sbMap).filter((k) => sbMap[k] && typeof sbMap[k] === "object" && typeof sbMap[k].chapterCount === "number");
          if (sbKeys.length >= 2) {
            const bandParts = sbKeys.map((k) => {
              const b = sbMap[k];
              if (!b) return "";
              const m = b.mu || {};
              return `${b.label}(${b.chapterCount}章: 句法${m.complexity ?? "-"}/修饰${m.modifierDensity ?? "-"}/动作${m.actionDensity ?? "-"})`;
            }).filter(Boolean);
            if (bandParts.length > 0) out.push("  场景参考带：" + bandParts.join("；"));
          }
        }
        // v6.9.0：非净化模式必须**出现在模型读的那段文字里**——只放结构化字段等于没给（旧版就是只有系统提示一句）
        if (value.rawMode) {
          const rm = value.rawMode;
          out.push("", "【非净化模式·目标带】");
          if (rm.hint) out.push(rm.hint);
          if (rm.baseline) {
            out.push("  原著基线：淡化写法 " + rm.baseline.softeningPer1000 + " 处/千字（取样 " + (rm.sample?.chapters ?? "?") + " 章 / " + (rm.sample?.chars ?? "?") + " 字）");
          }
          if (rm.target) out.push("  本章要求：" + rm.target);
        }
        // v7.3.0：实时聊天写作——镜像路径必须出现在模型读的文字里，否则它只会照着系统提示空讲
        if (value.chatWriting) {
          const cw = value.chatWriting;
          out.push("", "【实时聊天写作·逐段确认】");
          out.push("  草稿镜像（独立文件夹，正式章节不在这里）：" + cw.draftFile);
          out.push("  镜像目录：" + cw.mirrorDir);
          out.push("  程序阈值：" + cw.threshold + " 字（**由程序判定何时提问**，不要自己决定）");
          if (cw.howTo) out.push("  怎么做：" + cw.howTo);
          out.push("  硬规矩：每段写完用 novel_draft 交出去并照 nextAction 执行；用户说不对就只改他指出的那几段；确认前不要写正式章节文件。");
        }
        if (value.anchors.length > 0) {
          // v6.5.5：按部分时的锚段未必来自"原著"（用户可能正是勾了他自己满意的续写章），
          // 所以这种情况下不再叫「原著锚段」——标签随范围变，并把范围写在标签里。
          const custom = value.baselineMode === "custom";
          out.push("", (custom ? "【锚段·照这个味道写】" : "【原著锚段·照这个味道写】") +
            (custom && value.baselineScope ? "（取样范围：" + value.baselineScope + "）" : ""));
          for (const a of value.anchors) out.push(`  [${a.label}] ${a.text}`);
        }
        if (value.skeletons.length > 0) {
          // v7.3.3 修（#3①）：原标题写「按这个形状造句」，与 prompts.js 里「anchors 只用来校准语感、
  // **不要照 skeletons 造句、不要套用它们的句式模板**」正相反；同一份 payload 相隔十几行自相矛盾。
  //（anchors 的标题「照这个味道写」本来是对的，唯有 skeletons 没跟着改。）
  out.push("", "【句式骨架·只用来校准语感，不要照这个形状造句】");
          for (const s of value.skeletons) out.push(`  [${s.type}] ${s.text}`);
        }
        // v7.0.0：动笔前的近距护航段（全部可空；顺序即"从近到远"：遗留问题 → 处方 → 欠账 → 颗粒度）
        if (Array.isArray(value.prevChapterIssues) && value.prevChapterIssues.length > 0) {
          out.push("", "【上一章遗留·先修再写】");
          for (const it of value.prevChapterIssues) out.push("  - " + it.title + "：" + it.detail);
        }
        if (Array.isArray(value.symptomPrescriptions) && value.symptomPrescriptions.length > 0) {
          out.push("", "【本章处方·硬约束】");
          for (const it of value.symptomPrescriptions) out.push("  - " + it.text);
        }
        if (Array.isArray(value.clauseFrames) && value.clauseFrames.length > 0) {
          out.push("", "【本章欠账·逐条具象兑现】");
          out.push("  动笔前先在 plan 参数里为每条填：具体器物 + 肢体动作 + 这一幕停在哪（写进 content 不会存盘）。");
          if (value.clauseFrames.length === 1) out.push("  " + SINGLE_CLAUSE_STEP_HINT);
          for (const f of value.clauseFrames) out.push("  □ 【" + f.label + "】" + f.clause + " → " + f.format);
        }
        if (Array.isArray(value.actionChains) && value.actionChains.length > 0) {
          out.push("", "【原著动作颗粒度·参照（不是造句模板，不要照抄原句）】");
          for (const c of value.actionChains) out.push("  · " + c);
        }
        if (value.lastVerdict) out.push("", "【上一章自检】" + value.lastVerdict);
        if (value.avoid.length > 0) {
          out.push("", "【本章禁用清单】");
          for (const a of value.avoid) out.push(`  - ${a.kind}：${a.detail}`);
        }
        out.push("", "【开写清单】");
        for (const item of value.plan.checklist) out.push("  □ " + item);
        if (value.degraded.length > 0) {
          out.push("", "【降级/提示】");
          for (const d of value.degraded) out.push("  - " + d);
        }
        out.push("", "</content>");
        return [{ type: "text", text: out.join("\n") }];
      }
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_chapter_brief");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const chapterArg = optionalString(args, "chapter") ?? "next";
      const budget = args?.budget === "full" ? "full" : "compact";
      const root = resolveRoot(config, args, exec);
      // featState 用于让"上一章六维判定"沿用侧边栏保存的容差（与 novel_style_check 同口径）
      const brief = await buildChapterBrief(root, book, chapterArg, { budget, featState: await readSentenceState() }, exec);
      return dropNullDeep(brief);
    }
  });
}

/**
 * v7.3.0：实时聊天写作的草稿镜像（novel_draft）——**只追加，且不由 AI 管理**。
 *
 * 与最初设想的「一段一问」有三处不同（按用户要求改的）：
 *   ① **只写不改**：没有 read / clear / 覆盖；重复段落也照写（appendFile，永不重写全文）。
 *      AI 不读镜像、不改镜像，镜像只交给人看；
 *   ② **镜像写入由程序完成**：AI 只把"这一段正文"交进来，路径、分段号、时间戳全由程序决定，
 *      AI 不需要（也不允许）自己找路径、拼格式；
 *   ③ **"何时停下来问人"由程序的字数阈值决定**（CHAT_PROMPT_THRESHOLD_CHARS）：
 *      AI 只看返回的 nextAction（continue / ask_user），不做判断；短段自然累积，
 *      累计够阈值才把**合并后的文本**一次性交给用户问。计数存在 __state.json 里，跨调用保持。
 *
 * 边界：只追加到 <书库>/.novel-writer/drafts/<书>/；不写正文、不读镜像正文（计数用程序账本）。
 */
function registerNovelDraft(ctx, config) {
  const chapterKeyOf = (args) => {
    const raw = optionalString(args, "chapter");
    return raw !== void 0 && raw.trim() !== "" ? raw.trim() : "未命名章";
  };
  const targetOf = (root, book, args) => {
    // v7.3.0：**同一章只能有一个镜像文件**——规范键优先，其次认领同章号的既有文件（兼容旧命名）。
    const { key, dir, file, stateFile } = resolveDraftTarget(root, book, chapterKeyOf(args));
    assert(!isInsideBookDir(root, book, file),
      "草稿镜像不能放在正文目录 novels/" + book + "/ 内——半成品会被章节扫描当成正文，污染字数与基线");
    return { key, dir, file, stateFile };
  };
  /** 读程序账本；缺失时按镜像里已有的段头兜底初始化（只数段，不把内容读进来）。 */
  const loadMeta = async (stateFile, file) => {
    try {
      const m = JSON.parse(await readFile(stateFile, "utf8"));
      return {
        segments: Number.isFinite(m?.segments) ? m.segments : 0,
        pendingChars: Number.isFinite(m?.pendingChars) ? m.pendingChars : 0,
        totalChars: Number.isFinite(m?.totalChars) ? m.totalChars : 0,
        prompts: Number.isFinite(m?.prompts) ? m.prompts : 0,
        pending: Array.isArray(m?.pending) ? m.pending.map(String) : [],
        updatedAt: typeof m?.updatedAt === "string" ? m.updatedAt : ""
      };
    } catch {
      let segments = 0;
      try {
        const text = await readFile(file, "utf8");
        segments = (text.match(/^## 第\s*\d+\s*段/gm) ?? []).length;
      } catch { /* 还没有镜像 = 新章 */ }
      return { segments, pendingChars: 0, totalChars: 0, prompts: 0, pending: [], updatedAt: "" };
    }
  };
  ctx.tools.register({
    name: "novel_draft",
    description: "聊天写作草稿镜像(只追加不读改)：提交当前段到.novel-writer/drafts/<书>/。continue续写；ask_user将question+combinedText问用户。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["commit"], description: "commit" },
        book: { type: "string", description: "书名" },
        chapter: { type: "string", description: "章标识" },
        text: { type: "string", description: "本段正文(勿整章)" },
        root: { type: "string", description: "书库根" }
      },
      required: ["action", "book", "text"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string" },
          book: { type: "string" },
          chapter: { type: "string" },
          mirrorDir: { type: "string", description: "镜像目录（绝对路径，给人看）" },
          draftFile: { type: "string", description: "该章镜像文件（绝对路径，给人看）" },
          segmentIndex: { type: "integer", description: "本次写入是第几段" },
          segmentChars: { type: "integer" },
          pendingChars: { type: "integer", description: "本批已累计多少字（够阈值就提问并清零）" },
          threshold: { type: "integer", description: "程序阈值（字）" },
          remaining: { type: "integer", description: "距下次提问还差多少字" },
          prompts: { type: "integer", description: "本章已提问次数" },
          nextAction: { type: "string", enum: ["continue", "ask_user"], description: "程序判定：继续写 / 现在去问用户" },
          combinedText: { type: "string", description: "nextAction=ask_user 时：本批合并后的正文（贴给用户）" },
          question: { type: "string", description: "nextAction=ask_user 时：原样交给提问工具的问题" },
          message: { type: "string" }
        },
        required: ["action", "book", "chapter", "mirrorDir", "draftFile", "segmentIndex", "segmentChars", "pendingChars", "threshold", "remaining", "prompts", "nextAction", "message"]
      },
      render: (_args, value) => {
        const out = ["<type>novel-draft</type>", "<content>", value.message ?? ""];
        out.push("");
        out.push("镜像文件（给人看的，你不要读）：" + value.draftFile);
        // v7.3.0：触发那一拍 pendingChars 可能略超阈值（本批真实累计），写成 "162 / 阈值 150" 比 "150/150" 诚实
        const batchLine = value.nextAction === "ask_user"
          ? "本批 " + value.pendingChars + " 字 / 阈值 " + value.threshold + " 字"
          : "待确认 " + value.pendingChars + "/" + value.threshold + " 字";
        out.push("第 " + value.segmentIndex + " 段已写入（" + value.segmentChars + " 字）｜" + batchLine + "｜本章已提问 " + value.prompts + " 次");
        if (value.nextAction === "ask_user") {
          out.push("", "程序判定：现在停下来问用户（阈值已到）。把下面两段原样交给提问工具：");
          out.push("【问题】" + (value.question ?? ""));
          out.push("【本批正文】", value.combinedText ?? "");
        } else {
          out.push("", "程序判定：继续写下一段（还差 " + value.remaining + " 字到阈值）——不要自己去问用户。");
        }
        out.push("</content>");
        return [{ type: "text", text: out.join("\n") }];
      }
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_draft");
      const action = requiredString(args, "action");
      if (action !== "commit") {
        throw new Error("草稿镜像只支持 action=commit（只追加）。它由程序维护、不交给 AI 读改清——需要清理请人工删除 <书库>/.novel-writer/drafts/ 下的文件。");
      }
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const root = resolveRoot(config, args, exec);
      const { key, dir, file, stateFile } = targetOf(root, book, args);
      const text = requiredString(args, "text");
      // v7.3.0：阈值由**用户配置**决定（状态里的 chatThreshold，未填则用默认 400），仍在程序侧判定
      const featState = await readSentenceState();
      const threshold = featState.chatThreshold ?? CHAT_PROMPT_THRESHOLD_CHARS;
      // v7.3.1 修（#14）：读账本 → 追加镜像 → 写回账本必须是一个事务（withFileTx，与 settings/summary
      // 等写工具同源）。旧版三步毫无保护：同章两个 commit 并发时各读同一份旧账本、后写覆盖先写，
      // 段号与字数计数丢失，pending 队列也会错位（正文虽都写进去了，账本却对不上）。
      return await withFileTx(stateFile, async function () {
        const meta = await loadMeta(stateFile, file);

        // ① 程序负责落盘：只 append，永不重写（重复段落也照写）
        await mkdir(dir, { recursive: true });
        const segmentIndex = meta.segments + 1;
        const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
        await appendFile(file, "## 第" + segmentIndex + "段 · " + stamp + "\n\n" + text + "\n\n", "utf8");

        // ② 程序负责计数与判定（AI 不参与）
        meta.segments = segmentIndex;
        meta.totalChars += text.length;
        meta.pending.push(text);
        meta.pendingChars += text.length;
        const reached = meta.pendingChars >= threshold;
        // v7.3.0 修正：本批真实累计字数（触发时会清零，不能拿清零后的值当"本批已累计"上报——
        // 那会把 162 字报成 150 字，看起来像"恰好等于阈值"，实际是略超）
        let batchChars = meta.pendingChars;
        let combinedText = "";
        let question = "";
        if (reached) {
          combinedText = meta.pending.join("\n\n");
          question = "这一段（本批合并 " + meta.pending.length + " 段 / 共 " + meta.pendingChars + " 字，程序阈值 " + threshold + " 字）写得对不对？\n\n"
            + combinedText
            + "\n\n对就继续写下一段；哪里不对请直接说，我按你说的改。";
          meta.prompts += 1;
          meta.pending = [];
          meta.pendingChars = 0;
        }
        meta.updatedAt = new Date().toISOString();
        await atomicWriteJson(stateFile, meta);

        const pendingAfter = meta.pendingChars;
        return {
          action: "commit",
          book,
          chapter: key,
          mirrorDir: dir,
          draftFile: file,
          segmentIndex,
          segmentChars: text.length,
          pendingChars: reached ? batchChars : pendingAfter,
          threshold,
          // 触发时本批已清零，所以"还差多少到下一次提问"就是一整个阈值
          remaining: reached ? threshold : Math.max(0, threshold - pendingAfter),
          prompts: meta.prompts,
          nextAction: reached ? "ask_user" : "continue",
          ...(reached ? { combinedText, question } : {}),
          message: reached
            ? "本批累计已达 " + threshold + " 字阈值（第 " + segmentIndex + " 段落盘）。现在停下来用提问工具问用户；他确认前不要继续写下一段。"
            : "第 " + segmentIndex + " 段已落盘（本段 " + text.length + " 字）。待确认累计 " + pendingAfter + "/" + threshold + " 字，还差 " + Math.max(0, threshold - pendingAfter) + " 字——继续写下一段，不要自己去问用户（阈值由程序判定）。"
        };
      });
    }
  });
}

function registerNovelOutline(ctx, config) {
  ctx.tools.register(createOutlineTool(config));
}

/** v6.2.0：必用词表的文本渲染（工具输出）。 */
function formatLexicon(value) {
  const out = ["<type>novel-lexicon</type>", "<content>", value.message ?? ""];
  const files = value.files ?? {};
  const paths = [files.book, files.global].filter(Boolean);
  if (paths.length > 0) out.push("", "文件：" + paths.join("　"));
  if (value.counts) out.push("词条数：本书 " + (value.counts.book ?? 0) + " / 全局 " + (value.counts.global ?? 0) + " / 生效 " + (value.counts.effective ?? 0));
  // v6.2.0 修正（增量清单第 10 条）：合并层没有「那一层」——分列各层开关（与路由侧 bookEnabled/globalEnabled 同口径）；
  // audit 的同一个键装的其实是插件级「必用词优先」开关，改为独立键名，文案不再统一打成「本层开关」。
  if (value.layers) out.push("各层开关：本书 " + (value.layers.book ? "开" : "关") + " / 全局 " + (value.layers.global ? "开" : "关"));
  if (value.lexiconFirst !== void 0) out.push("「必用词优先」插件级开关：" + (value.lexiconFirst ? "开" : "关"));
  else if (value.enabled !== void 0) out.push("本层开关：" + (value.enabled ? "开" : "关"));
  if (Array.isArray(value.entries) && value.entries.length > 0) {
    out.push("", "【词条】");
    for (const group of groupLexiconByKind(value.entries)) {
      out.push("〔" + group.kind + "〕");
      for (const e of group.entries) out.push("  - " + lexiconEntryLine(e));
    }
  }
  // v6.2.1：损坏层必须显式告知（否则用户以为"这层是空表"）
  if (value.corrupt === true) {
    out.push("", "⚠ 词表文件无法读取或内容不是合法 JSON（本次按空表处理）：");
    for (const f of Array.isArray(value.corruptFiles) ? value.corruptFiles : []) {
      out.push("  - " + (f.file || "（未知路径）") + (f.error ? "（" + f.error + "）" : ""));
    }
    out.push("  " + CORRUPT_WRITE_HINT.replace(/^；/, ""));
  }
  if (Array.isArray(value.added) && value.added.length > 0) out.push("", "新增 " + value.added.length + " 条：" + value.added.slice(0, 30).join("、") + (value.added.length > 30 ? " …" : ""));
  if (Array.isArray(value.updated) && value.updated.length > 0) out.push("更新 " + value.updated.length + " 条：" + value.updated.slice(0, 30).join("、"));
  if (Array.isArray(value.skipped) && value.skipped.length > 0) out.push("跳过（已存在，未覆盖）" + value.skipped.length + " 条：" + value.skipped.slice(0, 30).join("、"));
  if (Array.isArray(value.removed) && value.removed.length > 0) out.push("删除 " + value.removed.length + " 条：" + value.removed.slice(0, 30).join("、"));
  if (Array.isArray(value.candidates) && value.candidates.length > 0) {
    out.push("", "【候选词】（来自本书正文高频词，exists=已在词表中）");
    for (const c of value.candidates) out.push("  - " + c.term + " ×" + c.count + (c.exists ? "（已登记）" : ""));
  }
  if (value.audit) {
    const a = value.audit;
    out.push("", "【用词审计】" + (a.scopeText ? a.scopeText + "：" : "") + "必用词 " + a.total + " 条，命中 " + a.coveredCount + " 条（覆盖率 " + a.coverage + "%）");
    // v6.2.0 修正（增量清单第 9 条）：全书模式的行号带章名（逐章审计的行号 = 该章文件内的真实行号）
    const lineLabel = (x) => (x.firstChapter ? x.firstChapter + " L" : "L") + x.firstLine;
    if (a.covered.length > 0) out.push("  已用：" + a.covered.slice(0, 20).map((x) => x.term + "×" + x.count + "(首见 " + lineLabel(x) + ")").join("、"));
    if (a.missing.length > 0) out.push("  **未使用**：" + a.missing.map((x) => x.term + (x.priority === "high" ? "★" : "")).join("、"));
    if (a.avoidHits.length > 0) {
      out.push("  **通用词顶替**（该处本该用必用词）：");
      for (const hit of a.avoidHits.slice(0, 15)) out.push("    - " + (hit.chapter ? hit.chapter + " " : "") + "L" + hit.line + " 「" + hit.word + "」→ 应写成「" + hit.term + "」：" + hit.snippet);
    } else if (a.missing.length === 0 && a.total > 0) {
      out.push("  未发现通用词顶替，且必用词全部命中 ✓");
    }
    // v6.4.0（P1-2）：结论旁边写清边界——否则「覆盖率 100% / 全部命中 ✓」会被读成「这章用词没问题」
    out.push("  " + LEXICON_AUDIT_SCOPE_NOTE);
  }
  out.push("</content>");
  return out.join("\n");
}

/**
 * v6.2.1：把「词表文件损坏」透传到工具返回体。
 *
 * core.readLexiconFile / readLexicon 已把「读不出内容」拆成 missing（ENOENT）与 corrupt（JSON 解析失败）：
 * 损坏时它们返回 corrupt:true（+ corruptError / corruptFiles）与一张空表。工具侧若不透传，用户看到的就是
 * 「尚不存在 / 空表」，不知道文件其实坏了、也不知道写操作已被拒。source 可以是两者的返回值。
 */
function corruptFields(source, fileFallback) {
  if (source?.corrupt !== true) return {};
  const files = Array.isArray(source.corruptFiles) && source.corruptFiles.length > 0
    ? source.corruptFiles
    : [{ file: fileFallback ?? source.file ?? "", error: source.corruptError ?? "读取或解析失败" }];
  return { corrupt: true, corruptFiles: files };
}

/** v6.2.1：损坏层的写操作提示（工具侧参数名 force，路由侧为 overwrite）。 */
const CORRUPT_WRITE_HINT = "；写操作默认被拒以免覆盖原条目——确认要丢弃其内容时，请先备份该文件，再用 force=true 重写（HTTP 路由侧为 overwrite:true）";

/**
 * v6.4.0（P1-2）：`novel_lexicon action=audit` 的**职责边界**文案（单一事实源，message 与渲染层共用）。
 *
 * 为什么必须写在审计结论旁边：audit 只审「必用词表」的覆盖率与通用替身词，与世界观禁用词（禁词/语用规范）
 * 完全没有关系。旧版把「覆盖率 100%」当结论抛给用户，用户自然会读成「这章用词没问题」——
 * 而「掌柜」「多谢提点」这类禁词命中根本不在审计范围内，属于典型的假安心。
 * 边界只有写在结论旁边才有用，不能只放在 description 里。
 */
const LEXICON_AUDIT_SCOPE_NOTE = "注意：本审计只覆盖必用词表（覆盖率与通用替身词），不含世界观禁用词（novel_settings category=worldview 的 bannedWords / speechStyle）——查禁用词请用 novel_continuity_check：不带 chapter 审全书，带 chapter 只审该章。";

/**
 * v6.2.0 修正（增量清单第 7 条）：词表五个写 action 的「读—改—写」整体事务化。
 *
 * `writeLexicon` 只保证写入本身串行（atomicWriteJson），读与写之间没有互斥：同进程两个 add 并发时
 * 双方都基于同一旧快照合并，后写者整体覆盖前者（丢更新）。这里按「涉及层的词表文件」加锁——
 * 键与 `writeLexicon` 落盘文件同源（lexiconFile），并按键名排序后依次加锁，避免多把锁的死锁。
 * 注：HTTP 路由侧（core.js 的 `/lexicon` POST）仍只走 atomicWriteJson，要与工具侧互斥需它同样改用本函数。
 */
async function withLexiconTx(root, books, fn) {
  const keys = [...new Set(books.map((b) => lexiconFile(root, b)))].sort();
  const run = (i) => (i >= keys.length ? fn() : withFileTx(keys[i], () => run(i + 1)));
  return await run(0);
}

/**
 * v6.2.0 修正（增量清单第 9 条）：全书审计的逐章合并。
 *
 * 旧实现把各章首尾拼成一份文本再取行号，报出的 Lx 既不是任何文件的真实行号、也不带章名
 * （同一字段口径随 chapter 取值而变）。这里改为逐章审计后合并：行号是该章文件内的真实行号，
 * covered 附 firstChapter（首个命中它的章）、avoidHits 附 chapter；覆盖率口径与单章模式一致
 * （命中的词条数 / 词表条数）。
 */
function mergeChapterAudits(parts) {
  const coveredMap = new Map();
  const missingMap = new Map();
  const avoidHits = [];
  let total = 0;
  for (const part of parts) {
    const a = part.audit;
    total = Math.max(total, a.total);
    for (const c of a.covered) {
      const prev = coveredMap.get(c.term);
      if (prev) prev.count += c.count;
      else coveredMap.set(c.term, { ...c, firstChapter: part.label });
    }
    for (const m of a.missing) if (!missingMap.has(m.term)) missingMap.set(m.term, m);
    for (const h of a.avoidHits) avoidHits.push({ ...h, chapter: part.label });
  }
  const covered = [...coveredMap.values()];
  // 任一章命中即算命中（missing 逐章各算一份，这里剔除已在别章命中的）
  const missing = [...missingMap.values()].filter((m) => !coveredMap.has(m.term));
  return {
    total,
    coveredCount: covered.length,
    missingCount: missing.length,
    coverage: total > 0 ? Math.round((covered.length / total) * 1000) / 10 : 100,
    covered,
    missing,
    avoidHits
  };
}

/**
 * v6.2.0：必用词表（lexicon）——把「某场景必须使用的专有名词 / 作者习惯用词」登记成表。
 *
 * 与世界观 bannedWords 的分工：worldview 管"不要写什么"（禁词，为文化基准一致），
 * 本表管"必须写什么"（优先词，为模仿作者的用词习惯）。两者互补，不重复。
 *
 * 三层生效链：① 开写包（novel_chapter_brief）把它作为硬清单注入 → ② 系统提示词纪律 →
 * ③ 成稿 audit 扫覆盖率与"通用替身词"顶替位置，把"AI 退回通用说法"这件事变成可定位的行号。
 * 边界：只读写词表 + 只读审计，**不改正文、不生成文本**（生成是宿主模型的事）。
 */
function registerNovelLexicon(ctx, config) {
  ctx.tools.register({
    name: "novel_lexicon",
    description: "必用词表：管理专名与惯用词（书级覆盖 _global），优先用表内词。lexiconFirst 默认开，注入开写包。audit 只审必用词与替身，不含世界观禁用词（查禁词用 novel_continuity_check）。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "update", "delete", "import", "scan", "audit", "export", "toggle"], description: "操作" },
        book: { type: "string", description: "书名(global可省)" },
        scope: { type: "string", enum: ["book", "global", "all"], description: "层(写book/list all)" },
        terms: { type: "array", items: { type: "string" }, description: "add/delete词数组(词|类型|场景|替身|备注)" },
        text: { type: "string", description: "import/add文本(#注释)" },
        term: { type: "string", description: "目标词" },
        newTerm: { type: "string", description: "新词名" },
        kind: { type: "string", description: `类型(${LEXICON_KINDS.join("/")}/自定)` },
        scene: { type: "string", description: "适用场景" },
        note: { type: "string", description: "备注" },
        avoid: { oneOf: [{ type: "array", items: { type: "string" } }, { type: "string" }], description: "替身词" },
        aliases: { oneOf: [{ type: "array", items: { type: "string" } }, { type: "string" }], description: "等价词" },
        priority: { type: "string", enum: ["high", "normal"], description: "优先级" },
        enabled: { type: "boolean", description: "层/条启停" },
        force: { type: "boolean", description: "损坏时强覆盖" },
        overwrite: { type: "boolean", description: "覆盖同名(默认true)" },
        replace: { type: "boolean", description: "import整层替换" },
        all: { type: "boolean", description: "delete清空(须true)" },
        chapter: { type: "string", description: "audit章(all/省末章)" },
        query: { type: "string", description: "过滤词" },
        limit: { type: "integer", description: "条数上限" },
        offset: { type: "integer", description: "偏移" },
        root: { type: "string", description: "书库根" }
      },
      required: ["action"],
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string" },
          message: { type: "string" },
          counts: { type: "object", additionalProperties: true, description: "{ book, global, effective }" },
          enabled: { type: "boolean", description: "被操作那一层的开关状态。" },
          // v6.2.0 修正（增量清单第 10 条）：合并层没有「那一层」——分列两层开关；audit 的插件级开关独立成键
          layers: { type: "object", additionalProperties: true, description: "list（合并两层）时的各层开关：{ book, global }；单层查询与写操作不返回。" },
          lexiconFirst: { type: "boolean", description: "audit 专用：插件级「必用词优先」开关（lexiconFirst）当前状态。" },
          // v6.2.1：词表文件损坏（不是合法 JSON）时显式告知——避免用户把「读不出来」当成「这层是空的」
          corrupt: { type: "boolean", description: "是否有词表文件损坏（JSON 解析失败）。损坏层按空表处理，且写操作默认拒写（需 force=true / overwrite=true 才允许覆盖）。" },
          corruptFiles: { type: "array", items: { type: "object", additionalProperties: false, properties: { file: { type: "string" }, error: { type: "string" } }, required: ["file"] }, description: "损坏的文件与原因 [{ file, error }]，仅在 corrupt=true 时返回。" },
          files: { type: "object", additionalProperties: true, description: "{ book?, global? } 词表文件绝对路径。" },
          entries: { type: "array", items: { type: "object", additionalProperties: true }, description: "词条列表 [{ term, kind?, scene?, note?, avoid?, aliases?, priority?, enabled?, scope? }]" },
          added: { type: "array", items: { type: "string" } },
          updated: { type: "array", items: { type: "string" } },
          skipped: { type: "array", items: { type: "string" } },
          removed: { type: "array", items: { type: "string" } },
          candidates: { type: "array", items: { type: "object", additionalProperties: false, properties: { term: { type: "string" }, count: { type: "integer" }, exists: { type: "boolean" } }, required: ["term"] }, description: "scan 的候选词 [{ term, count, exists }]" },
          audit: { type: "object", additionalProperties: true, description: "audit 结果 { total, coveredCount, missingCount, coverage, covered[], missing[], avoidHits[] }。**只覆盖必用词表，不含世界观禁用词**（禁用词用 novel_continuity_check）" }
        },
        required: ["action", "message"]
      },
      render: (_args, value) => [{ type: "text", text: formatLexicon(value) }]
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_lexicon");
      const action = requiredString(args, "action");
      const root = resolveRoot(config, args, exec);
      const scopeArg = optionalString(args, "scope");
      const scope = scopeArg === "global" ? "global" : scopeArg === "all" ? "all" : "book";
      const bookArg = optionalString(args, "book");
      // v7.3.1 修（#23）：optionalString 已经 trim、空白串返回 undefined，故后半 `bookArg.trim() !== ""` 恒真，删掉。
      const book = bookArg !== void 0 ? sanitizeSegment(bookArg, "book") : "";
      const shared = {};
      for (const key of ["kind", "scene", "note", "priority"]) {
        const value = optionalString(args, key);
        if (value !== void 0 && value.trim() !== "") shared[key] = value.trim();
      }
      for (const key of ["avoid", "aliases"]) {
        if (Array.isArray(args?.[key])) shared[key] = args[key].map(String);
        else if (typeof args?.[key] === "string") {
          shared[key] = args[key].split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
        }
      }
      const layerBook = (layer) => (layer === "global" ? GLOBAL_LEXICON_BOOK : book);
      const requireBook = () => {
        assert(book !== "", "缺少 book 参数（只有 scope=global 的操作可以省略书名）");
        return book;
      };
      // 把 mixed 输入（字符串/行文本/对象）统一成词条数组
      const collectIncoming = () => {
        const incoming = [];
        if (Array.isArray(args?.terms)) {
          for (const raw of args.terms) {
            if (raw === null || raw === void 0) continue;
            if (typeof raw === "string") {
              // v6.2.0 修正（增量清单第 21 条）：`#` 注释行的口径原来只写在 text 参数上——
              // parseLexiconLine 对注释行返回 null，这里却被 `?? { term: raw }` 兜底成字面词条
              // （「#这是注释吗」会被登记并在开写包里当硬清单注入）。两个参数统一跳过注释行。
              const parsed = parseLexiconLine(raw);
              if (parsed === null) continue;
              incoming.push({ ...shared, ...parsed });
            } else incoming.push({ ...shared, ...raw });
          }
        }
        if (typeof args?.text === "string") {
          for (const line of args.text.split(/\r?\n/)) {
            const parsed = parseLexiconLine(line);
            if (parsed !== null) incoming.push({ ...shared, ...parsed });
          }
        }
        return normalizeLexiconList(incoming);
      };

      if (action === "list") {
        const limit = optionalInt(args, "limit", 1, 1000, 200);
        const offset = optionalInt(args, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
        // list 的默认作用层是 all（合并两层）——未给书名时退化为只读全局层，不报错
        const listScope = scopeArg === "global" ? "global" : scopeArg === "book" ? "book" : "all";
        let entries = [];
        let counts = { book: 0, global: 0, effective: 0 };
        let files = {};
        let enabled = true;
        let layers = null;
        let corruptInfo = {};
        if (listScope === "global" || (listScope === "all" && book === "")) {
          const f = await readLexiconFile(root, GLOBAL_LEXICON_BOOK);
          entries = f.entries.map((e) => ({ ...e, scope: "global" }));
          counts = { book: 0, global: f.entries.length, effective: f.entries.length };
          files = { global: f.file };
          enabled = f.enabled;
          corruptInfo = corruptFields(f, f.file);
        } else if (listScope === "book") {
          const f = await readLexiconFile(root, requireBook());
          entries = f.entries.map((e) => ({ ...e, scope: "book" }));
          counts = { book: f.entries.length, global: 0, effective: f.entries.length };
          files = { book: f.file };
          enabled = f.enabled;
          corruptInfo = corruptFields(f, f.file);
        } else {
          const lex = await readLexicon(root, book);
          entries = lex.entries;
          counts = lex.counts;
          files = lex.files;
          // v6.2.0 修正（增量清单第 10 条）：合并层没有「那一层」的开关——旧版这里恒回 enabled:true，
          // 两层都关掉时仍渲染「本层开关：开」。改为分列各层（与路由侧 bookEnabled/globalEnabled 同口径）。
          layers = { book: lex.book.enabled, global: lex.global.enabled };
          // v6.2.1：损坏层上浮（core 已给 corrupt/corruptFiles）
          corruptInfo = corruptFields(lex);
        }
        const query = (optionalString(args, "query") ?? "").trim();
        if (query !== "") {
          entries = entries.filter((e) => [e.term, e.kind, e.scene, e.note].some((v) => typeof v === "string" && v.includes(query)) || (Array.isArray(e.avoid) && e.avoid.some((w) => w.includes(query))));
        }
        const total = entries.length;
        const page = entries.slice(offset, offset + limit);
        // v6.2.0 修正（增量清单第 20 条）：offset 越界时 page 为空而 total>page.length 仍成立，
        // 旧文案会给出倒序区间「第 100–99 条」；同时点明 counts 是层内总量（不随 query 过滤变化）。
        const pageNote = page.length === 0 && total > 0
          ? `（offset=${offset} 超出范围，本次未返回词条）`
          : total > page.length
            ? `（本次返回第 ${offset + 1}–${offset + page.length} 条）`
            : "";
        const queryNote = query !== "" ? `（已按 query 过滤；counts 为未过滤的层内/两层总量）` : "";
        // v6.2.1：损坏层不能被读成「这层是空的」
        const corruptNote = corruptInfo.corrupt === true ? "（注意：有词表文件损坏，本次按空表处理——详见 corruptFiles）" : "";
        return {
          action,
          message: `词表共 ${total} 条${pageNote}。${queryNote}${corruptNote}`,
          entries: page,
          counts,
          files,
          ...(layers === null ? { enabled } : { layers }),
          ...corruptInfo
        };
      }

      if (action === "add" || action === "import") {
        const target = scope === "global" ? GLOBAL_LEXICON_BOOK : requireBook();
        const incoming = collectIncoming();
        assert(incoming.length > 0, "没有可登记的词条：请传 terms 数组或 text 批量文本（每行一条）");
        // v6.2.0 修正（增量清单第 7 条）：读—改—写整体进 withFileTx（键与 writeLexicon 落盘文件同源）
        return await withLexiconTx(root, [target], async () => {
          const current = await readLexiconFile(root, target);
          const base = action === "import" && args?.replace === true ? [] : current.entries;
          const merged = mergeLexiconEntries(base, incoming, { overwrite: args?.overwrite !== false });
          // v6.2.1：损坏层默认拒写（core.writeLexicon 的守卫）；仅"已损坏"时 overwrite=true 才等价于确认丢弃
          const force = args?.force === true || (current.corrupt === true && args?.overwrite === true);
          const written = await writeLexicon(root, target, { entries: merged.entries, enabled: current.enabled, force });
          const own = await readLexicon(root, target === GLOBAL_LEXICON_BOOK ? "" : book);
          return {
            action,
            message: `${target === GLOBAL_LEXICON_BOOK ? "全局层" : "本书《" + book + "》"}：新增 ${merged.added.length} 条、更新 ${merged.updated.length} 条${merged.skipped.length > 0 ? "、跳过 " + merged.skipped.length + " 条（同名且 overwrite=false）" : ""}；该层现有 ${written.count} 条。启用后开写包会自动注入（开关：必用词优先，默认开）。`,
            added: merged.added,
            updated: merged.updated,
            skipped: merged.skipped,
            entries: normalizeLexiconList(written.entries).map((e) => ({ ...e, scope: target === GLOBAL_LEXICON_BOOK ? "global" : "book" })).slice(0, 50),
            counts: own.counts,
            files: { [target === GLOBAL_LEXICON_BOOK ? "global" : "book"]: written.file },
            enabled: written.enabled,
            ...corruptFields(own)
          };
        });
      }

      if (action === "update") {
        const term = requiredString(args, "term");
        const layers = scope === "global" ? ["global"] : scope === "all" ? ["book", "global"] : ["book"];
        if (layers.includes("book")) requireBook();
        // v6.2.0 修正（增量清单第 7 条）：改名/改字段的读—改—写进 withFileTx；
        // scope=all 会锁住两层词表文件（withLexiconTx 内按键名排序加锁，不会与单层操作死锁）
        return await withLexiconTx(root, layers.map(layerBook), async () => {
          const force = args?.force === true || args?.overwrite === true;
          let hit = null;
          for (const layer of layers) {
            const f = await readLexiconFile(root, layerBook(layer));
            // v7.4.0（#50）：损坏层未传 force/overwrite 时先走 writeLexicon 统一抛出 ENOVELWRITEFAIL 并保留原文件，
            // 避免在空 entries 上直接报「找不到词条」而吞掉损坏事实。
            if (f.corrupt === true && !force) {
              await writeLexicon(root, layerBook(layer), { entries: f.entries, enabled: f.enabled, force: false });
            }
            const index = f.entries.findIndex((e) => e.term === term);
            if (index >= 0) { hit = { layer, file: f, index }; break; }
          }
          assert(hit !== null, `词表中找不到词条「${term}」（用 action=list 查看现有词条）`);
          const patch = { ...shared };
          const newTerm = optionalString(args, "newTerm");
          if (newTerm !== void 0 && newTerm.trim() !== "") patch.term = newTerm.trim();
          if (typeof args?.enabled === "boolean") patch.enabled = args.enabled;
          const list = hit.file.entries.slice();
          // v6.2.0 修正（增量清单第 6 条）：改名先查同层是否已有同名条目——落盘时 normalizeLexiconList
          // 对同名条目按「后写覆盖前写」合并，旧版会让改名条目被原同名条目整体覆盖（字段全丢且无冲突告警）。
          let replaced = "";
          if (patch.term !== void 0 && patch.term !== term) {
            const clash = list.findIndex((e, i) => i !== hit.index && e.term === patch.term);
            if (clash !== -1) {
              assert(args?.overwrite === true, `该层已有词条「${patch.term}」：直接改名会与它合并、丢掉「${term}」的既有字段（aliases/priority/enabled 等）。请换一个名字，或显式传 overwrite=true 用「${term}」覆盖「${patch.term}」。`);
              replaced = patch.term;
              list.splice(clash, 1);
              if (clash < hit.index) hit.index -= 1; // 删除点在本条之前：索引左移，仍指向原条目
            }
          }
          // v7.3.3 修（#4）：规范化（term 为空/超过 60 字时返回 null）被拒就是**整体失败**，
          // 不能再 `?? list[hit.index]` 静默回退；否则后续仍报「已更新」+ updated:[超长名]，
          // 且 enabled:false 会在回退之后无条件执行——用户看到"成功"，名字没改，条目却被暗地停用。
          const nextEntry = normalizeLexiconEntry({ ...list[hit.index], ...patch });
          assert(nextEntry !== null, "更新后的词条未通过规范化（term 为空或超过 60 字）：本次修改全部未写入，词条保持原样。请把 newTerm 控制在 60 字以内");
          list[hit.index] = nextEntry;
          if (args?.enabled === false) list[hit.index].enabled = false;
          // v6.2.1：损坏层默认拒写（仅明确 force / overwrite 才允许覆盖）
          const written = await writeLexicon(root, layerBook(hit.layer), { entries: list, enabled: hit.file.enabled, force });
          const own = await readLexicon(root, scope === "global" ? "" : book);
          return {
            action,
            message: `已更新${hit.layer === "global" ? "全局层" : "本书"}词条「${term}」${patch.term ? " → 「" + patch.term + "」" : ""}${replaced ? "（原「" + replaced + "」已被覆盖）" : ""}；该层现有 ${written.count} 条。`,
            updated: [patch.term ?? term],
            entries: normalizeLexiconList(written.entries).map((e) => ({ ...e, scope: hit.layer })).slice(0, 50),
            counts: own.counts,
            files: { [hit.layer]: written.file },
            enabled: written.enabled,
            ...corruptFields(own)
          };
        });
      }

      if (action === "delete") {
        const target = scope === "global" ? GLOBAL_LEXICON_BOOK : requireBook();
        const wanted = new Set();
        if (typeof args?.term === "string" && args.term.trim() !== "") wanted.add(args.term.trim());
        for (const t of Array.isArray(args?.terms) ? args.terms : []) if (String(t).trim() !== "") wanted.add(String(t).trim());
        const clearAll = args?.all === true;
        assert(clearAll || wanted.size > 0, "delete 需要 terms（或 term）指定词条；要整层清空请显式传 all=true");
        // v6.2.0 修正（增量清单第 7 条）：读—改—写进 withFileTx
        return await withLexiconTx(root, [target], async () => {
          const current = await readLexiconFile(root, target);
          // v6.2.1 / v7.4.0（#50）：损坏层未传 force/overwrite 时统一抛出 ENOVELWRITEFAIL；
          // all=true && force=true 时允许直接写入空表重建，跳过空 entries 的「不在词表中」断言。
          const force = args?.force === true || args?.overwrite === true;
          if (current.corrupt === true) {
            if (!(clearAll && force)) {
              await writeLexicon(root, target, { entries: current.entries, enabled: current.enabled, force: false });
            }
            const written = await writeLexicon(root, target, { entries: [], enabled: current.enabled, force: true });
            const own = await readLexicon(root, target === GLOBAL_LEXICON_BOOK ? "" : book);
            return {
              action,
              message: `已强制清空损坏的${target === GLOBAL_LEXICON_BOOK ? "全局层" : "本书"}词表并重建空表（原损坏内容已丢弃）。`,
              removed: [],
              counts: own.counts,
              files: { [target === GLOBAL_LEXICON_BOOK ? "global" : "book"]: written.file },
              enabled: written.enabled,
              ...corruptFields(own)
            };
          }
          const removed = [];
          const kept = current.entries.filter((e) => {
            if (clearAll || wanted.has(e.term)) { removed.push(e.term); return false; }
            return true;
          });
          assert(removed.length > 0, `这些词条不在${target === GLOBAL_LEXICON_BOOK ? "全局层" : "本书"}词表中：` + [...wanted].join("、"));
          const written = await writeLexicon(root, target, { entries: kept, enabled: current.enabled, force });
          const own = await readLexicon(root, target === GLOBAL_LEXICON_BOOK ? "" : book);
          return {
            action,
            message: `已从${target === GLOBAL_LEXICON_BOOK ? "全局层" : "本书"}删除 ${removed.length} 条；该层现有 ${written.count} 条。`,
            removed,
            counts: own.counts,
            files: { [target === GLOBAL_LEXICON_BOOK ? "global" : "book"]: written.file },
            enabled: written.enabled,
            ...corruptFields(own)
          };
        });
      }

      if (action === "scan") {
        requireBook();
        const limit = optionalInt(args, "limit", 1, 400, 60);
        const { text } = await readBookAllText(root, book, exec);
        const lex = await readLexicon(root, book);
        const existing = new Set(lex.entries.map((e) => e.term));
        const candidates = extractKeywords(text, 400).map((k) => ({ term: k.word, count: k.count, exists: existing.has(k.word) })).slice(0, limit);
        const fresh = candidates.filter((c) => !c.exists).length;
        const corruptNote = lex.corrupt === true ? "（注意：有词表文件损坏，已登记状态可能不完整——详见 corruptFiles）" : "";
        return {
          action,
          message: `《${book}》正文高频词候选 ${candidates.length} 条（其中 ${fresh} 条尚未登记）。挑要模仿的词条，用 action=add（terms 数组，可批量）登记；专名建议 kind=专名 并补 avoid 通用替身词。${corruptNote}`,
          candidates,
          counts: lex.counts,
          ...corruptFields(lex)
        };
      }

      if (action === "audit") {
        requireBook();
        const chapterArg = optionalString(args, "chapter");
        const dir = bookDir(root, book);
        const lex = await readLexicon(root, book);
        const state = await readSentenceState();
        const lexiconOn = featureEnabled(state, "lexiconFirst");
        let text = "";
        let scopeText = "";
        let audit = null;
        if (chapterArg === "all" || chapterArg === "全书") {
          const chapters = await scanChapters(dir);
          // v6.2.0 修正（增量清单第 8 条）：旧版 all 分支不校验章节数，在有目录但无章节的书上给出
          // 「必用词 1 条 → 命中 0 条（覆盖率 0%）」这种伪审计结论，而单章分支会报错；这里与单章分支同口径断言。
          assert(chapters.length > 0, `作品「${book}」没有章节文件`);
          scopeText = "全书 " + chapters.length + " 章";
          // v6.2.0 修正（增量清单第 9 条）：逐章审计再合并——旧版把各章首尾拼成一份文本后取行号，
          // 报出的 Lx 既不是任何文件的真实行号、也没有章名（同一字段口径随 chapter 取值而变）。
          const parts = [];
          for (const chapter of chapters) {
            const chapterText = await readTextFile(join(dir, chapter.file), exec);
            parts.push({ label: "第" + (chapter.number ?? "?") + "章", audit: auditLexicon(lex.entries, chapterText, "") });
          }
          audit = mergeChapterAudits(parts);
        } else {
          const chapters = await scanChapters(dir);
          assert(chapters.length > 0, `作品「${book}」没有章节文件`);
          const target = chapterArg !== void 0 && chapterArg.trim() !== "" ? findChapter(chapters, chapterArg) : chapters[chapters.length - 1];
          assert(target !== void 0, `在作品「${book}」中找不到章节「${chapterArg}」（可用 novel_chapters 查看章节列表）`);
          text = await readTextFile(join(dir, target.file), exec);
          scopeText = "第 " + (target.number ?? "?") + " 章《" + (target.title || target.file) + "》";
          audit = auditLexicon(lex.entries, text, "");
        }
        // v6.4.0（P1-2）：审计结论必须自带职责边界（旧版只报覆盖率，用户会读成"这章用词没问题"）
        const summary = audit.total === 0
          ? "词表为空：先用 action=add 登记必用词，再来审计。" + LEXICON_AUDIT_SCOPE_NOTE
          : `必用词 ${audit.total} 条 → 命中 ${audit.coveredCount} 条（覆盖率 ${audit.coverage}%），未使用 ${audit.missingCount} 条，通用词顶替 ${audit.avoidHits.length} 处。` +
            (audit.avoidHits.length > 0 ? "顶替处即「本该用必用词却写成通用说法」的位置，按行号逐处改。" : "") +
            (lexiconOn ? "" : "（注意：「必用词优先」开关当前是关闭状态，本次只是审计未生效的词表。）") +
            "审计为只读，不改正文。" + LEXICON_AUDIT_SCOPE_NOTE;
        return {
          action,
          message: `${scopeText}：${summary}`,
          audit: { scopeText, ...audit },
          counts: lex.counts,
          files: lex.files,
          // v6.2.0 修正（增量清单第 10 条）：这个键装的从来不是「被操作那一层的开关」，而是插件级
          // 「必用词优先」开关——换成独立键名，渲染层不再统一打成「本层开关」（语义串味）。
          lexiconFirst: lexiconOn,
          // v6.2.1：损坏层会让覆盖率失真（读到的是空表），必须一并告知
          ...corruptFields(lex)
        };
      }

      if (action === "export") {
        const target = scope === "global" ? GLOBAL_LEXICON_BOOK : requireBook();
        const f = await readLexiconFile(root, target);
        return {
          action,
          // v6.2.1：损坏时不能说「尚不存在」——exists 为 true 而内容是坏的，交给 corruptFiles 说明
          message: `${target === GLOBAL_LEXICON_BOOK ? "全局层" : "本书《" + book + "》"}词表导出：${f.entries.length} 条` +
            (f.exists ? "" : "（该层文件尚不存在，以下为空表）") +
            (f.corrupt === true ? "（该层文件损坏，本次按空表导出）" : ""),
          entries: f.entries.map((e) => ({ ...e, scope: target === GLOBAL_LEXICON_BOOK ? "global" : "book" })),
          counts: { book: target === GLOBAL_LEXICON_BOOK ? 0 : f.entries.length, global: target === GLOBAL_LEXICON_BOOK ? f.entries.length : 0, effective: f.entries.length },
          files: { [target === GLOBAL_LEXICON_BOOK ? "global" : "book"]: f.file },
          enabled: f.enabled,
          ...corruptFields(f, f.file)
        };
      }

      if (action === "toggle") {
        const target = scope === "global" ? GLOBAL_LEXICON_BOOK : requireBook();
        assert(typeof args?.enabled === "boolean", "toggle 需要 enabled=true/false");
        // v6.2.0 修正（增量清单第 7 条）：读—改—写进 withFileTx
        return await withLexiconTx(root, [target], async () => {
          const f = await readLexiconFile(root, target);
          // v6.2.1：损坏层默认拒写（toggle 的确认参数就是 force / overwrite）
          const force = args?.force === true || (f.corrupt === true && args?.overwrite === true);
          const written = await writeLexicon(root, target, { entries: f.entries, enabled: args.enabled, force });
          const own = await readLexicon(root, target === GLOBAL_LEXICON_BOOK ? "" : book);
          const state = await readSentenceState();
          return {
            action,
            message: `${target === GLOBAL_LEXICON_BOOK ? "全局层" : "本书"}词表已${args.enabled ? "开启" : "关闭"}（${written.count} 条）。` +
              `整插件级的功能开关是「必用词优先」lexiconFirst（当前${featureEnabled(state, "lexiconFirst") ? "开" : "关"}），用 novel_sentence_config 的 features:{lexiconFirst:true/false} 或侧边栏开关。`,
            counts: own.counts,
            files: { [target === GLOBAL_LEXICON_BOOK ? "global" : "book"]: written.file },
            enabled: written.enabled,
            ...corruptFields(own)
          };
        });
      }

      throw new Error("未知 action：" + action + "（可用：list/add/update/delete/import/scan/audit/export/toggle）");
    }
  });
}

export {
  registerNovelNewChapter,
  registerNovelChapterBrief,
  registerNovelDraft,
  registerNovelOutline,
  registerNovelLexicon,
  formatLexicon,
  corruptFields,
  withLexiconTx,
  mergeChapterAudits,
  safeTitleSegment,
  isLeanWorkflow
};
