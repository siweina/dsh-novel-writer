/**
 * dsh-novel-writer — lib/tools/story.js（设定表、章节摘要、伏笔表与语义检索工具）
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { analyzeText } from "../analysis.js";
import { computeVibe } from "../vibe.js";
import { CULTURE_MARKERS, SPEECH_STYLE_RULES } from "../lexicons/markers.js";
import { buildStoryGraph } from "../graph.js";
import * as embedding from "../embedding.js";
import { logEvent } from "../log.js";
import { assert, assertToolEnabled, atomicWriteJson, bookDir, cleanOutput, cleanSummaryEntry, detectCulture, detectGenre, detectTheme, featureEnabled, findChapter, hintCulture, isAbort, isValidPackId, listPacks, loadPack, normalizeChapterKey, normalizePlotEntry, normalizeSettingEntry, normalizeSettingList, noteRoot, optionalString, parseChapterNumber, plotKeywords, plotsFile, readPlots, readSentenceState, readSettings, readSummaries, readTextFile, requiredString, resolveAmbiguousCarriers, resolvePackForBook, resolveRoot, sanitizeSegment, scanChapters, semanticFeatureEnabled, settingsFile, summariesFile, validatePattern, withFileTx, writePlots, writeSettings } from "../core.js";
import { dropNullDeep } from "./shared.js";

/**
 * v7.3.3 修（#28）：登记/更新语用规范时，仪式正则也要过 `validatePattern`。
 * 旧版只有扫描（continuity_check）与 fixplan 校验，register 路径直接收下非法模式——
 * 用户以为登记成功了，直到真正扫描才炸（或卡死）。这里与扫描侧同一判据：reject 即拒绝登记并明确报错。
 */
function assertRitualPatternsValid(speechStyle) {
  if (!speechStyle || !Array.isArray(speechStyle.ritualBadPatterns)) return;
  // v7.3.3（#28）：登记阶段只拦「**扫起来会卡死或根本跑不了**」的模式，放行「只是误报风险大」的模式。
  //
  // 为什么要按 `code` 分而不是按 `level === "reject"` 一刀切：validatePattern 的 reject 是**扫描语境**下的
  // 语义（「这条模式不参与扫描」），不等于「不许登记」。两类典型：
  //   · `(a+)+` / `a*a*a*` → code "redos"：嵌套量词/多项式回溯，扫一章能跑到几十秒，**必须登记时就拦**；
  //   · `上.*香`           → code "wildcard"：会跨句误报，但**用户的既定契约是「登记照收、扫描时列为
  //                          『未生效候选』并说明原因」**（`false-positive-test.mjs` 正是先登记成功、再断言
  //                          扫描报「未生效」）。在这里拒绝登记会把这条既有能力直接砍掉，也会让存量
  //                          settings.json 里这类模式在下次 update 时突然报错。
  for (let i = 0; i < speechStyle.ritualBadPatterns.length; i += 1) {
    const pattern = speechStyle.ritualBadPatterns[i];
    const verdict = validatePattern(pattern);
    if (verdict.ok) continue;
    // syntax / empty / too-long / exec-throws / redos → 拒绝登记；wildcard → 放行（扫描侧会披露）
    if (verdict.code === "wildcard") continue;
    assert(false, "speechStyle.ritualBadPatterns[" + i + "] 无法用于扫描：/" + String(pattern) + "/ — " + verdict.reason
      + (verdict.suggestion ? "。建议：" + verdict.suggestion : ""));
  }
}
function registerNovelSettings(ctx, config) {
  ctx.tools.register({
    name: "novel_settings",
    description: "五表设定管理（character/location/item/timeline/worldview）。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名" },
        category: { type: "string", enum: ["character", "location", "item", "timeline", "worldview"], description: "表类别(detect固定worldview)" },
        action: { type: "string", enum: ["list", "add", "update", "delete", "scan", "detect", "packs"], description: "操作(scan提候选/detect判基准/packs列题材包)" },
        name: { type: "string", description: "条目名(timeline用day)" },
        description: { type: "string", description: "描述" },
        traits: { type: "string", description: "性格外貌" },
        relationships: { type: "string", description: "关系" },
        alias: { type: "array", items: { type: "string" }, description: "别名" },
        firstSeen: { type: "string", description: "首现章" },
        owner: { type: "string", description: "持有者" },
        status: { type: "string", description: "状态" },
        lastSeen: { type: "string", description: "近现章" },
        day: { type: "string", description: "timeline时间点(改名传name+day)" },
        event: { type: "string", description: "事件" },
        chapter: { type: "string", description: "章节" },
        notes: { type: "string", description: "备注" },
        basis: { type: "string", description: "文化基准" },
        pack: { type: "string", description: "题材包ID(worldview)" },
        ritual: { type: "string", description: "仪式规范" },
        speechStyle: { type: "object", additionalProperties: true, description: "语用JSON(title/honorBad/ritualBadPatterns/tone)" },
        bannedWords: { type: "array", items: { type: "string" }, description: "禁用词" },
        allowWords: { type: "array", items: { type: "string" }, description: "本书豁免词(仅限本书)" },
        recommended: { type: "object", additionalProperties: true, description: "替代词映射" },
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
          category: { type: "string" },
          action: { type: "string" },
          characters: { type: "array", items: { type: "object", additionalProperties: true } },
          locations: { type: "array", items: { type: "object", additionalProperties: true } },
          items: { type: "array", items: { type: "object", additionalProperties: true } },
          timeline: { type: "array", items: { type: "object", additionalProperties: true } },
          worldview: { type: "array", items: { type: "object", additionalProperties: true } },
          culture: { type: "string" },
          confidence: { type: "number" },
          scores: { type: "object", additionalProperties: true },
          evidence: { type: "object", additionalProperties: true },
          total: { type: "integer" },
          genre: { type: "object", additionalProperties: true },
          theme: { type: "object", additionalProperties: true },
          candidates: { type: "array", items: { type: "string" } },
          packs: { type: "array", items: { type: "object", additionalProperties: true } },
          activePack: { type: "object", additionalProperties: true },
          warnings: { type: "array", items: { type: "object", additionalProperties: true } },
          message: { type: "string" },
          vibe: { type: "object", additionalProperties: true }
        },
        required: ["book", "category", "action"]
      },
      render: (_args, value) => {
        const lines = [`<path>novels/${value.book}</path>`, "<type>novel-settings</type>", "<content>", ""];
        if (value.message) lines.push(value.message);
        if (value.action === "packs" || Array.isArray(value.packs)) {
          const packs = Array.isArray(value.packs) ? value.packs : [];
          if (value.activePack && value.activePack.id) {
            lines.push(`当前激活题材包：${value.activePack.name || value.activePack.id}（id: ${value.activePack.id}，来源: ${value.activePack.source || "unknown"}，文化基准: ${value.activePack.baseCulture || "未指定"}）`);
          } else {
            lines.push("当前激活题材包：无（使用设定表或默认基准）");
          }
          lines.push("", `可用题材包（${packs.length} 套）：`);
          for (const p of packs) {
            const aliases = Array.isArray(p.aliases) && p.aliases.length > 0 ? ` | 别名: ${p.aliases.slice(0, 6).join("/")}` : "";
            const bannedCount = Array.isArray(p.bannedWords) ? p.bannedWords.length : 0;
            const allowCount = Array.isArray(p.allowWords) ? p.allowWords.length : 0;
            const muteCats = Array.isArray(p.slopMuteCategories) && p.slopMuteCategories.length > 0 ? ` | 豁免套话类: ${p.slopMuteCategories.join(",")}` : "";
            const rejNote = Array.isArray(p.rejectedPatterns) && p.rejectedPatterns.length > 0 ? ` | 已剔除正则=${p.rejectedPatterns.length}` : "";
            const activeMark = value.activePack && value.activePack.id === p.id ? " ★当前生效" : "";
            lines.push(`  - [${p.source === "custom" ? "自定义" : "内置"}] ${p.id}（${p.name}）${activeMark}：基准=${p.baseCulture || "-"} | 禁词=${bannedCount} | 豁免=${allowCount}${muteCats}${rejNote}${aliases}${p.description ? " — " + p.description : ""}`);
          }
          if (Array.isArray(value.warnings) && value.warnings.length > 0) {
            lines.push("", `规则告警（${value.warnings.length} 条）：`);
            for (const w of value.warnings) lines.push(`  - [${w.id || w.file}] ${w.reason}`);
          }
          lines.push("", "</content>");
          return [{ type: "text", text: lines.join("\n") }];
        }
        const categoryLabel = { character: "人物卡", location: "地点卡", item: "道具清单", timeline: "时间线", worldview: "世界观/用语规范" }[value.category] ?? value.category;
        // v4.0.0 修正：按 category 取对应表（旧版 ?? 链因 list/scan 恒返回全部五张表而永不前进）
        const listKeyOf = { character: "characters", location: "locations", item: "items", timeline: "timeline", worldview: "worldview" }[value.category];
        const list = (listKeyOf && Array.isArray(value[listKeyOf]) ? value[listKeyOf] : null) ?? value.characters ?? value.locations ?? value.items ?? value.timeline ?? value.worldview ?? [];
        lines.push(`${categoryLabel}（${list.length} 条）：`);
        for (const e of list) {
          // v3.7.0 ⑧：无 day 不拼接 "undefined"
          const dayPart = e.day ? e.day + (e.event ? " " + e.event : "") : (e.event || "");
          const extra = [e.traits, e.description, e.relationships, e.owner, e.status, e.lastSeen, dayPart, e.basis, e.pack ? "题材包:" + e.pack : "", e.ritual, Array.isArray(e.bannedWords) ? "禁用词:" + e.bannedWords.join("/") : "", e.recommended ? "替代:" + Object.entries(e.recommended).map(([k, v]) => k + "→" + v).join("/") : ""].filter(Boolean).join(" | ");
          lines.push(`  - ${e.name}${extra ? "：" + extra : ""}${e.chapter ? "（" + e.chapter + "）" : ""}`);
        }
        if (value.culture && value.evidence) {
          lines.push(`判断结果：${value.message ?? value.culture}（西${value.scores?.western ?? 0} / 东${value.scores?.eastern ?? 0}）`);
          lines.push("证据：" + (value.evidence.western ?? []).slice(0, 5).join(" ") + " | " + (value.evidence.eastern ?? []).slice(0, 5).join(" "));
        }
        if (Array.isArray(value.candidates) && value.candidates.length > 0) {
          lines.push("", "扫描候选（供登记）：");
          for (const cand of value.candidates) lines.push("  ? " + cand);
        }
        if (value.vibe && Array.isArray(value.vibe.axes) && value.vibe.axes.length > 0) {
          lines.push("", "🎭 氛围光谱（v2.1.0）：");
          for (const ax of value.vibe.axes.slice(0, 5)) {
            const bar = "█".repeat(Math.round((ax.score ?? 0) * 12)).padEnd(12, "░");
            lines.push("  " + ax.name.padEnd(5) + " " + bar + " " + (ax.score ?? 0).toFixed(2));
          }
          if (value.vibe.conclusion) lines.push("  结论：" + value.vibe.conclusion + "（置信度 " + value.vibe.confidence + "）");
          if (value.vibe.evidence && value.vibe.evidence.length > 0) lines.push("  证据：" + value.vibe.evidence.join(" | "));
        }
        lines.push("", "</content>");
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_settings");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const isDetect = args?.action === "detect";
      const isPacks = args?.action === "packs";
      const category = (isDetect || isPacks) ? "worldview" : ["character", "location", "item", "timeline", "worldview"].includes(args?.category) ? args.category : "character";
      const action = ["add", "update", "delete", "scan", "detect", "packs"].includes(args?.action) ? args.action : "list";
      const root = resolveRoot(config, args, exec);
      // v3.9.5 修正：读-改-写事务化——并发 add/update/delete/scan 不再基于同一旧快照互相整表覆盖（丢更新）
      const settingsDataFile = settingsFile(root, book);
      // v6.2.0 修正（旧清单第 23 条）：事务体抽成函数，scan/detect/packs（纯读）在下方绕开写事务
      const runSettingsBody = async function () {
      const data = await readSettings(root, book);
      let message = "";
      const categoryLabel = { character: "人物卡", location: "地点卡", item: "道具清单", timeline: "时间线", worldview: "世界观/用语规范" }[category] ?? category;
      const listKey = { character: "characters", location: "locations", item: "items", timeline: "timeline", worldview: "worldview" }[category];
      const list = data[listKey];
      if (action === "packs") {
        const listed = listPacks(root);
        const reversedWorldview = (Array.isArray(data.worldview) ? data.worldview : []).filter((e) => e && typeof e === "object").slice().reverse();
        const packEntry = reversedWorldview.find((e) => typeof e.pack === "string" && e.pack.trim() !== "");
        const active = resolvePackForBook({ packId: packEntry ? packEntry.pack.trim() : "", book, root });
        const activePack = active ? {
          id: active.id,
          name: active.name,
          source: active.source,
          baseCulture: active.baseCulture,
          slopMuteCategories: Array.isArray(active.slopMuteCategories) ? active.slopMuteCategories.slice() : []
        } : null;
        const errNote = listed.errors.length > 0 ? `（另有 ${listed.errors.length} 个自定义包解析跳过）` : "";
        const warnNote = listed.warnings.length > 0 ? `（另有 ${listed.warnings.length} 条规则告警，含被剔除正则或继承截断）` : "";
        const activeNote = activePack ? `；当前激活：${activePack.name}（${activePack.id}）` : "；当前未激活题材包";
        return {
          book,
          category: "worldview",
          action: "packs",
          packs: listed.packs,
          ...(activePack ? { activePack } : {}),
          ...(listed.warnings.length > 0 ? { warnings: listed.warnings } : {}),
          message: `共 ${listed.packs.length} 套可用题材包${activeNote}${errNote}${warnNote}`
        };
      } else if (action === "add") {
        const name = optionalString(args, "name") ?? optionalString(args, "day");
        assert(name !== void 0, "novel_settings add 需要 name（timeline 用 day）参数");
        const entry = { name };
        // v3.7.0 ⑤：timeline 的 day 字段与 name 同步（update 双查/渲染都用 day，缺失会显示 undefined）
        if (category === "timeline") entry.day = name;
        for (const key of ["description", "traits", "relationships", "firstSeen", "owner", "status", "lastSeen", "event", "chapter", "notes", "basis", "ritual"]) {
          if (args?.[key] !== void 0) entry[key] = String(args[key]);
        }
        if (Array.isArray(args?.alias)) entry.alias = args.alias.map(String);
        if (Array.isArray(args?.bannedWords)) entry.bannedWords = args.bannedWords.map(String);
        if (args?.recommended !== void 0 && args.recommended !== null && typeof args?.recommended === "object") entry.recommended = { ...args.recommended };
        if (args?.ritual !== void 0) entry.ritual = String(args.ritual);
        let packNote = "";
        if (category === "worldview") {
          if (args?.pack !== void 0) {
            assert(typeof args.pack === "string", "novel_settings add 的 pack 必须是字符串");
            const packVal = args.pack.trim();
            if (packVal !== "") {
              assert(isValidPackId(packVal), "题材包 ID「" + packVal.slice(0, 40) + "」含非法字符（仅允许 1~64 位字母数字下划线连字符或中文，禁止 / \\ .. 与控制字符）");
              const matched = loadPack(packVal, root);
              entry.pack = packVal;
              packNote = matched
                ? `（已匹配题材包：${matched.name}[${matched.id}]）`
                : `（提示：未在内置或书库 packs 目录匹配到「${packVal}」，已保留设定待后续配置）`;
            }
          }
          // v6.5.0：本书用词豁免（allowWords）——「这个词在本书里是对的」的登记入口。
          // 过滤逻辑本身在 core.resolveStyleRule（单一裁决点，开写包/审计/改稿台共用），
          // 这里**只负责收下并净化输入**，不做任何过滤判定。
          // 净化不可省：这个字段会原样进静音集合，脏数据（null/数字/空白/超长/重复）会让
          // 静音表变成噪声——例如重复词会让 sources.muted 的计数虚高，用户读到的"静音了几个词"就是假的。
          if (args?.allowWords !== void 0) {
            const seenAllow = new Set();
            const allowList = [];
            for (const item of Array.isArray(args.allowWords) ? args.allowWords : []) {
              const w = String(item ?? "").trim().slice(0, 40);
              if (w === "" || seenAllow.has(w)) continue;
              seenAllow.add(w);
              allowList.push(w);
              if (allowList.length >= 200) break; // 上限：豁免表是给人看的，不该无限长
            }
            if (allowList.length > 0) entry.allowWords = allowList;
          }
          // v4.0.0 修正：补 null 判断（typeof null === "object" 时旧版会写入空 speechStyle，
          // 反而跳过下方按 basis 自动推导语用规范的分支）
          if (args?.speechStyle !== void 0 && args.speechStyle !== null && typeof args?.speechStyle === "object") {
            // 显式传入的 speechStyle 优先
            entry.speechStyle = { ...args.speechStyle };
            // v7.3.3 修（#28）：用户登记的正则当场校验（非法立即报错，不再等到扫描才炸）
            assertRitualPatternsValid(entry.speechStyle);
          } else {
            // v3.9.5 修正：自动语用规范改为“单一判定、一次赋值”。旧实现是两块独立逻辑：
            // 先按裸“中/东”正则把“中世纪”误判为 eastern 写入 speechStyle+ritual，
            // 第二块又按“欧/教堂”覆盖为 western，而 ritual 已写入 eastern 值 → 两字段来源分裂。
            const basisText = String(args?.basis ?? "");
            // v6.4.0（P0-4）：判据抽到 core.hintCulture —— 与 resolveStyleRule 决定「用哪张默认表」
            // 用的是**同一套**判据。此前这里是内联的三个正则，与审计侧各判一次，两边可能给出
            // 不同文化基准（登记时说西方、审计时按正文判成东方），词表方向就会反过来。
            const detected = hintCulture(basisText);
            if (detected.culture === "eastern") {
              entry.speechStyle = {
                title: SPEECH_STYLE_RULES.eastern.titleGuideline,
                honorBad: SPEECH_STYLE_RULES.eastern.honorBad,
                honorGood: { ...SPEECH_STYLE_RULES.eastern.honorGood },
                ritualBadPatterns: SPEECH_STYLE_RULES.eastern.ritualBadPatterns.map((x) => x.source),
                ritualGoodNote: SPEECH_STYLE_RULES.eastern.ritualGoodNote,
                tone: SPEECH_STYLE_RULES.eastern.toneGuideline
              };
              if (!entry.ritual) entry.ritual = SPEECH_STYLE_RULES.eastern.ritualGoodNote;
            } else if (detected.culture === "western") {
              entry.speechStyle = {
                title: SPEECH_STYLE_RULES.western.titleGuideline,
                honorBad: SPEECH_STYLE_RULES.western.honorBad,
                honorGood: { ...SPEECH_STYLE_RULES.western.honorGood },
                ritualBadPatterns: SPEECH_STYLE_RULES.western.ritualBadPatterns.map((x) => x.source),
                ritualGoodNote: SPEECH_STYLE_RULES.western.ritualGoodNote,
                tone: SPEECH_STYLE_RULES.western.toneGuideline
              };
              if (!entry.ritual) entry.ritual = SPEECH_STYLE_RULES.western.ritualGoodNote;
            }
          }
        }
        list.push(entry);
        message = `已登记 ${categoryLabel}：${name}${packNote}`;
        await writeSettings(root, book, data);
        // v1.0.2：add 返回单条
        const result = { book, category, action, message };
        result[listKey] = [normalizeSettingEntry(entry)];
        return result;
      } else if (action === "update" || action === "delete") {
        const name = optionalString(args, "name") ?? optionalString(args, "day");
        assert(name !== void 0, `novel_settings ${action} 需要 name（timeline 用 day）参数`);
        // v3.5.0 M10：timeline 条目 name=day 值——update 按新 day 传时双查（name 或 day 字段）
        // v4.0.0 修正：脏条目（null/标量）守卫——旧版 e.name 在坏数据上直接 TypeError 打挂整个工具
        const index = list.findIndex((e) => e && typeof e === "object" && (e.name === name || (category === "timeline" && e.day === name)));
        assert(index !== -1, category === "timeline"
          ? `${categoryLabel}中不存在「${name}」。timeline 的定位标识是登记时的 day（add 时与 name 同值）：update/delete 请传 name=旧标识；改名时同时传 name=旧标识 与 day=新标识。`
          : `${categoryLabel}中不存在「${name}」`);
        if (action === "delete") {
          list.splice(index, 1);
          message = `已删除 ${categoryLabel}：${name}`;
        } else {
          const oldDay = category === "timeline" ? list[index].day : void 0; // v3.9.0：改名同步前记录旧 day
          for (const key of ["description", "traits", "relationships", "firstSeen", "owner", "status", "lastSeen", "event", "chapter", "notes", "basis", "ritual"]) {
            if (args?.[key] !== void 0) list[index][key] = String(args[key]);
          }
          // v3.9.0 / v7.4.0（#14）：timeline 的 day 变更时先 .trim() 并校验非空，再同步 name
          if (args?.day !== void 0) {
            const nextDay = String(args.day ?? "").trim();
            assert(nextDay !== "", "novel_settings update 的 day 不能为空");
            list[index].day = nextDay;
            if (category === "timeline" && (list[index].name === oldDay || !list[index].name)) {
              list[index].name = nextDay;
            }
          }
          // v3.5.0 #13：speechStyle 对象字段（update 也要支持）
          if (args?.speechStyle !== void 0 && args.speechStyle !== null && typeof args.speechStyle === "object") {
            list[index].speechStyle = { ...(list[index].speechStyle ?? {}), ...args.speechStyle };
            // v7.3.3 修（#28）：update 同样在写入前校验仪式正则（与 add / 扫描侧同一判据）
            assertRitualPatternsValid(list[index].speechStyle);
          }
          if (Array.isArray(args?.alias)) list[index].alias = args.alias.map(String);
          if (Array.isArray(args?.bannedWords)) list[index].bannedWords = args.bannedWords.map(String);
          // v6.5.0：逐词静音也要能原地改（否则用户想取消某词豁免只能删掉整条重加）。
          // 与 add 分支同一套净化口径：数组 / String / trim / 去空 / 去重 / 单项限长 40 / 最多 200 条。
          if (Array.isArray(args?.allowWords)) {
            const seen = new Set();
            const cleaned = [];
            for (const raw of args.allowWords) {
              const w = String(raw ?? "").trim().slice(0, 40);
              if (w === "" || seen.has(w)) continue;
              seen.add(w);
              cleaned.push(w);
              if (cleaned.length >= 200) break;
            }
            list[index].allowWords = cleaned;
          }
          if (args?.recommended !== void 0 && args.recommended !== null && typeof args?.recommended === "object") list[index].recommended = { ...args.recommended };
          let updatePackNote = "";
          if (category === "worldview" && args?.pack !== void 0) {
            assert(typeof args.pack === "string", "novel_settings update 的 pack 必须是字符串");
            const packVal = args.pack.trim();
            if (packVal === "") {
              delete list[index].pack;
              updatePackNote = "（已清除题材包绑定）";
            } else {
              assert(isValidPackId(packVal), "题材包 ID「" + packVal.slice(0, 40) + "」含非法字符（仅允许 1~64 位字母数字下划线连字符或中文，禁止 / \\ .. 与控制字符）");
              const matched = loadPack(packVal, root);
              list[index].pack = packVal;
              updatePackNote = matched
                ? `（已匹配题材包：${matched.name}[${matched.id}]）`
                : `（提示：未在内置或书库 packs 目录匹配到「${packVal}」，已保留设定待后续配置）`;
            }
          }
          message = `已更新 ${categoryLabel}：${name}${updatePackNote}`;
        }
        await writeSettings(root, book, data);
        // v1.0.2：update 返回单条
        if (action === "update") {
          // v3.9.0：改名后 lastSettingName 可能已失效（name 跟随 day 变更）——直接用索引取
          const updated = list[index];
          const result = { book, category, action, message };
          // v6.2.0 修正（旧清单第 16 条）：这里原是三元的 `updated ? [...] : []`——上方已 assert(index !== -1)、
          // 且查找谓词保证元素是非空对象，故 `[]` 分支恒不可达，删掉死分支。
          result[listKey] = [normalizeSettingEntry(updated)];
          return result;
        }
      } else if (action === "scan") {
        // v3.9.5 修正：scan 真正按 category 分派候选（旧实现注释承诺“道具含 owner”扫描，实际任何类别都只返回人物候选）
        const dir = bookDir(root, book);
        const chapters = await scanChapters(dir);
        let text = "";
        // v7.3.1 修（#15）：逐章拼接必须补分隔符——章末无换行时相邻章会粘成一个词，
        // 扫描出正文里并不存在的人名/地点候选（口径与本文件 :1055 / :1434 一致）。
        for (const chapter of chapters) {
          const chapterText = await readTextFile(join(dir, chapter.file), exec);
          text += chapterText.endsWith("\n") ? chapterText : chapterText + "\n";
        }
        const known = new Set(normalizeSettingList(list).map((e) => e.name));
        const pick = (cands) => cands.filter(([n, count]) => count >= 2 && !known.has(n)).map(([n, count]) => n + "（" + count + "次）").slice(0, 15);
        let candidates = [];
        let kindLabel = "人物候选";
        if (category === "character") {
          const nameCounts = new Map();
          // v4.0.0 修正：量词改懒惰（"琉璃说道" 不再被吃成"琉璃说"）
          for (const m of text.matchAll(/([\u4e00-\u9fff]{2,3}?)(?:说|道|问|喊|叫|笑|叹|点头|摇头)/g)) {
            const n = m[1];
            // v3.5.0 #23：伪人名过滤（与 novel_keywords 一致）——代词/功能词开头的不是名字
            if (/^[他她我你它又再还这那谁]./.test(n)) continue;
            if (!["那个", "这个", "什么", "怎么", "自己", "她们", "他们", "你们", "我们"].includes(n)) {
              nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
            }
          }
          candidates = pick([...nameCounts.entries()]);
        } else if (category === "location") {
          const locCounts = new Map();
          for (const m of text.matchAll(/(?:回到|来到|走进|离开|路过|奔向|赶赴|躲进|藏进|出了|进了)([\u4e00-\u9fff]{2,5})(?=[的里中前后处。，,！？!?]|$)/g)) {
            const n = m[1];
            if (!/^(自己|他们|她们|我们|你们|这个|那个|什么)/.test(n)) locCounts.set(n, (locCounts.get(n) ?? 0) + 1);
          }
          candidates = pick([...locCounts.entries()]);
          kindLabel = "地点候选";
        } else if (category === "item") {
          const itemCounts = new Map();
          // v6.2.0 修正（旧清单第 18 条）：补右边界断言，与地点分支同口径——
          // 旧版无右边界会抓到句子碎片（"一顶帽子被风吹走了" → 候选「帽子被风吹走」）。
          for (const m of text.matchAll(/(?:一把|一柄|一顶|一枚|一件|一块|一条|一盏|一封|一叠|几件|抓起|拿起|握紧|掏出|收好|放下)([\u4e00-\u9fff]{2,6})(?=[的里中前后处。，,！？!?]|$)/g)) {
            const n = m[1];
            if (!/^(自己|他们|她们|我们|你们|这个|那个|什么|一点)/.test(n)) itemCounts.set(n, (itemCounts.get(n) ?? 0) + 1);
          }
          candidates = pick([...itemCounts.entries()]);
          kindLabel = "道具候选";
        } else {
          // timeline/worldview 不适用“正文高频词”式扫描：时间线建议用 add 登记（day 作标识），世界观用 detect
          candidates = [];
          kindLabel = category === "timeline" ? "时间线候选（建议用 add 登记时间点）" : "世界观候选（建议用 detect 自动判断）";
        }
        message = `扫描全书，提取 ${candidates.length} 个${kindLabel}`;
        const result = { book, category, action, candidates, message };
        result.characters = normalizeSettingList(data.characters);
        result.locations = normalizeSettingList(data.locations);
        result.items = normalizeSettingList(data.items);
        result.timeline = normalizeSettingList(data.timeline);
        result.worldview = normalizeSettingList(data.worldview);
        return result;
      } else if (action === "detect") {
        const dir = bookDir(root, book);
        const chapters = await scanChapters(dir);
        let text = "";
        // v7.3.1（#15 同类，清单漏报）：逐章拼接必须补分隔符——章末没有换行时，
        // 上一章的末字会和下一章的首字粘成词，detect 会据此产出正文里根本不存在的候选。
        for (const chapter of chapters) {
          const part = await readTextFile(join(dir, chapter.file), exec);
          text += part.endsWith("\n") ? part : part + "\n";
        }
        const detection = detectCulture(text);
        const result = { book, category: "worldview", action, ...detection };
        // v1.5.0：题材/流派检测受功能开关控制（关=只输出文化基准）
        const featState = await readSentenceState();
        let genreNote = "";
        let themeNote = "";
        if (featureEnabled(featState, "genreTheme")) {
          const genre = detectGenre(text);
          const theme = detectTheme(text);
          result.genre = genre;
          result.theme = theme;
          genreNote = genre.dominant ? "｜流派：" + genre.dominant : "";
          themeNote = theme.dominant ? "｜题材：" + theme.dominant + (theme.secondary ? "/" + theme.secondary : "") : "";
        }
        result.worldview = normalizeSettingList(data.worldview);
        result.message = `自动判断：${CULTURE_MARKERS[detection.culture]?.label ?? "无法判断（词表未命中）"}（置信度 ${Math.round(detection.confidence * 100)}%）${genreNote}${themeNote}`;
        // v2.1.0：气质聚合层（氛围光谱 10 轴，纯规则加权 0 token）
        try {
          const analysis = analyzeText(text, {});
          // 语义层裁决意象歧义（受 semanticImplicit 开关与 embedding 可用性双重门控，v3.9.5 修正）
          try {
            const imp = analysis.emotion?.quantification?.implicit;
            if (imp && Array.isArray(imp.ambiguous) && imp.ambiguous.length > 0 && semanticFeatureEnabled(featState, "semanticImplicit") && (await embedding.isAvailable())) {
              analysis.emotion.quantification.implicit = await resolveAmbiguousCarriers(imp);
            }
          } catch {
            // v6.6.0：裁决失败退回规则版——返回值上看不出差别，只有日志能说明"这次引擎没参与"
            logEvent("engine", { book, detail: "设定自动判断：意象歧义裁决失败，已退回规则版" });
          }
          // v2.2.0：网文信号（动作/套路词群 + 题材联动 + 情感密度）受功能开关控制
          const vibeText = featureEnabled(featState, "webnovelVibe") ? text : "";
          result.vibe = computeVibe(result, analysis.emotion, vibeText);
        } catch (e) {
          result.vibe = { axes: [], top: [], conclusion: "气质聚合失败: " + String(e).slice(0, 60), confidence: 0, evidence: [] };
        }
        return result;
      }
      // v3.7.0 ⑨：total 在 list（默认）返回块——schema 契约（上轮误加进 scan 分支）
      const result = { book, category, action };
      // v6.2.0 修正（旧清单第 22 条）：total 原用未过滤的原始数组长度（readSettings 只保证外层是数组，
      // 不过滤数组内的 null/1），与同一次返回的条目数不一致（实测 characters:[null,{...}] → total=2 但只输出 1 条）。
      const normalized = {
        characters: normalizeSettingList(data.characters),
        locations: normalizeSettingList(data.locations),
        items: normalizeSettingList(data.items),
        timeline: normalizeSettingList(data.timeline),
        worldview: normalizeSettingList(data.worldview)
      };
      result.total = Object.values(normalized).reduce((n, list2) => n + list2.length, 0);
      Object.assign(result, normalized);
      if (message) result.message = message;
      return result;
      };
      // v7.4.0 修（#54）：scan、detect 与 packs 均属纯只读操作，不写 settings，不占用 withFileTx 写锁（对齐 novel-settings.html:270）。
      return (action === "scan" || action === "detect" || action === "packs")
        ? await runSettingsBody()
        : await withFileTx(settingsDataFile, runSettingsBody);
    }
  });
}

function registerNovelSummary(ctx, config) {
  ctx.tools.register({
    name: "novel_summary",
    description: "章节摘要管理。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名" },
        action: { type: "string", enum: ["list", "get", "add", "update", "delete"], description: "操作(默认list)" },
        chapter: { type: "string", description: "章节" },
        summary: { type: "string", description: "摘要(200-500字)" },
        keyEvents: { type: "array", items: { type: "string" }, description: "关键事件" },
        keySettings: { type: "array", items: { type: "string" }, description: "关键设定" },
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
          action: { type: "string" },
          summaries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                chapter: { type: "string" },
                summary: { type: "string" },
                keyEvents: { type: "array", items: { type: "string" } },
                keySettings: { type: "array", items: { type: "string" } },
                updatedAt: { type: "string" }
              },
              required: ["chapter", "summary"]
            }
          },
          message: { type: "string" }
        },
        required: ["book", "action", "summaries"]
      },
      render: (_args, value) => {
        const lines = [`<path>novels/${value.book}</path>`, "<type>novel-summary</type>", "<content>", ""];
        if (value.message) lines.push(value.message);
        for (const s of value.summaries) {
          lines.push(`【${s.chapter}】`);
          lines.push(s.summary);
          if (Array.isArray(s.keyEvents) && s.keyEvents.length > 0) lines.push("关键事件：" + s.keyEvents.join("；"));
          if (Array.isArray(s.keySettings) && s.keySettings.length > 0) lines.push("关键设定：" + s.keySettings.join("；"));
          lines.push("");
        }
        lines.push("</content>");
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_summary");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const action = ["get", "add", "update", "delete"].includes(args?.action) ? args.action : "list";
      const root = resolveRoot(config, args, exec);
      // v3.9.5 修正：读-改-写事务化——并发 add/update/delete 不再基于同一旧快照互相整表覆盖（丢更新）
      const summaryDataFile = summariesFile(root, book);
      return await withFileTx(summaryDataFile, async function () {
      // v4.3.0：读盘后立即套用 cleanSummaryEntry 白名单（与 list/get 同口径）——旧版把磁盘原文直接交给
      // findIndex(s => s.chapter)/sort(a.chapter)，脏条目（null/字符串）会抛 TypeError 让整次调用失败；
      // settings/plots 早有 normalizeSettingList/normalizePlotEntry 守卫，summary 一直缺
      const summaries = (await readSummaries(root, book)).map(cleanSummaryEntry).filter(Boolean);
      let message = "";
      if (action !== "list") {
        const chapterArg = optionalString(args, "chapter");
        assert(chapterArg !== void 0, `novel_summary ${action} 需要 chapter 参数`);
        // v6.2.0 修正（旧清单第 20 条）：槽位统一为 findChapter 解析出的规范章号。
        // 旧版只对参数做 normalizeChapterKey，而**标题不参与归一**：按标题 add chapter="初遇" 存下的键是「初遇」，
        // 之后用「第01章」或「第01章 初遇.md」查同一章都查不到（无报错、无 message），换个别名再 add 还会
        // push 出第二个槽位——同一章两条摘要。这里对「参数」与「已存条目键」都做一次规范解析后比较。
        const chapters = await scanChapters(bookDir(root, book)).catch((e) => {
          // v6.6.0：扫不到章节 → 摘要章号按参数自身的归一键匹配；与「这本书还没有章节」在结果上一样。
          // 注意 cause：scanChapters 把 ENOENT 包成友好错误（code 落在 cause 上），只看 e.code
          // 会把最常见的「书目录还不存在」记成故障 ✗（探针实测的假阳性）
          if (e?.code !== "ENOENT" && e?.cause?.code !== "ENOENT") {
            logEvent("silent_skip", { book, level: "warn", detail: "章节扫描失败（摘要章号按参数归一键匹配）：" + String(e?.message ?? e) });
          }
          return [];
        });
        const canonKey = (value) => {
          try {
            const hit = findChapter(chapters, value);
            if (hit) return normalizeChapterKey(hit.number !== void 0 ? "第" + hit.number + "章" : hit.file);
          } catch { /* 同名多文件等歧义：退回参数自身的归一键 */ }
          return normalizeChapterKey(value);
        };
        const chapterKey = canonKey(chapterArg);
        let index = summaries.findIndex((s) => canonKey(s.chapter) === chapterKey);
        if (index === -1) {
          // 兜底：章节文件不可解析（尚未建章）时仍按旧口径的归一键比较
          const normArg = normalizeChapterKey(chapterArg);
          index = summaries.findIndex((s) => normalizeChapterKey(s.chapter) === normArg);
        }
        if (action === "get") {
          // v4.0.0 修正：get 与 list 共用白名单清洗（旧版透传磁盘原文，脏键会让宿主拒绝整次调用）
          const found = index !== -1 ? [summaries[index]] : [];
          return { book, action, summaries: found.map(cleanSummaryEntry).filter(Boolean) };
        }
        if (action === "delete") {
          // v3.9.5 修正：不存在时不再假报“已删除”并空写盘
          assert(index !== -1, `尚未保存 ${chapterArg} 的摘要，无需删除`);
          summaries.splice(index, 1);
          message = `已删除 ${chapterArg} 的摘要`;
        } else {
          const summary = optionalString(args, "summary");
          assert(summary !== void 0, `novel_summary ${action} 需要 summary 参数`);
          const entry = {
            chapter: chapterKey, // v6.2.0：存规范章号（2/第2章/第02章.md/标题 都归一到同一槽位）
            summary,
            keyEvents: Array.isArray(args?.keyEvents) ? args.keyEvents.map(String) : void 0,
            keySettings: Array.isArray(args?.keySettings) ? args.keySettings.map(String) : void 0,
            updatedAt: new Date().toISOString() // v4.0.0 修正：只在真正写入时取时间戳（旧版 list/get/delete 路径也算了但没用）
          };
          if (index !== -1) summaries[index] = entry;
          else summaries.push(entry);
          message = `已保存 ${chapterArg} 的摘要`;
        }
        await mkdir(dirname(summariesFile(root, book)), { recursive: true });
        await atomicWriteJson(summariesFile(root, book), { book, summaries });
        await noteRoot(root); // v3.9.0：summary 写操作记录书库根
        // v1.0.2：add/update 返回单条确认（不再返回全量列表）
        if (action === "add" || action === "update") {
          // v4.0.0 修正：复用 cleanSummaryEntry（与 get/list 同一套白名单）
          const single = cleanSummaryEntry(summaries[index !== -1 ? index : summaries.length - 1]);
          return { book, action, message, summaries: single ? [single] : [] };
        }
      }
      // v3.5.0 #30：按章号数值排序
      // v7.0.1 修正（审查 #53）：无章号条目的兜底值由硬编码 999 改为 Number.MAX_SAFE_INTEGER——
      // 旧值会把「番外/序章」这类无章号摘要夹在第 999 章与第 1000 章之间（千章以上长篇排序错乱）。
      summaries.sort((a, b) => (parseChapterNumber(a.chapter) ?? Number.MAX_SAFE_INTEGER) - (parseChapterNumber(b.chapter) ?? Number.MAX_SAFE_INTEGER) || String(a.chapter).localeCompare(String(b.chapter)));
      const clean = summaries.map(cleanSummaryEntry).filter(Boolean);
      return { book, action, summaries: clean, ...message ? { message } : {} };
      });
    }
  });
}

function registerNovelPlot(ctx, config) {
  ctx.tools.register({
    name: "novel_plot",
    description: "伏笔/剧情线表（open/done）。",
    parameters: {
      type: "object",
      properties: {
        book: { type: "string", description: "书名" },
        action: { type: "string", enum: ["list", "add", "update", "done", "delete", "scan", "graph"], description: "操作(graph为只读跨章结构视图)" },
        id: { type: "string", description: "伏笔id" },
        content: { type: "string", description: "内容" },
        chapter: { type: "string", description: "章节" },
        note: { type: "string", description: "备注" },
        type: { type: "string", enum: ["剧情", "设定", "道具", "人物", "其他"], description: "类型" },
        priority: { type: "string", enum: ["high", "medium", "low"], description: "优先级" },
        relatedCharacters: { type: "array", items: { type: "string" }, description: "人物" },
        locations: { type: "array", items: { type: "string" }, description: "地点" },
        payoffCondition: { type: "string", description: "回收条件" },
        // v7.1.0 修正（审查 #20）：此前只有 action="done" 能把状态置为 done，**没有任何入口把它改回 open**
        // （update 的字段白名单不含 status，也没有 reopen 动作）——误标一次就只能手改 JSON。
        status: { type: "string", enum: ["open", "done"], description: "状态(回收优先done)" },
        // v5.0.0：结构视图可调"连续缺席几章算异常"（默认 5）
        absenceThreshold: { type: "integer", description: "graph缺席阈值(默认5)" },
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
          action: { type: "string" },
          entries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                chapter: { type: "string" },
                note: { type: "string" },
                type: { type: "string" },
                priority: { type: "string" },
                relatedCharacters: { type: "array", items: { type: "string" } },
                locations: { type: "array", items: { type: "string" } },
                payoffCondition: { type: "string" },
                mentionedIn: { type: "array", items: { type: "string" } },
                lastMentioned: { type: "string" },
                status: { type: "string", enum: ["open", "done"] },
                createdAt: { type: "string" },
                updatedAt: { type: "string" }
              },
              required: ["id", "content", "status"]
            }
          },
          message: { type: "string" },
          // v5.0.0：action="graph" 的结构视图字段（与伏笔列表共享同一 schema，故全部可选）。
          // 注意 required 仍是 ["book","action","entries"]——graph 分支会带一个空 entries 以满足它，
          // 这样不必为了一个 action 放松契约检查（放松会让另外 6 个 action 少一层断言）。
          totalChapters: { type: "integer" },
          plotLifecycle: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                content: { type: "string" },
                priority: { type: "string" },
                type: { type: "string" },
                firstChapter: { type: "number" },
                distance: { type: "number" },
                status: { type: "string", enum: ["open", "done"] }
              },
              required: ["id", "content", "status"]
            }
          },
          characterMatrix: {
            type: "object",
            additionalProperties: false,
            properties: {
              characters: { type: "array", items: { type: "string" } },
              rows: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    chapter: { type: "string" },
                    number: { type: "number" },
                    present: { type: "array", items: { type: "string" } }
                  },
                  required: ["chapter", "number", "present"]
                }
              },
              absences: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    name: { type: "string" },
                    from: { type: "number" },
                    to: { type: "number" },
                    length: { type: "number" }
                  },
                  required: ["name", "from", "to", "length"]
                }
              }
            },
            required: ["characters", "rows", "absences"]
          },
          threadActivity: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                thread: { type: "string" },
                chapters: { type: "array", items: { type: "number" } },
                length: { type: "number" },
                gap: { type: "number" }
              },
              required: ["thread", "chapters", "length", "gap"]
            }
          },
          timelineOrder: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                day: { type: "string" },
                event: { type: "string" },
                chapter: { type: "string" },
                // v5.0.0 修正：number **不在 required 里**。时间线条目可能只登记了
                // 「第 3 天 / 某个事件」而 chapter 写的是无法解析的文本，此时 graph.js
                // 会省略 number 键（契约里"未知值"是省略而非 null）。列为必填会让
                // 这类完全合法的设定表触发宿主契约校验失败。
                number: { type: "number" },
                issue: { type: "string" }
              },
              required: ["day", "event", "chapter", "issue"]
            }
          },
          planVsActual: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                number: { type: "number" },
                direction: { type: "string" },
                overlap: { type: "number" },
                keywords: { type: "array", items: { type: "string" } }
              },
              required: ["number", "direction", "overlap", "keywords"]
            }
          },
          summary: { type: "string" },
          degraded: { type: "array", items: { type: "string" } }
        },
        required: ["book", "action", "entries"]
      },
      render: (_args, value) => {
        const lines = [`<path>novels/${value.book}</path>`, "<type>novel-plot</type>", "<content>", ""];
        // v5.0.0：结构视图分支——必须在下方的 value.entries.filter 之前返回（graph 响应不带 entries）
        if (value.action === "graph") {
          const out = [`<path>novels/${value.book}</path>`, "<type>novel-plot-graph</type>", "<content>", "", value.summary];
          const life = Array.isArray(value.plotLifecycle) ? value.plotLifecycle : [];
          if (life.length > 0) {
            out.push("", "未回收伏笔（埋设章 → 已过章数）：");
            for (const p of life) out.push(`  - [${p.id}] ${p.content}（第 ${p.firstChapter ?? "?"} 章埋下，已过 ${p.distance ?? "?"} 章）`);
          }
          const matrix = value.characterMatrix ?? {};
          if (Array.isArray(matrix.absences) && matrix.absences.length > 0) {
            out.push("", "连续缺席：");
            for (const a of matrix.absences) out.push(`  - ${a.name}：第 ${a.from}–${a.to} 章（${a.length} 章未出场）`);
          }
          if (Array.isArray(value.threadActivity) && value.threadActivity.length > 0) {
            out.push("", "剧情线：");
            for (const t of value.threadActivity) out.push(`  - ${t.thread}：活跃章 ${t.chapters.join("、") || "（正文无线索）"}｜跨度 ${t.length}｜最大空档 ${t.gap}`);
          }
          const bad = (Array.isArray(value.timelineOrder) ? value.timelineOrder : []).filter((t) => t.issue);
          if (bad.length > 0) {
            out.push("", "时间线顺序问题：");
            for (const t of bad) out.push(`  - ${t.day}（章 ${t.chapter}）：${t.issue}`);
          }
          if (Array.isArray(value.planVsActual) && value.planVsActual.length > 0) {
            out.push("", "大纲 vs 正文：");
            for (const r of value.planVsActual) out.push(`  - 第 ${r.number} 章 重合率 ${r.overlap}：${r.direction}`);
          }
          if (Array.isArray(value.degraded) && value.degraded.length > 0) {
            out.push("", "降级/提示：");
            for (const d of value.degraded) out.push("  - " + d);
          }
          out.push("", "</content>");
          return [{ type: "text", text: out.join("\n") }];
        }
        if (value.message) lines.push(value.message);
        const open = value.entries.filter((e) => e.status === "open");
        const done = value.entries.filter((e) => e.status === "done");
        lines.push(`未回收伏笔 ${open.length} 条：`);
        if (open.length === 0) lines.push("  （无）");
        for (const e of open) {
          const tags = [e.type, e.priority, e.chapter ? "出自 " + e.chapter : "", e.payoffCondition ? "回收:" + e.payoffCondition : "", e.lastMentioned ? "最近提及:" + e.lastMentioned : ""].filter(Boolean).join(" | ");
          lines.push(`  - [${e.id}] ${e.content}${tags ? "（" + tags + "）" : ""}${e.note ? "｜" + e.note : ""}`);
        }
        if (done.length > 0) {
          lines.push(`已回收 ${done.length} 条：`);
          for (const e of done) lines.push(`  - [${e.id}] ${e.content}`);
        }
        lines.push("", "</content>");
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_plot");
      const book = sanitizeSegment(requiredString(args, "book"), "book");
      const action = ["add", "update", "done", "delete", "scan", "graph"].includes(args?.action) ? args.action : "list";
      const root = resolveRoot(config, args, exec);
      // v5.0.0：结构视图走**只读早返回**——必须留在 withFileTx 写事务与 readPlots（带 v0.8.0 旧位置迁移写盘）
      // 之外，否则"只读"承诺会被打破（graph.js 内部实现了不写盘的伏笔读取）。
      if (action === "graph") {
        const graph = await buildStoryGraph(root, book, { absenceThreshold: args?.absenceThreshold }, exec);
        // entries: [] 只为满足共享 schema 的 required（不放松它，避免削弱另外 6 个 action 的契约断言）；
        // dropNullDeep 丢弃 null 值——宿主 schema 不支持 type 数组，null 会被判成违反输出契约。
        return { ...dropNullDeep(graph), entries: [], action: "graph" };
      }
      // v3.9.5 修正：读-改-写事务化——并发 add/update/done/delete 不再基于同一旧快照互相整表覆盖（丢更新）
      const plotDataFile = plotsFile(root, book);
      return await withFileTx(plotDataFile, async function () {
      // v6.2.0 修正（旧清单第 21 条）：list 承诺「只读不写盘」，但 readPlots 在新位置缺失而旧位置存在时
      // 会 mkdir + writeFile 迁移——只有传 {readOnly:true} 才跳过（fixplan.js:692 传了、graph.js 自写只读版，
      // 三个调用点里只有 list 漏了）。这里给 list 路径补上，让「只读」承诺成立。
      let entries = await readPlots(root, book, action === "list" ? { readOnly: true } : void 0);
      let lastPlotId = void 0; // v1.0.2：add/update 单条返回用
      const now = new Date().toISOString();
      let message = "";
      if (action === "add") {
        const content = optionalString(args, "content");
        assert(content !== void 0, "novel_plot add 需要 content 参数");
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const entry = {
          id,
          content,
          chapter: optionalString(args, "chapter"),
          note: optionalString(args, "note"),
          type: ["剧情", "设定", "道具", "人物", "其他"].includes(args?.type) ? args.type : void 0,
          priority: ["high", "medium", "low"].includes(args?.priority) ? args.priority : void 0,
          relatedCharacters: Array.isArray(args?.relatedCharacters) ? args.relatedCharacters.map(String) : void 0,
          locations: Array.isArray(args?.locations) ? args.locations.map(String) : void 0,
          payoffCondition: optionalString(args, "payoffCondition"),
          status: "open",
          createdAt: now,
          updatedAt: now
        };
        entries.push(entry);
        lastPlotId = id;
        message = `已登记伏笔 #${id}`;
      } else if (action === "scan") {
        // v0.8.0：扫描章节文本，更新 open 伏笔的提及章节
        const scanChapter = optionalString(args, "chapter");
        const dir = bookDir(root, book);
        const chapters = await scanChapters(dir);
        assert(chapters.length > 0, `作品 "${book}" 下没有章节文件`);
        const targets = scanChapter !== void 0 ? [findChapter(chapters, scanChapter)] : chapters;
        assert(targets[0] !== void 0, `找不到章节 "${scanChapter}"`);
        let mentioned = 0;
        // v4.0.0 修正：plotKeywords 只依赖伏笔内容，进章循环前预计算一次——
        // 旧版放在"章 × 条目"双层循环内层，重算 章数 × open 条数 次；同时过滤脏条目（null/标量）
        const kwById = new Map();
        for (const entry of entries) {
          if (!entry || typeof entry !== "object" || entry.status === "done") continue;
          kwById.set(entry, plotKeywords(String(entry.content ?? "")));
        }
        for (const chapter of targets) {
          const chapterText = await readTextFile(join(dir, chapter.file), exec);
          for (const entry of entries) {
            if (!entry || typeof entry !== "object" || entry.status === "done") continue;
            const keywords = kwById.get(entry) || [];
            if (keywords.length > 0 && keywords.some((k) => chapterText.includes(k))) {
              const mentionedIn = Array.isArray(entry.mentionedIn) ? entry.mentionedIn : [];
              if (!mentionedIn.includes(chapter.file)) {
                entry.mentionedIn = mentionedIn.concat(chapter.file);
                entry.lastMentioned = chapter.file;
                entry.updatedAt = now;
                mentioned += 1;
              }
            }
          }
        }
        message = `扫描 ${targets.length} 章，更新 ${mentioned} 条伏笔的提及记录`;
      } else if (action === "update" || action === "done" || action === "delete") {
        const id = optionalString(args, "id");
        assert(id !== void 0, `novel_plot ${action} 需要 id 参数`);
        lastPlotId = id;
        // v4.0.0 修正：脏条目守卫——旧版 e.id 在坏数据（null/字符串元素）上抛 TypeError 打挂整个工具
        const index = entries.findIndex((e) => e && typeof e === "object" && e.id === id);
        assert(index !== -1, `伏笔 #${id} 不存在（可用 novel_plot 查看列表）`);
        if (action === "delete") {
          entries.splice(index, 1);
          message = `已删除伏笔 #${id}`;
        } else if (action === "done") {
          entries[index].status = "done";
          entries[index].updatedAt = now;
          message = `已标记伏笔 #${id} 为已回收`;
        } else {
          if (args?.content !== void 0) {
            const nextContent = String(args.content ?? "").trim();
            assert(nextContent !== "", "novel_plot update 的 content 不能为空");
            entries[index].content = nextContent;
          }
          if (args?.note !== void 0) entries[index].note = String(args.note);
          if (args?.chapter !== void 0) entries[index].chapter = String(args.chapter);
          if (["剧情", "设定", "道具", "人物", "其他"].includes(args?.type)) entries[index].type = args.type;
          if (["high", "medium", "low"].includes(args?.priority)) entries[index].priority = args.priority;
          if (Array.isArray(args?.relatedCharacters)) entries[index].relatedCharacters = args.relatedCharacters.map(String);
          if (Array.isArray(args?.locations)) entries[index].locations = args.locations.map(String);
          if (args?.payoffCondition !== void 0) entries[index].payoffCondition = String(args.payoffCondition);
          // v7.1.0（审查 #20）：状态可逆。此前只有 done 单向，误标就只能手改 JSON。
          if (args?.status === "open" || args?.status === "done") {
            entries[index].status = args.status;
            message = `已更新伏笔 #${id}（状态 → ${args.status === "open" ? "待回收" : "已回收"}）`;
          } else {
            message = `已更新伏笔 #${id}`;
          }
          entries[index].updatedAt = now;
        }
      }
      // v3.5.0 M8：list（只读）不写盘——读操作不做多余 I/O、只读挂载不失败
      if (action !== "list") {
        await writePlots(root, book, entries);
        // v6.3.0：改走 noteRoot（同一处落盘），使「调用方显式传入的 root 不写 lastRoot」的守卫在这里也生效
        try { await noteRoot(root); } catch { /* 记录失败不影响伏笔功能 */ }
      }
            // v3.5.0 #17：旧/手改数据缺 createdAt 兜底（undefined.localeCompare 会 TypeError）
      // v3.5.0 #17：先清洗（过滤脏条目/补默认值）再排序——排序不再碰 null
      const cleanEntries = entries.map(normalizePlotEntry).filter(Boolean);
      cleanEntries.sort((a, b) => (a.status === b.status ? String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) : a.status === "open" ? -1 : 1));
      entries = cleanEntries;
      // v1.0.2：add/update 返回单条确认
      if (action === "add" || action === "update") {
        const target = entries.find((e) => e.id === lastPlotId);
        return { book, action, entries: target ? [normalizePlotEntry(target)] : [], ...message ? { message } : {} };
      }
      return { book, action, entries: entries.map(normalizePlotEntry).filter(Boolean), ...message ? { message } : {} };
      });
    }
  });
}

function registerNovelSemanticSearch(ctx, config) {
  ctx.tools.register({
    name: "novel_semantic_search",
    description: "本地语义检索(0 token)：自然语言搜相关段落。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        book: { type: "string", description: "书名" },
        query: { type: "string", description: "语义描述" },
        top: { type: "integer", description: "条数(默认5,上限10)" },
        root: { type: "string", description: "书库根" }
      },
      required: ["book", "query"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          book: { type: "string" },
          query: { type: "string" },
          available: { type: "boolean" },
          cache: { type: "string", enum: ["hit", "built"] },
          indexSize: { type: "integer" },
          results: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                chapter: { type: "string" },
                text: { type: "string" },
                score: { type: "number" }
              },
              required: ["id", "chapter", "text", "score"]
            }
          },
          message: { type: "string" }
        },
        required: ["book", "query", "available", "results", "message"]
      },
      render: (_args, value) => {
        // v2.0.0 修复：DSH 要求 render 返回 content 数组（[{type:"text",text}]），字符串会导致 commit 崩溃
        const head = `《${value.book}》语义检索「${value.query}」`;
        if (!value.available) return [{ type: "text", text: head + "（不可用）\n" + (value.message ?? "") }];
        const lines = value.results.map((r) => `- [${r.score}] ${r.chapter}: ${r.text}`);
        return [{ type: "text", text: head + `（命中 ${value.results.length} 段，索引 ${value.indexSize} 段）\n` + lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      await assertToolEnabled(config, "novel_semantic_search");
      // v3.9.5 修正：参数校验移到 try 外——缺参/空参等调用错误不再被宽 catch 伪装成“语义引擎不可用”
      const book = String(args?.book ?? "");
      assert(book !== "", "novel_semantic_search 需要 book 参数");
      const query = String(args?.query ?? "");
      assert(query !== "", "novel_semantic_search 需要 query 参数");
      const top = Math.min(Math.max(Number(args?.top) || 5, 1), 10);
      const root = resolveRoot(config, args, exec);
      try {
      const state = await readSentenceState();
      if (!semanticFeatureEnabled(state, "semanticSearch")) {
        return { book, query, available: false, results: [], message: "「语义检索」已关闭：请在侧边栏「写作助手功能」→ 小模型页开启，或用 novel_sentence_config 设置 features:{semanticSearch:true}（注意传在 features 里，顶层 semanticSearch 会被忽略）。" };
      }
      const ready = await embedding.isAvailable();
      if (!ready) {
        return { book, query, available: false, results: [], message: "语义引擎不可用：" + (embedding.engine?.error ?? "模型加载失败") + "。插件已回退纯规则模式，不影响其他功能。 【解决：确认 lib/models/ 含 bge-small-zh 模型文件；首次使用需自动加载，稍后重试】" };
      }
      const dir = bookDir(root, book);
      const chapters = await scanChapters(dir);
      const chunks = [];
      for (const chapter of chapters) {
        const text = await readTextFile(join(dir, chapter.file), exec);
        // v2.6.0：章节标记直接用文件名（同 enrichSemanticImplicit）
        for (const p of embedding.chunkText(text, { chapter: chapter.file })) chunks.push({ ...p, id: chapter.file + "|" + p.id, chapter: chapter.file });
      }
      // v2.5.0 修复轮 4：内容指纹失效重建——章节更新后旧缓存不再命中（不靠版本号）
      // v2.6.0：增量构建——指纹变化时只对新/变化的段落做推理，其余复用旧向量
      const { items: cachedIndex, fp: cachedFp } = embedding.loadIndexMeta(root, book);
      const indexFp = embedding.fingerprint(chunks);
      let index = cachedIndex;
      let cache = "hit";
      let indexSaveFailed = false;
      if (!index || index.length === 0 || cachedFp !== indexFp) {
        index = await embedding.buildIndexIncremental(chunks, cachedIndex);
        cache = "built";
        // v4.0.0：saveIndex 失败返回 false（不再静默丢弃；第 4 个参数已废弃，由 embedding 内部重算指纹）
        // v7.4.0（#47）：空索引（index.length === 0）时 saveIndex 主动返回 false 跳过写盘，不算写失败
        indexSaveFailed = index.length > 0 && embedding.saveIndex(root, book, index) === false;
      }
      const results = await embedding.search(query, index, top);
      // v4.0.0 修正：部分段落推理失败时不再谎报"全部成功"——报出实际段数，下次增量自动补齐
      const partialNote = index.length < chunks.length ? "（部分段落失败，下次自动补齐 " + index.length + "/" + chunks.length + "）" : "";
      const baseMsg = index.length === 0
        ? "本书暂无可索引文本段落"
        : (cache === "hit" ? "使用本地语义索引（缓存）" : "首次建索引完成，已缓存");
      // v4.0.0 修正：cosine 可能产出 -0，宿主会拒绝，统一过 cleanOutput
      return cleanOutput({
        book, query, available: true, cache, indexSize: index.length,
        results: results.map((r) => ({ id: r.id, chapter: r.chapter || String(r.id).split("|")[0] || "全书", text: String(r.text || "").replace(/\r/g, "").slice(0, 200), score: Math.round(r.score * 10000) / 10000 })),
        // v3.6.0：清洗 \r（CR 分行文本摘要不出现乱码）
        message: baseMsg + partialNote + (indexSaveFailed ? "；索引缓存写入失败（下次会重建）" : "")
      });
      } catch (e) {
        // v7.3.1 修（#19）：取消不是「引擎不可用」——先放行 AbortError，否则用户中止会被伪装成
        // available:false 的成功返回（违背全插件「isAbort 一律上抛」的判据）。
        if (isAbort(e)) throw e;
        // v2.0.0 终极防御：任何异常只返回错误信息，绝不裸抛（防杀宿主）
        return { book: String(args?.book ?? ""), query: String(args?.query ?? ""), available: false, results: [], message: "语义检索安全降级：" + String(e).slice(0, 120) + "（不影响其他工具）" };
      }
    }
  });
}

export {
  registerNovelSettings,
  registerNovelSummary,
  registerNovelPlot,
  registerNovelSemanticSearch,
  assertRitualPatternsValid,
  dropNullDeep
};
