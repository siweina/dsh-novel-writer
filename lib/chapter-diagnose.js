/**
 * v7.0.0 单章症状诊断（chapter-diagnose.js）——**单一裁决点**。
 *
 * ## 为什么需要这个模块
 * 「这一章的结尾在升华」「对话在站桩」「套话在堆」这些症状，会在三个地方各判一次：
 * 写盘返回（novel_new_chapter）、下一章开写包（novel_chapter_brief）、改稿台（novel_fix_plan）。
 * 三处各写一份阈值和文案，就必然出现同一条结尾得到三种结论的情况——
 * 写盘说合格、开写包说结尾升华、改稿台又说没事。作者收到互相矛盾的指令，这比漏报更难修，
 * 也是本仓库反复修过的缺陷类型。所以这里只留一个函数：所有调用方拿同一份症状数组，
 * 谁都不许再自己算一遍。
 *
 * ## 两条判定纪律
 *   ① 有 refStats（参照集分位）才做**相对判定**（抽象度 / 动作 / 物件 / 感官通道）——
 *      题材、视角、作者之间的差异比"好文本与坏文本"的差异还大，没有分位就不许拍绝对阈值；
 *   ② 没有 refStats 时只报**结构性**症状（章末升华、站桩、套话），相对类一律不报：
 *      宁可少报，也不拿没有依据的阈值乱判。
 *
 * ## 依赖口径（不新增任何词表/切句/分词实现）
 *   · 切段：`analysis.splitBlocks`；
 *   · 动作/物件/感官密度：`analysis.densityOf`（已含上下文豁免层 v7.0.0）——
 *     **"这个片段有没有物理交互"一律走它**，不许再用 `analysis.densityChannelCovers`：
 *     那是 analysis.js 里明标"**测试专用**"的裸正则探针，直接 `re.test()`，**不经过**
 *     collocation-guards 豁免层（实测「他根本不信」里的「本」会被判成实物器物，
 *     一个虚词就能打断连续裸台词游程）；
 *   · 抽象度：`style-metrics.measureStyleMetrics`；
 *   · 套话：`lexicons/slop.scanSlop`。
 * 本文件只额外带两个**判定用**小常量：抽象总结词表（任务书要求，小而准）与
 * 感知/心理动词剔除表（「望/看/听/想/知」不算具象动作）。二者都不是替代词表。
 *
 * 纯函数：零 IO、不抛异常（空文本返回 []、异常输入兜底），数值统一两位小数。
 */

// v7.0.0 修正：不再引入 densityChannelCovers（测试专用、无豁免层），
// 所有"有没有动作/物件/感官命中"都改走 densityOf（见 physicalInteractionOf）。
import { densityOf, splitBlocks } from "./analysis.js";
import { measureStyleMetrics } from "./style-metrics.js";
import { scanSlop, topSlopCategories } from "./lexicons/slop.js";

/** 统一两位小数（任务书口径） */
function round2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** 任意输入 → 字符串（不抛异常） */
function toPlainText(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return String(value);
  } catch {
    return "";
  }
}

/**
 * 抽象总结词表（本地常量，小而准）。
 * 只收"升华句"确实会用的词：普通叙述（知道某件事）命中 1 个不构成症状，
 * 判定要求末段命中 ≥ 2 个（或同时命中 slop 的 ending_preach 类别）。
 */
const ABSTRACT_SUMMARY_RE = /终于明白|明白过来|那一刻起|才刚刚开始|等待着|等待他|意识到|深知|明白|知道|从此|未来|之路|序幕|命运/g;

/**
 * 感知 / 心理动词：它们在 `densityOf` 的单字词表里算"动作"，
 * 但在升华句里只是「看 / 听 / 想 / 知道」，不是具象动作。
 * 判定前先剔除，否则「他望着远方的夜空，深知……」会因为一个「望」被判成有动作而漏报。
 * （长词在前，避免全局替换时把长词的残余字留下。）
 */
const PERCEPTION_MENTAL_RE = /凝视|凝望|注视|看见|望着|看着|盯着|听着|听见|想到|想着|知道|明白|意识|觉得|感到|察觉|看|望|盯|听|想|知/g;

/** 引号对话：中文四种引号 + 半角双引号（不收半角单引号，避免英文撇号误判） */
const DIALOGUE_RE = /“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]{1,400}"/;
const QUOTED_G = /“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]{1,400}"/g;

/** 旁白噪声：标点、空白、引号本身（"剩余旁白 < 12 字"按去掉这些之后算） */
const NARRATION_NOISE_RE = /[\s，。！？、；：…—·\-（）()【】\[\]「」『』“”‘’"'《》]/g;

const SENSE_CHANNEL_CN = Object.freeze({
  visual: "视觉",
  auditory: "听觉",
  tactile: "触觉",
  olfactory: "嗅觉",
  temperature: "温度"
});

const SENSE_CHANNEL_HINT = Object.freeze({
  visual: "光线与颜色",
  auditory: "声响",
  tactile: "器物手感",
  olfactory: "气味",
  temperature: "冷热变化"
});

/**
 * 末段里的"具象动作"次数。
 *
 * 为什么从 `densityOf` 反推次数而不是另写一套计数：
 * `densityOf` 的 `actionVerbsPer1000` 已经是全仓库唯一的**去噪后**动作口径
 * （v7.0.0 上下文豁免层就挂在那里）。它的分母是 `stripped.length`，
 * 反推 `per1000 * len / 1000` 在段落尺度（几十字）下可精确还原整数，且不会再产出一张
 * 与主口径打架的动词表。感知/心理动词先剔除（见 PERCEPTION_MENTAL_RE）。
 */
function countConcreteActions(text) {
  const src = toPlainText(text);
  if (src === "") return 0;
  const stripped = src.replace(PERCEPTION_MENTAL_RE, "");
  if (stripped.replace(NARRATION_NOISE_RE, "") === "") return 0;
  const per1000 = densityOf(stripped).actionVerbsPer1000;
  if (!(per1000 > 0)) return 0;
  return Math.max(0, Math.round((per1000 * stripped.length) / 1000));
}

/**
 * 片段里有没有"物理交互"（动作 / 物件 / 感官，任一通道有**真实**命中即算）。
 *
 * 为什么不再用 `densityChannelCovers`：它是 `analysis.js` 里明写"**测试专用**"的裸正则探针，
 * 直接 `re.test()`，**不经过** v7.0.0 的上下文豁免层（collocation-guards）。实测
 * 「“胡说！”他根本不信。」的旁白「他根本不信」里的「本」会被 object 通道判成"含实物器物"，
 * 于是连续裸台词游程被一个虚词打断（站桩漏检）。「根本 / 一点 / 要被人 / 痛苦 / 温柔」
 * 这类词在正文里遍地都是，拿它当"有物理交互"的判据等于让游程时断时续。
 *
 * 改用 `densityOf`（全仓库唯一去噪口径，豁免层就挂在它里面）：
 *   · 感官通道直接读 `detail.sense` 的**原始次数**，无需换算；
 *   · 动作 / 物件只有千字归一值，按 `per1000 * len / 1000` 反推次数——分母就是传进来的
 *     片段长度（与 `densityOf` 的 `src.length` 同口径），段/句尺度（几十字）上能精确还原整数；
 *     反推成 0 而 `per1000 > 0` 时按 1 次计（只在上万字片段上才会发生，而 per1000 > 0
 *     本身已经说明豁免层漏过去了一个真实命中，不该被四舍五入吃掉）。
 *
 * 三个通道都算：动作是"做了"，物件是"碰到"，感官是"接触到"——
 * 「他摩挲着杯沿」的「摩挲」不在任何动词表里，但「杯」说明人物与器物有接触，不是纯站桩。
 */
function physicalInteractionOf(fragment) {
  const src = toPlainText(fragment);
  const empty = { actions: 0, objects: 0, senses: 0, total: 0 };
  if (src === "" || src.replace(NARRATION_NOISE_RE, "") === "") return empty;
  const detail = densityOf(src);
  const recover = (per1000) => {
    const n = Number(per1000);
    if (!(n > 0)) return 0;
    return Math.max(1, Math.round((n * src.length) / 1000));
  };
  const sense = detail && detail.sense && typeof detail.sense === "object" ? detail.sense : {};
  let senses = 0;
  for (const value of Object.values(sense)) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) senses += n;
  }
  const actions = recover(detail.actionVerbsPer1000);
  const objects = recover(detail.objectNounsPer1000);
  return { actions, objects, senses, total: actions + objects + senses };
}

/** 一组分位是否"全为 0 / 缺失"（书太短或该维度恒为 0 时跳过该维度，避免误报） */
function allQuantilesZero(summary) {
  if (!summary || typeof summary !== "object") return true;
  return !["p10", "p50", "p85", "p95"].some((key) => Number.isFinite(Number(summary[key])) && Number(summary[key]) > 0);
}

/**
 * 感官通道单一点的**本章最短章长门控**（600 字）。
 * 依据 docs/experiments/calibration-7.0.md：参照集里多为 100~379 字的短章，
 * 短章"一次触觉都没写"是正常的（还不够展开），在此点名的代价比漏报大。
 */
const SENSE_MONO_MIN_CHARS = 600;

/**
 * 参照集某感官通道的**千字密度地板**（拿不到参照集章长时返回 null）。
 *
 * 为什么要换算：`refStats.senseChannels` 里存的是**次数**
 * （`core.buildReferenceStats` 从 `samples.sense` 取分位），次数随章长线性增长。
 * 直接拿次数跟本章次数比有两个死结（实测）：
 *   ① 参照集的 tactile / olfactory / temperature 的 p10 全是 0
 *      （见 `docs/experiments/calibration-7.0.md` 的标定表），`hits < 0` 恒为 false，
 *      三个最该点名的通道**永远不触发**；
 *   ② 反过来，参照集全是万字长章时 p10 = 5 次，2000 字的正常章**永远误报**。
 * 换成"每千字多少次"两边才可比：本章 1.0/千字 vs 万字参照集地板 0.5/千字 → 不报；
 * 本章 0/千字 vs 地板 0.5/千字 → 报。
 *
 * 章长来源按可信度取第一个可用的：
 *   ① 通道摘要自带密度分位（p10Per1000 / p10Density）——外部显式给了就直接用；
 *   ② `refStats` 上登记了参照集章长（avgChars / avgChapterChars / sampleChars / chars）；
 *   ③ 都没有 → 返回 null，由调用方**退化为次数判定**（见 relativeSymptoms 里的注释）。
 * 退化不是偷懒：没有章长就没有分母，硬拿**本章**长度去除参照集的次数
 * （`p10 / 本章字数`）正是 ② 号误报的翻版（把本章长度当成参照集章长）。
 */
function senseDensityFloor(summary, refStats) {
  if (!summary || typeof summary !== "object") return null;
  const explicit = Number(summary.p10Per1000 ?? summary.p10Density);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const p10 = Number(summary.p10);
  if (!Number.isFinite(p10) || p10 < 0) return null;
  const chars = Number(
    refStats && (refStats.avgChars ?? refStats.avgChapterChars ?? refStats.sampleChars ?? refStats.chars)
  );
  if (!Number.isFinite(chars) || chars <= 0) return null;
  return (p10 / chars) * 1000;
}

/** 低于参照集下分位时的严重度：越低越严重 */
function severityBelow(value, floor) {
  if (!(Number(floor) > 0)) return 3;
  const ratio = Number(value) / Number(floor);
  if (ratio <= 0.4) return 5;
  if (ratio <= 0.7) return 4;
  return 3;
}

/** 套话快照（scanSlop 缺失或抛错时返回 null，套话维度静默跳过） */
function readSlop(text, slopOpts) {
  try {
    if (typeof scanSlop !== "function") return null;
    const info = scanSlop(text, slopOpts);
    if (!info || typeof info !== "object") return null;
    const hits = Array.isArray(info.hits) ? info.hits : [];
    const total = Number.isFinite(Number(info.total)) ? Number(info.total) : hits.length;
    const densityPer1000 = Number.isFinite(Number(info.densityPer1000)) ? Number(info.densityPer1000) : 0;
    // v7.0.0 修正：**不再**在这里汇总全章的 ending_preach。
    // 章末升华必须按段定位（见 endingSlopHitsOfParagraph）：全章汇总会把第 1 行的
    // 「但他不知道」算到末段头上（实测误报）。这里只带 hits，供按行号过滤。
    return { total, densityPer1000, hits };
  } catch {
    return null;
  }
}

/**
 * 最长连续「裸台词段」：段落含引号对话，去掉引号内台词后旁白 < 12 字，
 * **且**旁白里没有非言语动作（这里把「物件名词出现」也算作物理交互：
 * 「他摩挲着杯沿」里的「摩挲」不在任何既有动词表里，但「杯」说明人物与器物有接触，
 * 不是纯站桩）。
 *
 * 为什么"旁白短"与"无动作"要同时满足：短旁白 + 一个真实动作（"他摩挲着杯沿，道。"）
 * 已经是正常的对话节拍，不该算站桩；只有"短且只有道/冷笑"才是。
 *
 * @returns {{run:number, from:number, to:number}} from/to 为 1-based 段落序号（0 表示无）
 */
export function maxBareDialogueRun(text) {
  try {
    const src = toPlainText(text);
    if (src.trim() === "") return { run: 0, from: 0, to: 0 };
    const blocks = splitBlocks(src);
    let best = { run: 0, from: 0, to: 0 };
    let current = 0;
    let start = 0;
    for (let i = 0; i < blocks.length; i += 1) {
      if (isBareDialogueBlock(blocks[i])) {
        if (current === 0) start = i + 1;
        current += 1;
        if (current > best.run) best = { run: current, from: start, to: i + 1 };
      } else {
        current = 0;
      }
    }
    return best;
  } catch {
    return { run: 0, from: 0, to: 0 };
  }
}

function isBareDialogueBlock(block) {
  if (!DIALOGUE_RE.test(block)) return false;
  const narration = block.replace(QUOTED_G, " ");
  const compact = narration.replace(NARRATION_NOISE_RE, "");
  // 旁白够长 = 有叙述内容，不算"只有台词"（宁可少报）
  if (Array.from(compact).length >= 12) return false;
  // 感知/心理动词（望/看/听/想/知）不算具象动作（countConcreteActions 内部先剔除）
  if (countConcreteActions(narration) > 0) return false;
  // 词表漏掉的手臂动作（摩挲/把玩…）用"与器物/感官接触"作代理信号。
  // v7.0.0 修正：这一步必须走 densityOf 的**豁免层**——旧版用 densityChannelCovers，
  // 「他根本不信」里的「本」被当成实物器物，连续裸台词游程被虚词打断（站桩漏检）。
  if (physicalInteractionOf(narration).total > 0) return false;
  return true;
}

/**
 * 末段在原文里的行号区间（1-based，含端点）。
 *
 * `scanSlop` 的 `hits[].line` 是 1-based 行号，要把"末段"落回行区间才能过滤；
 * 拿不到区间时才退化为"对末段文本重扫"（见 endingSlopHitsOfParagraph）。
 * 行口径与 `analysis.splitBlocks` 一致：剔除 Markdown 标题行与分割线，空行分隔段落；
 * 末段 = 结尾一串连续的内容行（splitBlocks 把多行段落用 "\n" 拼成一个块，
 * 这里取最后一串内容行正是它的行来源）。
 */
function lastBlockLineRange(text) {
  const normalized = toPlainText(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.trim() === "") return null;
  // 行口径与 splitBlocks 完全一致：先剔除标题行与分割线（保留原始行号），再看有没有空行分段。
  const kept = [];
  const rawLines = normalized.split("\n");
  for (let i = 0; i < rawLines.length; i += 1) {
    const t = rawLines[i].trim();
    if (/^#{1,6}\s/.test(t)) continue;
    if (/^[-_*=]{3,}$/.test(t)) continue;
    kept.push({ line: i + 1, text: t });
  }
  const firstContent = kept.findIndex((entry) => entry.text !== "");
  if (firstContent < 0) return null;
  let lastContent = -1;
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    if (kept[i].text !== "") { lastContent = i; break; }
  }
  if (lastContent < 0) return null;
  const hasBlank = kept.some((entry, i) => entry.text === "" && i > firstContent && i < lastContent);
  // v7.3.1 修（#40）：无空行时不能一律只取最后 1 行——slop.endingLineSet 的判据是
  // 「全章无空行且内容行 ≤4 → 整章视作同一末段」（正是 slop 注释声明要覆盖的短章情形）；
  // 旧版恒取最后 1 行，这类短章的章末升华（ending_preach）会漏报。这里与 slop 侧同阈值：
  // 内容行 ≤4 → 整章内容行都是末段；内容行 >4 → 按单行分段，末段 = 最后 2 行内容行（也与 slop 一致）。
  if (!hasBlank) {
    const contentEntries = kept.filter((entry) => entry.text !== "");
    if (contentEntries.length <= 4) return { from: kept[firstContent].line, to: kept[lastContent].line };
    return { from: contentEntries[contentEntries.length - 2].line, to: contentEntries[contentEntries.length - 1].line };
  }
  let start = lastContent;
  while (start > 0 && kept[start - 1].text !== "") start -= 1;
  return { from: kept[start].line, to: kept[lastContent].line };
}

/**
 * **某一段**落在章末套话（ending_preach）上的命中数——必须按段定位。
 *
 * ① 有末段行区间时：从全章 `hits` 里按 `line` 过滤（最准，也不重复扫）；
 * ② 拿不到段级信息（scanSlop 缺失 / 行结构对不上）时：直接对**这一段文本**重扫——
 *    `scanSlop` 只对"最后 2 个自然段"判 ending_preach，单段文本就是它自己的末段，
 *    所以这一路是精确的；
 * ③ 绝不用全章 `byCategory.ending_preach` 汇总：那会把第 1 行的「但他不知道」算到末段头上。
 */
function endingSlopHitsOfParagraph(paragraphText, slop, range, opts) {
  if (range && slop && Array.isArray(slop.hits)) {
    let count = 0;
    for (const hit of slop.hits) {
      if (!hit || hit.category !== "ending_preach") continue;
      const line = Number(hit.line);
      if (Number.isFinite(line) && line >= range.from && line <= range.to) count += 1;
    }
    return count;
  }
  try {
    if (typeof scanSlop !== "function") return 0;
    // v7.3.1 修（#41）：重扫必须带**同一份豁免参数**（题材静音 / 参照集习惯词）——否则已被豁免的作者
    // 习惯写法会在倒数第二段重新触发 ending_preach，与末段口径不一致。
    const info = scanSlop(toPlainText(paragraphText), opts);
    const byCategory = info && info.byCategory && typeof info.byCategory === "object" ? info.byCategory : {};
    const n = Number(byCategory.ending_preach);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * 章末升华：只看最后 2 个自然段，且**末段先过一道合格闸**。
 *
 * v7.0.0 修两个实测缺陷：
 *   ① 套话命中按段定位（见 endingSlopHitsOfParagraph）——旧版吃全章 ending_preach 汇总，
 *      「但他不知道，客栈来了怪人。／他推开木门拿起茶杯。／夜色渐深。」把第 1 行算到末段头上，
 *      明明结尾停在具体动作上却报升华；
 *   ② 末段已经合格（含引号对话 / 去噪后动作动词 ≥ 2）时**直接判结尾合格**，不往前翻也不照样报——
 *      结尾停在动作或半句话上，本来就是要的样子。
 */
function endingPreachSymptom(src, blocks, slop, slopOpts) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  const lastText = blocks[blocks.length - 1];
  if (DIALOGUE_RE.test(lastText)) return null;
  if (countConcreteActions(lastText) >= 2) return null;

  const tail = [{
    text: lastText,
    slopHits: endingSlopHitsOfParagraph(lastText, slop, lastBlockLineRange(src), slopOpts)
  }];
  if (blocks.length >= 2) {
    const prevText = blocks[blocks.length - 2];
    // 紧贴末段的上一段也算"章末"的一部分，但它自己也得先过合格闸
    if (!DIALOGUE_RE.test(prevText) && countConcreteActions(prevText) < 2) {
      // v7.3.1 修（#41）：把末段那份带豁免的扫描参数一并传下去（原来走无参 scanSlop 重扫，丢失豁免）。
      tail.unshift({ text: prevText, slopHits: endingSlopHitsOfParagraph(prevText, slop, null, slopOpts) });
    }
  }

  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const item = tail[i];
    const abstractHits = (item.text.match(ABSTRACT_SUMMARY_RE) || []).length;
    const slopHits = item.slopHits;
    if (!(abstractHits >= 2 || slopHits > 0)) continue;
    const severity = Math.min(5, 3 + (abstractHits >= 2 ? 1 : 0) + (slopHits > 0 ? 1 : 0));
    return {
      key: "ending_preach",
      severity,
      title: "章末升华",
      detail: "结尾停在抽象感悟上，改成停在一个未完成的动作或半句没答完的话。"
    };
  }
  return null;
}

/** 站桩对话：阈值有参照集时取 max(4, p95)，无参照集时取 6 */
function bareDialogueSymptom(text, refStats) {
  const run = maxBareDialogueRun(text);
  if (run.run <= 0) return null;
  // 参照集缺这一项（书太短/还没标定）时按"无参照集"处理，退回 6——
  // 不能把缺失当 0 用 max(4, 0)=4 去判，那等于没有依据却更激进。
  const hasRunRef = Boolean(refStats && refStats.bareDialogueRun && Number.isFinite(Number(refStats.bareDialogueRun.p95)));
  const threshold = hasRunRef ? Math.max(4, Number(refStats.bareDialogueRun.p95)) : 6;
  if (run.run < threshold) return null;
  const span = run.from === run.to ? "第" + run.from + "段" : "第" + run.from + "~" + run.to + "段";
  return {
    key: "bare_dialogue",
    severity: Math.min(5, 3 + Math.floor((run.run - threshold) / 2)),
    title: "站桩对话",
    detail: span + "连续 " + run.run + " 段只有台词与「道/冷笑」，给每段补一个器物或身体动作。"
  };
}

const SLOP_SHORT_HINTS = Object.freeze({
  eye_cliche: "改成具体动作或视线落点，别用眼神代情绪。",
  smirk_cliche: "删嘴角弧度/薄凉，改成手上动作或台词。",
  shock_crowd: "删众人哗然/倒吸凉气，只写一个人的具体反应。",
  filler_transition: "删时间过渡套词，直接用动作切入下一幕。",
  abstract_tell: "别直接点破心中情绪，写呼吸与手部动作。",
  ending_preach: "删章末预告，停在未完动作或半句话上。",
  ai_ese: "删公文判断与翻译腔副词，直接陈述事实。",
  stat_numeric: "把倍数/百分比播报改成可感知的具体后果。"
});

/** 套话：命中处数 ≥ 5 且密度 ≥ 2.0 处/千字（refStats 里没有套话分位，所以不做相对判定） */
function slopSymptom(slop) {
  if (!slop) return null;
  if (!(slop.total >= 5 && slop.densityPer1000 >= 2.0)) return null;
  const severity = slop.total >= 10 ? 5 : slop.total >= 7 ? 4 : 3;
  const topCats = topSlopCategories(slop.hits, 1);
  const hint = (topCats.length > 0 && SLOP_SHORT_HINTS[topCats[0]]) || SLOP_SHORT_HINTS.eye_cliche;
  return {
    key: "slop",
    severity,
    title: "套话堆砌",
    detail: "套话 " + slop.total + " 处（" + round2(slop.densityPer1000) + "/千字）：" + hint
  };
}

/** 相对分位症状（只在 refStats 非 null 时调用） */
function relativeSymptoms(text, refStats) {
  const out = [];
  const detail = densityOf(text);
  const metrics = measureStyleMetrics(text).metrics;

  // 抽象度：高于参照集 p95
  const abstractRef = refStats.abstractDensity;
  if (!allQuantilesZero(abstractRef)) {
    const value = round2(metrics.abstractDensity);
    const p95 = round2(abstractRef.p95);
    if (value > Number(abstractRef.p95)) {
      const ratio = Number(abstractRef.p95) > 0 ? value / Number(abstractRef.p95) : 2;
      out.push({
        key: "abstract",
        severity: ratio >= 2 ? 5 : ratio >= 1.5 ? 4 : 3,
        title: "抽象度过高",
        detail: "抽象度 " + value + "，高于参照集 p95（" + p95 + "）：把情绪落到身体反应与器物上。"
      });
    }
  }

  // 动作密度：低于参照集 p10
  const actionRef = refStats.actionVerbsPer1000;
  if (!allQuantilesZero(actionRef)) {
    const value = round2(detail.actionVerbsPer1000);
    const p10 = round2(actionRef.p10);
    if (value < Number(actionRef.p10)) {
      out.push({
        key: "action_thin",
        severity: severityBelow(value, actionRef.p10),
        title: "动作密度偏低",
        detail: "动作密度 " + value + "/千字，低于参照集 p10（" + p10 + "）：关键处写成连续动作链。"
      });
    }
  }

  // 物件密度：低于参照集 p10
  const objectRef = refStats.objectNounsPer1000;
  if (!allQuantilesZero(objectRef)) {
    const value = round2(detail.objectNounsPer1000);
    const p10 = round2(objectRef.p10);
    if (value < Number(objectRef.p10)) {
      out.push({
        key: "object_thin",
        severity: severityBelow(value, objectRef.p10),
        title: "物件密度偏低",
        detail: "物件密度 " + value + "/千字，低于参照集 p10（" + p10 + "）：让器物参与每个事件。"
      });
    }
  }

  // 感官通道单一：本章该通道的**千字密度**低于参照集同一通道 p10 的千字密度。
  //
  // v7.0.0 修正（实测）：旧版是 `hits < summary.p10`（严格小于），而参照集次数分位在
  // tactile / olfactory / temperature 上的 p10 全为 0（calibration-7.0.md），`hits < 0`
  // 恒为 false → 三个最该点名的通道**永不触发**；参照集换成万字长章（p10=5 次）时，
  // 2000 字的正常章又永远误报。现在改成密度比较（换算与退化见 senseDensityFloor）。
  //
  // 两道门控原样保留（这是防"长章的长处去判短章"的另一半保险）：
  //   · 本章该通道**绝对命中 ≤ 1 次**；
  //   · 本章字数 ≥ 600 字（SENSE_MONO_MIN_CHARS）。
  const channelRef = refStats.senseChannels;
  const chapterChars = text.length;
  if (channelRef && typeof channelRef === "object" && chapterChars >= SENSE_MONO_MIN_CHARS) {
    let worst = null;
    for (const channel of ["visual", "auditory", "tactile", "olfactory", "temperature"]) {
      const summary = channelRef[channel];
      if (allQuantilesZero(summary)) continue;
      const hits = Number(detail.sense && detail.sense[channel] ? detail.sense[channel] : 0);
      if (hits > 1) continue;
      const p10Count = Number(summary.p10);
      const floor = senseDensityFloor(summary, refStats);
      const hitsPer1000 = (hits / Math.max(chapterChars, 1)) * 1000;
      let short = false;
      if (!(Number.isFinite(p10Count) && p10Count > 0)) {
        // p10 = 0：参照集里这个通道本来就没人写（或无章长可折算时的退化分支之一）。
        // 只有"一次都没有"才算短板——写了一次就已经超过参照集下分位，不该点名。
        short = hits === 0;
      } else if (floor !== null && floor > 0) {
        // 有（可信的）参照集章长：密度对密度
        short = hitsPer1000 < floor;
      } else {
        // 拿不到参照集章长：退化为次数判定（p10 > 0 已由上面的分支保证）
        short = hits < p10Count;
      }
      if (!short) continue;
      const useDensity = p10Count > 0 && floor !== null && floor > 0;
      const floorValue = useDensity ? floor : p10Count;
      const value = useDensity ? hitsPer1000 : hits;
      const deficit = floorValue > 0 ? value / floorValue : 0;
      if (!worst || deficit < worst.deficit) {
        worst = { channel, hits, floorValue, value, useDensity, deficit };
      }
    }
    if (worst) {
      const channelName = SENSE_CHANNEL_CN[worst.channel];
      const channelHint = SENSE_CHANNEL_HINT[worst.channel];
      let detail;
      if (worst.floorValue === 0) {
        // v7.0.0 修正（审查缺陷 #59）：p10 = 0 时旧文案会输出
        // 「仅 0 次，低于参照集 p10（0 次）」——0 不可能低于 0，读者只会认为工具在胡说。
        // p10 = 0 的语义是"参照集里这个通道本来就少有人写"（tactile/olfactory/temperature 的
        // p10 在标定集里全是 0），本章也没写 → 用独立话术讲成"该通道未使用"，**不做**高低比较。
        // 触发条件（hits === 0）仍保留：一次都没写与参照集下分位持平，但仍是可改进的短板。
        detail = "全章「" + channelName + "」0 次：该通道未使用（参照集 p10 也是 0，属正常）：如场景需要，补一处具体" + channelHint + "。";
      } else {
        const measured = worst.useDensity
          ? "仅 " + round2(worst.value) + "/千字（" + worst.hits + " 次）"
          : "仅 " + worst.hits + " 次";
        const floorText = worst.useDensity
          ? round2(worst.floorValue) + "/千字"
          : round2(worst.floorValue) + " 次";
        detail = "全章「" + channelName + "」" + measured
          + "，低于参照集 p10（" + floorText + "）：补一处具体" + channelHint + "。";
      }
      out.push({
        key: "sense_mono",
        severity: worst.hits === 0 ? 4 : 3,
        title: "感官通道单一",
        detail
      });
    }
  }

  return out;
}

/**
 * 单章症状诊断（单一裁决点）。
 *
 * @param {string} text 章节正文
 * @param {object|null} refStats 参照集分位数（可能为 null = 还没标定），形状见仓库契约：
 *   `{ chapters, actionVerbsPer1000{p10,p50,p85,p95}, abstractDensity{...}, objectNounsPer1000{...},
 *      sensePer1000{...}, senseChannels{visual{...},...}, bareDialogueRun{p50,p95,max} }`
 *   `senseChannels` 里存的是**次数**（core.buildReferenceStats 从 samples.sense 取分位）。
 *   可选 `avgChars` / `avgChapterChars` / `sampleChars`：参照集平均章长（或通道摘要自带的
 *   `p10Per1000`）——有章长/密度分位时按**千字密度**比较，没有则退化为次数判定
 *   （p10=0 时以"本章该通道 0 命中"触发），见 senseDensityFloor 的注释。
 *   refStats 为 null 时**不**退化成绝对阈值，只报结构性症状（章末升华、站桩、套话），
 *   相对类症状一律不报。
 * @returns {Array<{key:string, severity:number, title:string, detail:string}>}
 *   key 固定取值：ending_preach | bare_dialogue | slop | abstract | action_thin | sense_mono | object_thin；
 *   severity 1..5（5 最严重）；数组按 severity 降序（调用方仍可自行再排序取前 N）。
 */
export function diagnoseChapterSymptoms(text, refStats, slopOpts) {
  try {
    const src = toPlainText(text);
    if (src.trim() === "") return [];
    const blocks = splitBlocks(src);
    if (blocks.length === 0) return [];
    const ref = refStats && typeof refStats === "object" ? refStats : null;
    const slop = readSlop(src, slopOpts);
    const found = [];

    try {
      const ending = endingPreachSymptom(src, blocks, slop, slopOpts);
      if (ending) found.push(ending);
    } catch { /* 单维失败不影响其余症状 */ }

    try {
      const bare = bareDialogueSymptom(src, ref);
      if (bare) found.push(bare);
    } catch { /* 同上 */ }

    try {
      const slopHit = slopSymptom(slop);
      if (slopHit) found.push(slopHit);
    } catch { /* 同上 */ }

    if (ref) {
      try {
        found.push(...relativeSymptoms(src, ref));
      } catch { /* 参照集脏数据：该组维度整体跳过 */ }
    }

    found.sort((a, b) => b.severity - a.severity);
    return found;
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// plan 兑现核对（写盘即时用）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * plan 的元指令前缀（"按大纲写 / 照计划推进 / 推进主线"）。
 * 去掉前缀后再判"有没有物象"——否则单字动作表会把「按」「推」当成具象动作，
 * 「按大纲写」这种完全没有物象可核对的元指令会被误判为合格行。
 * 这不是词表，只是"元指令不是计划子句"的格式门。
 */
const PLAN_META_PREFIX_RE = /^(?:按|照|根据|依照|顺着|继续|推进)(?:大纲|剧情|设定|计划|要求|思路|节奏|主线|安排|顺序|进度)?/;

/** plan 行首的列表编号 / Markdown 标记 */
const PLAN_PREFIX_RE = /^\s*(?:[-*•·]|\d+[.、)）]|[（(]\d+[)）])\s*/;

/**
 * v7.0.0 修正（实测）：这些是**我们自己要求的填写格式**，不是要兑现的物象。
 *
 * 「器物：青瓷药瓶」里的「器物」、「场景落点：」里的「场景落点」，正文当然不会写——
 * 旧版没剥它们，于是「器物」被当成一个必须出现的候选（实测：格式完全合规的 plan
 * 得到 unfulfilled:["器物", ...]）。判前整词剔除，连冒号一起去。
 * 顺序敏感：长标签在前（「肢体动作」不被「动作」抢先匹配）。
 */
const PLAN_META_LABEL_RE = /(?:肢体动作|场景落点|器物|物象|实物|画面|落点|动作|需指定)\s*[:：]?/g;

/**
 * v7.0.0 修正（实测）：方括号里是"这一条对应哪段大纲"的**子句原文**，
 * 不是要兑现的物象——`[林风去黑市买药]` 是给人看的子句，拿去正文里找必然找不到。
 * 半角方括号与【】都是子句写法，整段（含内容）剔除。
 */
const PLAN_CLAUSE_BRACKET_RE = /\[[^\]]*\]|【[^】]*】/g;

/** 子句里的虚词/代词：它们不是"片段"的边界，而是噪声（去掉后剩下的才是可核对的物象片段） */
const PLAN_STOP_CHARS_RE = /[的了着过把被在是有和与及并而就都也又才很太更最不没无他她它我你您这那哪谁其之于向从对为以所等个些]/g;

/** 常见状语：切开它，避免"缓缓推开沉重的木门"被当成一个 >6 字的长块而滑过 */
const PLAN_ADVERB_RE = /缓缓|慢慢|忽然|突然|猛地|猛然|轻轻|微微|渐渐|立刻|马上|随即|顿时|终于|依旧|依然|仍然|不禁|忍不住/g;

const PLAN_FRAGMENT_SPLIT_RE = /[|，。；：、！？…,.!?;:（）()\[\]【】「」『』“”"'《》→←⇒\s]+/;
const CHINESE_CHUNK_RE = /[\u4e00-\u9fa5]{2,}/g;

/** 单条 unfulfilled 上限（调用方只展示前 4 条，再多也没人看） */
const PLAN_MAX_MISSING = 12;

/**
 * 一条 plan 行 → "可核对片段"（chunk）列表。
 *
 * v7.0.0 修正（实测，四个成因一起修）：
 *   ① 剥**元标签**（器物 / 物象 / 肢体动作 / 动作 / 场景落点 / 落点 / 画面 / 需指定）；
 *   ② 剥**方括号子句原文**（`[林风去黑市买药]` 属于"该条对应哪段大纲"，不该拿去正文里匹配）；
 *   ③ **不截断**：旧版对长块取 `slice(0,4)` + `slice(-4)`，把「林风去黑市买药」腰斩成
 *      「林风去黑」「黑市买药」两个不存在的词，还把后面的动作/落点整段丢弃（`slice(0,4)`
 *      只留前 4 个片段）。现在按标点/符号切分后逐段保留，长块留给 planChunkGap 按 3 字滑窗核对；
 *   ④ 单字不产生候选（`CHINESE_CHUNK_RE` 要求 ≥2 字）：单字无法核对，留下只会放大噪声。
 */
function planChunksOf(line) {
  const flattened = toPlainText(line)
    .replace(PLAN_CLAUSE_BRACKET_RE, " ")
    .replace(PLAN_META_LABEL_RE, " ")
    .replace(PLAN_ADVERB_RE, " ")
    .replace(PLAN_STOP_CHARS_RE, " ");
  const chunks = [];
  for (const piece of flattened.split(PLAN_FRAGMENT_SPLIT_RE)) {
    if (piece === "") continue;
    for (const chunk of piece.match(CHINESE_CHUNK_RE) || []) {
      if (chunks.indexOf(chunk) === -1) chunks.push(chunk);
    }
  }
  return chunks;
}

/**
 * 一个 chunk 在正文里的**缺口**（对不上的 ≥2 字片段；完全兑现时返回 []）。
 *
 * 为什么不是 `body.indexOf(chunk) === -1` 就直接算漏写：正文本来就允许改写——
 * 「油灯熄灭」写成「油灯在风里熄灭」是**兑现**，不是漏写。所以逐位置推进：
 * 取从当前位置起"最长、且确实在正文里出现"的前缀往前走，只有连 2 个字都对不上时才记缺口。
 * 这样缺口定位得准（旧版 slice 腰斩后，中段丢了根本看不出来）。
 *
 * >6 字的连续汉字块按 **3 字滑窗**核对（任务书要求）：窗口上限压到 3，
 * 长块就不会因为"前 4 个字命中"把后半段整块放行；窗口按位逐格推进，首尾都在窗口里，
 * 不会被腰斩。滑窗只负责判"这块是不是全兑现"，真出现断口时再用全长度匹配定位缺口
 * （否则窗口边界会把缺口切歪，报出「上青铜灯」这种带脏前缀的片段）。
 */
function planChunkGap(chunk, body) {
  const text = toPlainText(chunk);
  if (text.length < 2) return [];
  let allPresent = true;
  if (text.length > 6) {
    const window = 3;
    for (let i = 0; i + window <= text.length; i += 1) {
      if (body.indexOf(text.slice(i, i + window)) === -1) { allPresent = false; break; }
    }
  }
  const gaps = [];
  let i = 0;
  while (i < text.length) {
    let matched = 0;
    // 长块用 3 字窗口探测，短块允许整块比对（短块整体出现是最强的兑现证据）
    const limit = text.length > 6 ? 3 : text.length;
    for (let len = Math.min(limit, text.length - i); len >= 2; len -= 1) {
      if (body.indexOf(text.slice(i, i + len)) !== -1) { matched = len; break; }
    }
    if (matched > 0) { i += matched; continue; }
    let j = i + 1;
    while (j < text.length) {
      let ok = false;
      for (let len = Math.min(limit, text.length - j); len >= 2; len -= 1) {
        if (body.indexOf(text.slice(j, j + len)) !== -1) { ok = true; break; }
      }
      if (ok) break;
      j += 1;
    }
    const gap = text.slice(i, j);
    if (Array.from(gap).length >= 2 && gaps.indexOf(gap) === -1) gaps.push(gap);
    i = j;
  }
  // 滑窗说"每一段都出现过"时按兑现处理（宁可少报：断口 <3 字且两侧都在正文里）
  if (allPresent && gaps.length > 0 && text.length > 6) return [];
  return gaps;
}

/** 合格行：剥掉编号 / 元指令前缀 / 元标签 / 方括号子句后，仍留下 ≥1 个可核对片段 */
function isCheckablePlanLine(line) {
  const probe = toPlainText(line).replace(PLAN_META_PREFIX_RE, " ");
  return planChunksOf(probe).length > 0;
}

/**
 * plan 兑现核对（写盘即时用）。
 *
 * ## 合格性（qualified）
 * 合格 = 整份 plan 里**至少有一行**在剥掉编号 / 元指令前缀 / 元标签 / 方括号子句之后，
 * 还剩 ≥1 个 ≥2 字的可核对片段。
 * 整份只剩「按大纲写」「器物：」「动作：」这类格式词 → qualified:false，
 * 调用方应跳过核对、不产告警（没有可核对的物象，不是"没兑现"）。
 *
 * 为什么不沿用旧版的 `densityChannelCovers("object"/"action")` 门：
 *   · 那是 analysis.js 里明标"测试专用"的裸正则（不经豁免层），「根本」「一点」都能让
 *     一行被判成"具象"；反过来「器物：青瓷药瓶」这种**格式完全合规**的行，
 *     因为「瓶/瓷」都不在物件表里，却被判成不合格——实测的 bug 1 就是这么来的。
 *   合格性只该问"有没有可核对的具体词"，不该问"词表认不认识它"。
 *   带豁免层的计数（physicalInteractionOf）只用在"这个片段有没有物理交互"这个
 *   真正需要问的问题上（isBareDialogueBlock）。
 *
 * ## 兑现判定（每一行独立判）
 *   · 一行里所有片段**都在正文里找不到**（兑现度 0）→ 这一行整行未兑现，片段全进 unfulfilled；
 *   · 否则这一行算**通过**（命中 ≥1 就够，不再把改写造成的残片逐条上报）：
 *       - 未命中比例过半的行已被整体改写（基本不是这份计划了）→ 丢弃，不输出；
 *       - 其余只报"具体对不上的缺口"（`planChunkGap` 按覆盖推进定位，命中处不算漏写），
 *         这样「抓起桌上的青铜灯」在正文写成「抓起桌上的长刀」时只报「青铜灯」，
 *         而不是把整行或半截词（旧版的「上青铜灯」「抓起桌上」）都算漏写。
 * @returns {{qualified:boolean, unfulfilled:string[], checked:number}}
 *   checked = 参与核对的合格行数。
 */
export function checkPlanFulfillment(plan, content) {
  try {
    const planText = toPlainText(plan);
    if (planText.trim() === "") return { qualified: false, unfulfilled: [], checked: 0 };
    const body = toPlainText(content).replace(/\s+/g, "");
    const lines = planText
      .split(/\r?\n/)
      .map((line) => toPlainText(line).replace(PLAN_PREFIX_RE, "").trim())
      .filter(Boolean);

    const checkable = [];
    for (const line of lines) {
      if (!isCheckablePlanLine(line)) continue;
      checkable.push({ chunks: planChunksOf(line.replace(PLAN_META_PREFIX_RE, " ")) });
    }
    if (checkable.length === 0) return { qualified: false, unfulfilled: [], checked: 0 };

    const missing = [];
    const pushMissing = (fragment) => {
      if (!fragment || missing.length >= PLAN_MAX_MISSING) return;
      if (missing.indexOf(fragment) === -1) missing.push(fragment);
    };

    for (const item of checkable) {
      if (missing.length >= PLAN_MAX_MISSING) break;
      const gapsPerChunk = item.chunks.map((chunk) => planChunkGap(chunk, body));
      const fulfilled = gapsPerChunk.filter((gaps) => gaps.length === 0).length;
      // ① 兑现度 0：这一行的候选词一个都没在正文出现 → 整行未兑现
      if (fulfilled === 0) {
        for (const chunk of item.chunks) pushMissing(chunk);
        continue;
      }
      // ② 未命中比例过半 → 这一行整体被改写，通报只会有噪声，丢弃
      if (1 - fulfilled / item.chunks.length > 0.5) continue;
      // ③ 兑现度 ≥1：只报具体缺口（命中处不再算漏写）
      for (const gaps of gapsPerChunk) {
        for (const gap of gaps) pushMissing(gap);
      }
    }
    return { qualified: true, unfulfilled: missing, checked: checkable.length };
  } catch {
    return { qualified: false, unfulfilled: [], checked: 0 };
  }
}