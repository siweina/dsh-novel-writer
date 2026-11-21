/**
 * dsh-novel-writer — core/baseline.js（Layer 3A：风格基线范围、容差带、参照集/诊断集、动作链与原著锚包）
 *
 * 严格 DAG 3A 层：只依赖 Node 内置、../analysis.js、../style-metrics.js、../log.js、./state.js 与 ./text.js，不依赖同层其他 domain 模块与 http。
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { actionChainCandidates } from "../analysis.js";
import { measureStyleMetrics, METRIC_ORDER } from "../style-metrics.js";
import { logEvent } from "../log.js";
import {
  assert, sanitizeSegment, isAbort, novelDataDir, atomicWriteJson, noteRoot
} from "./state.js";
import { readTextFile } from "./text.js";

// v5.0.0：基线章节数少于 3 时 σ 不可靠（小样本），容差下限抬到 25%，避免「只有两章的书」互相误报。
export const MIN_BASELINE_CHAPTERS = 2;
export const SMALL_BASELINE_CHAPTERS = 3;
export const SMALL_BASELINE_TOL_PCT = 25;

/**
 * v5.0.0：六维容差带构造——**全插件唯一实现**（novel_fix_plan 与 novel_chapter_brief 共用）。
 *
 * 为什么必须共用：容差决定"多大偏差算出带"。若两条路径用不同公式，同一章会出现
 * 「改稿台说有问题、开写包说没问题」这种互相矛盾的结论，比单条结论错更伤信任。
 * 口径：以**排除本章后的基线**自身的推荐容差 recTol（作者自身章节波动的 1.5σ）为主；
 * 小样本（< 3 章）抬高下限；用户自定义容差（opts.tolerance 优先，其次侧边栏保存的 styleTolerance）只覆盖对应维度。
 */
export function buildTolerance(baseline, sampleCount, opts, stateTolerance) {
  const tol = {};
  if (!baseline) return tol;
  for (const key of METRIC_ORDER) {
    const rawRt = baseline[key]?.recTol;
    let rt = typeof rawRt === "number" && Number.isFinite(rawRt) && rawRt > 0 ? rawRt : 15;
    if (sampleCount < SMALL_BASELINE_CHAPTERS) rt = Math.max(rt, SMALL_BASELINE_TOL_PCT);
    tol[key] = { low: -rt, high: rt };
  }
  // v8.2.0（#52）：按维度逐层叠加自定义容差（先侧边栏 stateTolerance，再本次 opts.tolerance），
  // 确保 opts.tolerance 局部覆盖时保留其余维度的侧边栏设置；同时拒绝 NaN/Infinity 及 low > high。
  for (const layer of [stateTolerance, opts && opts.tolerance]) {
    if (!layer || typeof layer !== "object") continue;
    for (const key of METRIC_ORDER) {
      const t = layer[key];
      if (
        t &&
        typeof t.low === "number" && Number.isFinite(t.low) &&
        typeof t.high === "number" && Number.isFinite(t.high) &&
        t.low <= t.high
      ) {
        tol[key] = { low: t.low, high: t.high };
      }
    }
  }
  return tol;
}

/**
 * 风格基线的**范围**：基线到底取哪些章。
 *
 * ## 为什么需要它（真实用户诉求）
 *
 * 用户提了 issue（siweina/dsh-novel-writer#1「风格漂移」）：AI 续写每章只参考上一章，
 * 从**第 2 章续写**起参考的就是 AI 自己的产物，于是文风逐代远离原著、滑向 AI 的固定腔调。
 * 而本插件此前的「六维基线」与「原著锚段」都是从**全书**（含 AI 写的新章）取样——
 * 书越长 AI 占比越高，**基准自己也在漂**：既检测不出对原著的偏移（全书是一起漂的），
 * 锚段也逐代变成 AI 自己的文风。基准本该是防漂移的锚，结果跟着漂。
 *
 * 用户说"这本身就很难定性"——这话是对的：文风本就该允许演变，插件无权判定"你漂移了"。
 * 所以这里不去判定漂移，而是换一个**可判定**的问题：
 * **相对你自己指定的标杆章，这一章偏了多少**。"哪些章算标杆"交给作者定。
 * （刻意**不猜**"哪些章是原作"——插件根本分不清：`novel_new_chapter` 建章时不留标记，
 * 存量书更没有，猜错比不猜更糟。让作者选，反而是最准的。）
 *
 * ## 语义（"只用"方案，用户已确认）
 *
 * - `all`（默认）：全书除目标章外的所有章 —— **等于旧行为**，存量书零迁移
 * - `custom`：**只用**选中的章。是"只用"，**不是**"优先+不够再补"——
 *   补进来的章不可控，很可能正是用户想排除的 AI 续写章，那就恰好违背了这个功能的目的
 * - **目标章永远排除**，即使它被选中：否则等于拿自己跟自己比，必然"完美符合"，
 *   **比不检查更糟**（会让作者以为"没问题"）。这个过滤旧版就有，改成自定义选择后必须保留
 * - 选择里已改名/删除的章跳过；若**全部失效**导致基线为空 → 回退 `all` 并置 `fellBack`
 *   （绝不返回空基线：空基线算出的 μ 是假的，会把"没基线"伪装成"全都在带内"）
 * - 样本少于 `SMALL_BASELINE_CHAPTERS` 章时，推荐容差由 `buildTolerance` 抬到
 *   至少 `SMALL_BASELINE_TOL_PCT`%——所以**单章也能当基线**，不会因 σ=0 把一切都报成偏差
 *
 * ## 单一裁决点（重要）
 *
 * 基线被多处消费：风格自检 / 开写包（六维基线与锚段）/ 改稿台 / 风格画像报告 / 建章信息行。
 * 上方 `buildTolerance` 的注释已写明理由：若两条路径口径不同，同一章会出现
 * 「改稿台说有问题、开写包说没问题」这种互相矛盾的结论——**比单条结论错更伤信任**。
 * 故所有消费方都必须走本函数，不要各自 filter。
 */
export const BASELINE_SCOPE_MODES = Object.freeze(["all", "custom"]);
/** 选中章节数上限：防一份被写坏/被恶意填的配置把基线撑到内存吃不消 */
export const BASELINE_SCOPE_MAX_CHAPTERS = 2000;

export function baselineDir(root) {
  return join(novelDataDir(root), "baseline");
}
export function baselineScopeFile(root, book) {
  return join(baselineDir(root), sanitizeSegment(book, "book") + ".json");
}
/**
 * 净化（UI 与工具入口共用）：
 * - `mode` 只认 all/custom，**其余一律回落 all**：宁可退回默认全覆盖，
 *   也不要因为一个拼错的 mode 把基线变成空集（空集的危害见上）
 * - `chapters`：去首尾空白、丢空串与非字符串、按出现顺序去重、单条截 220 字、总量上限 2000
 */
export function normalizeBaselineScope(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const mode = BASELINE_SCOPE_MODES.includes(src.mode) ? src.mode : "all";
  const seen = new Set();
  const chapters = [];
  for (const item of Array.isArray(src.chapters) ? src.chapters : []) {
    if (typeof item !== "string") continue;
    const file = item.trim().slice(0, 220);
    if (file === "" || seen.has(file)) continue;
    seen.add(file);
    chapters.push(file);
    if (chapters.length >= BASELINE_SCOPE_MAX_CHAPTERS) break;
  }
  return { mode, chapters };
}
/** 读本书的基线范围；无文件/损坏一律按默认 `all`（fail-safe：读不出来就退回全覆盖，不静默缩小） */
export async function readBaselineScope(root, book, exec) {
  try {
    const parsed = JSON.parse(await readTextFile(baselineScopeFile(root, book), exec));
    return normalizeBaselineScope(parsed);
  } catch (e) {
    // v7.3.3 修（#11/M7）：取消不是「读取失败」。旧版把 AbortError 也当损坏，先记一条 config warn
    // （「基线范围读取失败（按默认 all 处理）」）再返回默认 all——取消被伪装成成功，还会污染 novel_diagnose
    // 的 byKind 计数。放行必须早于 logEvent（isAbort 是全插件唯一取消判据，见其定义处注释）。
    if (isAbort(e)) throw e;
    // v6.6.0：无文件与损坏一律按默认 all（fail-safe），但对外两者无法区分——必须留痕。
    // 注意：本条是 JSON.parse 路径，解析错误的消息会**回显文件内容片段**，故只记固定标签，绝不带 e.message
    if (e?.code !== "ENOENT") {
      logEvent("config", { book, file: baselineScopeFile(root, book), level: "warn", detail: "基线范围读取失败（按默认 all 处理）" });
    }
    return { mode: "all", chapters: [] };
  }
}
export async function writeBaselineScope(root, book, scope) {
  const clean = normalizeBaselineScope(scope);
  const file = baselineScopeFile(root, book);
  await mkdir(dirname(file), { recursive: true });
  await atomicWriteJson(file, { ...clean, updatedAt: new Date().toISOString() });
  await noteRoot(root); // 与 settings/lexicon 写操作同口径：记录书库根，供 UI 定位数据目录
  return clean;
}
/** 展示用文案：`all` 沿用旧措辞（1 章时直接给章名），免得读取方按旧格式解析的代码失效 */
function describeBaselineScope(mode, items, extra, hasTarget) {
  if (mode === "all") {
    if (items.length === 1) return items[0].file + (extra ?? "");
    // v6.5.5 修正（独立验证代理的发现 4）：风格画像这一路**没有"本章"**（它传 targetFile=""），
    // 沿用「除本章外」会造成一句读不通的话（书里共 N 章却说"除本章外 N 章"）。
    // 无目标章时改说「全书 N 章」——该字段是本版新增的，没有按旧格式解析的历史读取方，安全。
    return (hasTarget ? "全书除本章外的 " : "全书 ") + items.length + " 章" + (extra ?? "");
  }
  return "自定义基线 " + items.length + " 章" + (extra ?? "");
}
/**
 * 解析出**实际参与基线的条目**。入参 `items` 只需每项带 `file` 字段
 * （各消费方传的东西不同：章节对象 / {file,text} / {file,metrics}，故这里只认 `file`）。
 *
 * 返回 `{ items, scope, mode, selected, missing, fellBack }`
 * - `items`：**已排除目标章**、可直接拿去算基线的条目（与入参同类型）
 * - `scope`：`baselineScope` 输出字段的文案（读取方按它显示"基线是什么"）
 * - `selected`：配置里选中的章数；`missing`：其中已不存在的章数
 * - `fellBack`：自定义选择失效而回退 `all` 时为 true（消费方应据此**披露**，
 *   否则用户会以为自己选的 10 章生效了，实际是全书）
 */
export async function resolveBaselineScope(root, book, items, targetFile, exec) {
  const list = (Array.isArray(items) ? items : []).filter((x) => x && typeof x.file === "string");
  const target = String(targetFile ?? "");
  // 目标章无条件排除（即使被选中）：拿自己跟自己比必然"完美符合"
  const base = list.filter((x) => x.file !== target);
  const conf = await readBaselineScope(root, book, exec);
  if (conf.mode !== "custom" || conf.chapters.length === 0) {
    return { items: base, mode: "all", scope: describeBaselineScope("all", base, "", target !== ""), selected: 0, missing: 0, fellBack: false, reason: "" };
  }
  const want = new Set(conf.chapters);
  // v6.5.5 修正（独立测试代理抓到的真 bug）：`missing` 此前是
  //   conf.chapters.length - 入参里存在的选中章数
  // 于是**目标章被算成"已失效"**——它明明存在，只是作为被判定者按设计排除（callers 常常
  // 传的 items 已经不含目标章，这时它就被误记成失效）。文案会写出
  // 「自定义基线 1 章（选中 2 章，其中 1 章已失效）」，把"按设计排除"说成"章没了"——虚假信息。
  // 现在：missing 只统计**除目标章之外**、选中了却不在入参里的章（= 真的改名/删除/换书库）。
  const selectedOthers = conf.chapters.filter((f) => f !== target);
  const existsOthers = selectedOthers.filter((f) => list.some((x) => x.file === f)).length;
  const missing = Math.max(0, selectedOthers.length - existsOthers);
  // v7.3.1 修（#9）：删除 `presentSelected = list.filter(x => want.has(x.file)).length`。
  // 它算完从未被读（回退判据实际用的是下面的 selectedOthers.length，见下方 onlyTarget 的说明），
  // 而它把**目标章也算进 want**，与「按设计排除目标章」的口径相反——真拿去用会得出错误结论，
  // 所以选择「删掉」而不是「补用」：需要的两种回退原因已经由 selectedOthers 一次判准。
  const picked = base.filter((x) => want.has(x.file));
  if (picked.length === 0) {
    // 选中项全部无法参与基线 → 回退 all 并披露。
    // 不返回空基线：空基线会算出 μ=0 的假基线，把"没基线"伪装成"全都在带内"。
    // 两种原因要分开说（测试代理指出旧文案把"只选了本章"也说成"选择已失效"）：
    //   ① selectedOthers 里还有章但都失效 → 真的失效
    //   ② 选中的章**全是本章自身** → selectedOthers 为空，它在设计上就不能当自己的基线
    // ⚠️ 判据只能用 selectedOthers 是否为空：不能用"目标章是否出现在入参 items 里"——
    //    消费方常常已经把目标章从 items 里剔掉了（如 brief 传 chapters 全集、fixplan 传已筛集合），
    //    那样判会恒为 false（第一版就是这么写错的，测试代理的观察行抓到了）。
    const onlyTarget = selectedOthers.length === 0;
    return {
      items: base,
      mode: "all",
      scope: describeBaselineScope("all", base,
        onlyTarget ? "（选中的章只有本章自身，不能作为自己的基线，已回退全书）" : "（自定义选择已失效，已回退全书）", target !== ""),
      selected: conf.chapters.length,
      missing,
      fellBack: true,
      reason: onlyTarget ? "only-target" : "all-missing"
    };
  }
  // v6.5.5 措辞修正（独立测试代理第二轮）：这里**不能说"已失效"**。
  // resolver 只看得见调用方递进来的 items，而各消费方递的池子不同：
  //   · style_check / fixplan 递章节全集或已筛集合
  //   · brief 递的是 `perChapter`——`computeBaseline` 会把**正文不足 40 字**的章丢掉
  // 于是"存在但太短"的章也会落进这个差集。说成"已失效"就是把"章太短"谎报成"章没了"。
  // 改成中性的「未纳入基线」，并**如实列出两种原因**——这样无论调用方递什么池子，这句话都成立。
  // （精确的"文件是否存在"只有带 available 章节表的路由才判得准，那里的 missing 是准的。）
  const extra = "（选中 " + conf.chapters.length + " 章" +
    (missing > 0 ? "，其中 " + missing + " 章未纳入基线（已删除、或正文过短无法测量）" : "") + "）";
  return {
    items: picked,
    mode: "custom",
    scope: describeBaselineScope("custom", picked, extra),
    selected: conf.chapters.length,
    missing,
    fellBack: false,
    // v6.5.5：回退原因由**裁决点**给出，消费方不必猜、也不必去解析 scope 字符串。
    // 起因：改稿台原来只要 fellBack 就写「自定义选择已失效」，而另一种原因是
    // "选中的只有本章自身"——那句话在那条路径上是**错的**（文档复核指出后，选择在这里补字段而不是在
    // 各消费方各写一遍判断）。取值："" 正常生效 / "only-target" / "all-missing"。
    reason: ""
  };
}

/**
 * v7.0.0（v2.1 模块 2）：**参照集**裁决点——在基线范围之上再区分"向谁看齐"与"诊断谁"。
 *
 * 为什么必须分开：锚段/动作链/相对分位是"向原著看齐"（要从作者的标杆章取样）；
 * 而套话 Top、上一章症状是"诊断模型"（要从最近 AI 续写章取样）。两者共用"全书"时，
 * 书越长、续写占比越高，"原著颗粒度"就越像 AI 自己的味道（`brief.js` 注释里记过 issue #1 的漂移）。
 *
 * provenance 只有两档（不做 imported：`novel_import` 不落来源元数据，硬推断会产出假精度）：
 *   · custom         用户明确勾了标杆章
 *   · all-unverified 按全书（可能含续写章）——调用方需据此做披露
 */
export async function resolveReferenceSet(root, book, chapters, targetFile, exec) {
  const scope = await resolveBaselineScope(root, book, chapters, targetFile, exec);
  const provenance = scope.mode === "custom" && scope.fellBack !== true ? "custom" : "all-unverified";
  return { items: scope.items, provenance, scope };
}

/** 参照集疑似含续写章时的披露文案（数太少时不打扰：新书本来就没几章） */
export function describeReferenceProvenance(provenance, itemCount) {
  if (provenance === "custom") return "";
  if (!Number.isFinite(itemCount) || itemCount < 4) return "";
  return "参照集为全书（含已写续写章）：建议在侧边栏「风格基线范围」只勾选原著或最满意的标杆章，防止动作链与相对分位随续写漂移。";
}

/**
 * v7.0.0（v2.1 模块 2）：**诊断集**——只看目标章之前最近 1~3 章。
 * 有意义的是"模型最近写出来的东西"，不是全书平均，所以取最近的。
 * 自定义参照集时要把被勾成标杆的原著章剔掉：那是"要像它"，不是"它有病"。
 */
export function selectDiagnosisChapters(chapters, targetNumber, referenceFiles, limit = 3) {
  const list = (Array.isArray(chapters) ? chapters : []).filter((c) => c && typeof c.file === "string");
  const refSet = new Set(Array.isArray(referenceFiles) ? referenceFiles : []);
  const before = list
    .filter((c) => typeof c.number === "number" && Number.isFinite(targetNumber) && c.number < targetNumber)
    .filter((c) => !refSet.has(c.file))
    .sort((a, b) => (b.number ?? 0) - (a.number ?? 0));
  return before.slice(0, Math.max(1, Math.min(3, limit)));
}

/** 分位数（最近秩，p 取 0~100；空数组返回 0）——不引入插值，避免"小数分位"在小样本上装精确 */
export function percentile(values, p) {
  const arr = (Array.isArray(values) ? values : []).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(((sorted.length - 1) * p) / 100)));
  return Math.round(sorted[idx] * 100) / 100;
}

/** 一组数的四分位摘要（键名与 chapter-diagnose 的 refStats 契约一致） */
function percentileSummary(values) {
  return {
    p10: percentile(values, 10),
    p50: percentile(values, 50),
    p85: percentile(values, 85),
    p95: percentile(values, 95)
  };
}

/**
 * v7.0.0（v2.1 模块 6）：把逐章测量聚成**参照集分位**，供症状判定做"相对判定"。
 * 只用相对分位、不用绝对常数：题材/视角/作者之间的差异比"好文本与坏文本"的差异还大，
 * 拍脑袋的常数要么永不触发、要么近一半误报（六审在真实书库上实测过）。
 *
 * @param {Array<{actionVerbsPer1000:number, objectNounsPer1000:number, sense:object, abstractDensity:number, bareDialogueRun:number}>} samples
 */
export function buildReferenceStats(samples) {
  const list = (Array.isArray(samples) ? samples : []).filter((s) => s && typeof s === "object");
  const pick = function (fn) {
    return list.map(fn).filter((v) => typeof v === "number" && Number.isFinite(v));
  };
  const channels = ["visual", "auditory", "tactile", "olfactory", "temperature"];
  const senseChannels = {};
  for (const ch of channels) {
    const summary = percentileSummary(pick((s) => (s.sense && typeof s.sense[ch] === "number" ? s.sense[ch] : void 0)));
    const densityVals = pick((s) => (
      s.sense && typeof s.sense[ch] === "number" && typeof s.chars === "number" && s.chars > 0
        ? Math.round((s.sense[ch] / s.chars) * 1000 * 100) / 100
        : void 0
    ));
    if (densityVals.length > 0) summary.p10Per1000 = percentile(densityVals, 10);
    senseChannels[ch] = summary;
  }
  const runs = pick((s) => s.bareDialogueRun);
  const charList = pick((s) => (typeof s.chars === "number" && s.chars > 0 ? s.chars : void 0));
  const out = {
    chapters: list.length,
    actionVerbsPer1000: percentileSummary(pick((s) => s.actionVerbsPer1000)),
    objectNounsPer1000: percentileSummary(pick((s) => s.objectNounsPer1000)),
    sensePer1000: percentileSummary(pick((s) => s.sensePer1000)),
    abstractDensity: percentileSummary(pick((s) => s.abstractDensity)),
    senseChannels,
    bareDialogueRun: {
      p50: percentile(runs, 50),
      p95: percentile(runs, 95),
      max: runs.length > 0 ? Math.max(...runs) : 0
    }
  };
  if (charList.length > 0) {
    out.avgChars = Math.round(charList.reduce((a, b) => a + b, 0) / charList.length);
  }
  return out;
}

/**
 * v7.0.0（v2.1 模块 3）：原著**典型颗粒度**动作链抽样。
 *
 * 三条取样纪律，每条都对应一个已踩过的坑：
 *   ① 只从 p60~p85 分位取：按"动词最多"降序取样本，等于专挑最密、最不典型的打斗句——
 *      开写包给出的示范永远比作者自己写得更密，作者只会觉得"我写不到"；
 *   ② 按目标章号确定性轮换（步长 7 > 每次取 3），相邻章天然不重叠，不需要额外记账；
 *   ③ 池子不足时不假装轮换：`L <= 3` 直接全量返回，`L === 0` 明确降级。
 *
 * @param {Array<string|{text:string}>} referenceTexts 参照集正文
 * @param {number} targetNumber 目标章号（用于轮换）
 */
export function buildActionChains(referenceTexts, targetNumber) {
  const list = Array.isArray(referenceTexts) ? referenceTexts : [];
  const seen = new Set();
  const all = [];
  for (const item of list) {
    const text = typeof item === "string" ? item : String(item?.text ?? "");
    for (const cand of actionChainCandidates(text)) {
      if (seen.has(cand.text)) continue;
      seen.add(cand.text);
      all.push(cand);
    }
  }
  if (all.length === 0) {
    return { chains: [], poolSize: 0, degraded: "参照集没有符合条件的完整动作句（15~70 字、≥2 个动作动词、≥1 个物件）——本章不带动作链示范" };
  }
  // 优先从零抽象词的纯物理动作句中取样（足够 ≥3 条时过滤掉夹带抽象总结词的句子；不足时回退全集）
  const zeroAbstract = all.filter((c) => measureStyleMetrics(c.text).metrics.abstractDensity === 0);
  const base = zeroAbstract.length >= 3 ? zeroAbstract : all;
  // v7.0.0 修正（审查实测 P0）：**旧版是"降序排序后取 0.6N~0.85N"，抽到的是倒数区间的稀疏句**
  // （p15~p40，正好是全书动作最少的那些），与"取 p60~p85 典型颗粒度"完全相反。
  // 现在改为按**动作密度**（动词数 / 码点长度）升序，再取 p60~p85 区间——
  // 用密度而不是绝对动词数，避免"长句靠长度堆够 2 个动词"混进中位数。
  const densityOfChain = (c) => {
    const len = Array.from(c.text).length;
    return len === 0 ? 0 : (c.verbs * 100) / len;
  };
  const sorted = base.slice().sort((a, b) => densityOfChain(a) - densityOfChain(b) || a.text.length - b.text.length);
  const lo = Math.floor(sorted.length * 0.6);
  const hi = Math.max(lo + 1, Math.ceil(sorted.length * 0.85));
  const pool = sorted.length <= 3 ? sorted : sorted.slice(lo, Math.min(hi, sorted.length));
  const L = pool.length;
  if (L <= 3) return { chains: pool.map((c) => c.text), poolSize: L };
  const n = Number(targetNumber);
  const start = (((Number.isFinite(n) ? n : 0) * 7) % L + L) % L;
  const chains = [];
  for (let i = 0; i < 3; i += 1) chains.push(pool[(start + i) % L].text);
  return { chains, poolSize: L };
}

export async function buildStyleAnchorPackage(root, book, chapters, exec, preloadedText) {
  // v4.3.0 修正：预读文本是必需契约（root/book/chapters 形参保留仅为兼容 index.js 的位置调用，函数内已不用）。
  // 选择"删除磁盘兜底 + assert"而不是"补测试覆盖"：唯一可达的兜底场景是 preloadedText === ""（整本书都是
  // 空章节文件），那时重读磁盘得到的同样是空文本——兜底本身不产生任何锚段，纯粹是一次无意义的全书双读；
  // 而它把"新调用点漏传预读"这种契约错误掩盖成"空锚包"（静默降级）。assert 必须放在 try 之外：
  // 放进去会被函数尾部的 catch 吞掉，又退化成静默失败。三个调用点（index.js style_check/style_report/new_chapter）
  // 均已显式传入，见 test 侧探针 fixB-13 的源码级核对。
  assert(typeof preloadedText === "string" || Array.isArray(preloadedText),
    "buildStyleAnchorPackage 契约：必须传入已读文本（string 全文 或 {file,text}[]），不再提供去磁盘兜底读取");
  const anchors = [];
  const skeletons = [];
  // v6.6.0：内部失败必须能被调用方**区分**于「正文本来就不满足抽样条件」（段落 ≥ 40 字）。
  // 旧版一律返回空锚包，开写包于是把系统的失败讲成「本书正文不满足抽样要求」✗。
  // 只在**失败路径**补一个 failed 标记：成功路径的返回结构（anchors / skeletons 两键）一字不动，
  // 既有消费方（brief / novel_style_check / novel_style_report / novel_new_chapter）都只读这两个键。
  let failed = false;
  try {
    // v3.8.0 性能：复用调用方已读文本（preloadedText=string 全文 / {file,text}[] 数组）——大书不再双读
    const allText = (typeof preloadedText === "string"
      ? preloadedText
      : preloadedText.map(function (x) { return x.text || ""; }).join("\n")).replace(/\r\n?/g, "\n");
    // v4.0.0：全书等距抽样（语义同 vibe.js sampleEvenly：超量时首尾保留、均匀取 max 条；max=1 取中位段）
    // 旧版 pick 从段首顺序取，锚段几乎全部来自序章/开头章，中后段文风样本拿不到
    const sampleEvenly = function (list, max) {
      if (!Array.isArray(list) || list.length === 0 || max <= 0) return [];
      if (list.length <= max) return list.slice();
      if (max === 1) return [list[Math.floor((list.length - 1) / 2)]];
      const out = [];
      const step = (list.length - 1) / (max - 1);
      for (let i = 0; i < max; i++) out.push(list[Math.round(i * step)]);
      return out;
    };
    const paras = allText.split(/\n+/).map(function (p) { return p.trim(); }).filter(function (p) { return p.length >= 40; });
    const pick = function (list, label, n) {
      for (const p of sampleEvenly(list, n)) anchors.push({ label: label, text: p.slice(0, 200) });
    };
    const dialogue = paras.filter(function (p) { return /["“]/.test(p) && p.length <= 200; });
    const psych = paras.filter(function (p) { return /想|觉得|心|怕|慌|记忆/.test(p) && !/["“]/.test(p) && p.length <= 200; });
    const desc = paras.filter(function (p) { return !/["“]/.test(p) && p.length >= 80 && p.length <= 200; });
    pick(dialogue, "对话", 2);
    pick(psych, "心理", 1);
    pick(desc, "描写", 2);
    if (anchors.length === 0) {
      for (const p of sampleEvenly(paras, 3)) anchors.push({ label: "原文", text: p.slice(0, 200) });
    }
    // v7.3.3 修（M1）：切句前先剥掉 Markdown 标题行（以 # 开头的行）——旧版直接对全文按句号切分，
    // 标题与紧随的正文粘成一句（实测 `# 第02章 雨夜` + 首句 → 「#第02章雨夜他沿着河岸慢慢走…」24 字，
    // 正好落进 20~45 的采样窗口）。novel_new_chapter 落盘的章节正是标题开头，短首句的书必然中招；
    // 本函数供 brief / style_check / new_chapter / style_report 共用，故骨架必须不含 `#`。
    const skeletonSource = allText.split(/\n+/).filter(function (line) { return !/^\s*#/.test(line); }).join("\n");
    const sentences = (skeletonSource.match(/[^。！？…\n]+[。！？…]*/g) || []).map(function (s) { return s.replace(/\s+/g, "").trim(); }).filter(function (s) { return s.length >= 20 && s.length <= 45; });
    const seen = new Set();
    const uniqSentences = [];
    for (const s of sentences) {
      if (seen.has(s)) continue;
      seen.add(s);
      uniqSentences.push(s);
    }
    // v4.0.0：骨架同样全书等距抽样（去重后均匀取 4 条），不再只取开头句；条数上限与分类逻辑不变
    for (const s of sampleEvenly(uniqSentences, 4)) {
      let type = "陈述";
      if (/["“]/.test(s)) type = "对话";
      else if (/[？?][！!…]*$/.test(s)) type = "疑问";
      else if (/想|觉得|仿佛|好像|似乎/.test(s)) type = "心理";
      skeletons.push({ type: type, text: s });
    }
    if (skeletons.length === 0) {
      // v7.3.3 修（M1）：兜底路径同样不得把标题行当骨架（否则主路径剥了 #、兜底路径又把 # 带回来）
      const firsts = sampleEvenly(allText.split(/\n+/).map(function (p) { return p.trim(); }).filter(function (p) { return p.length >= 15 && !/^#/.test(p); }), 4);
      for (const ft of firsts) skeletons.push({ type: "陈述", text: ft.slice(0, 60) });
    }
  } catch {
    failed = true;
    // v6.6.0：内部失败被吞成**空锚包**——调用方只看得到 anchors/skeletons 为空，
    // 与"这本书文本太短、本来就抽不出锚段"完全一样（开写包/改稿台的"原著锚段"就这样静默消失）
    logEvent("silent_skip", { book, level: "warn", detail: "原著锚段/句式骨架生成失败（返回空锚包，风格对照缺失）" });
  }
  // v4.0.0 修正：pick 合计请求 2 对话 + 1 心理 + 2 描写 = 5 条，旧版统一截到 4 条会把"描写"锚砍掉一条
  return failed
    ? { anchors: anchors.slice(0, 5), skeletons: skeletons.slice(0, 4), failed: true }
    : { anchors: anchors.slice(0, 5), skeletons: skeletons.slice(0, 4) };
}
