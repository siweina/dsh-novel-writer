/**
 * dsh-novel-writer — core/text.js（Layer 2：文本解码、章节扫描与解析、草稿镜像、正则安全与输出格式化）
 *
 * 严格 DAG 第二层：只依赖 Node 内置、./state.js、../log.js 与 ../analysis.js，不依赖 domain / http。
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { logEvent } from "../log.js";
import { CATEGORY_LABELS, METRIC_CALIBER } from "../analysis.js";
import { novelDataDir, sanitizeSegment } from "./state.js";

const CHAPTER_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
export const READ_LIMIT = 400;
export const READ_MAX_CHARS = 20000;
// v6.2.1 修正：章号标记与中文数字字符类的**唯一来源**——解析（parseChapterNumber）、归一（normalizeChapterKey）、
// 标题清洗（cleanChapterTitle）、书名提取（bookNameFromFileName）此前各写一份字符类，
// 于是同一个「第一节 初遇.md」在章号解析里认不出（排序落尾、重号防护看不见），在归一键里却得「第01章」
// ——与真正的第 1 章共用摘要槽位（静默覆盖）。口径统一为 章/回/话/节（阿拉伯与中文数字两分支都认）。
// 「卷/部」不纳入章号：它们与「第N卷」的分卷写法重叠，误判会把分卷文件当章节。
const CHAPTER_MARK_CHARS = "章回话节";
const CJK_NUMERAL_CHARS = "零一二三四五六七八九十百千万两";
const LEADING_NUMBER = new RegExp("^第?(\\d+)(?:[" + CHAPTER_MARK_CHARS + "])?[\\s._\\-—]*");
// v7.1.0 修正（审查 #52）：**大纲方向行**的唯一解析口径（core / graph / fixplan 共用）。
//
// 为什么必须是常量：三处此前各写一份——core 只认 `^- (\d+)`、graph 认 `- 第N章` 却漏了「节」、
// fixplan 又另认 `3.` / `3、` / `3 标题`。同一份「剧情大纲.md」在三个工具里能读出不同的章号集合，
// 于是 graph 说"大纲里没有方向行"、fixplan 却能取到方向、core 的未回填钩子提醒又是第三套。
//
// 口径（覆盖三处的并集，且都要求章号后**有明确分隔符或章回话节标记**，避免吞掉普通列表行）：
//   `- 3 标题`（novel_outline chapter 自己落盘的格式） / `- 第3章 标题` / `* 第3节 标题`
//   / `3. 标题` / `3、标题` / `3) 标题` / `3：标题` / `3 标题` / `# 第3章 标题`
// 捕获组 1 = 章号（十进制数字），捕获组 2 = 方向行正文。匹配按**单行**进行（调用方逐行 test/exec）。
export const OUTLINE_LINE_RE = /^\s*(?:#{1,6}\s*|[-*+]\s+)?(?:第\s*)?(\d+)\s*(?:[章回话节])?(?:[.、)．:：]\s*|\s+|$)(.*)$/;
// v6.2.1 修正：章号上界（与 numberToCjk 的 n >= 10000 返回 null 同一口径）。
// 五位以上章号必须判为「解析不出」——旧正则写死 \d{1,4} 且不锚定数字前边界，引擎右移起点用尾部 4 位匹配：
// 「第10001章」被当成第 1 章（与「第1章」键碰撞，摘要互相覆盖）、「第12345章」→ 2345。
export const MAX_CHAPTER_NUMBER = 9999;
const CJK_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
export function cjkToNumber(text) {
  const s = String(text).trim();
  if (s === "") return void 0;
  let total = 0;
  let section = 0;
  let hasUnit = false;
  for (const ch of s) {
    if (ch === "十") {
      total += (section === 0 ? 1 : section) * 10;
      section = 0;
      hasUnit = true;
    } else if (ch === "百") {
      total += (section === 0 ? 1 : section) * 100;
      section = 0;
      hasUnit = true;
    } else if (ch === "千") {
      // v4.0.0：补"千"（1000~9999 章可回读）
      total += (section === 0 ? 1 : section) * 1000;
      section = 0;
      hasUnit = true;
    } else if (ch === "万") {
      // v6.2.1 修正：补"万"分支。此前「万」只存在于 8 处字符类里，本函数没有对应分支 →
      // 「一万」「第一万章」永远解不出数值（字符类里的「万」是承重的：删掉会把标记词留在标题里，故保留）。
      // v7.3.1 修（#4）：旧式 `total += (section===0?1:section)*10000` 只把**万位前最后一个数字段**
      // 乘进 10000，已累计的 total 被丢在外面：「十二万」= 10 + 2*10000 = 20010、「十万」= 10010。
      // 中文读法里「万」是**进位权**：它左边的整个数字段（total 里已算好的十/百/千 + section）一起乘 10000。
      // 注意「万」前一个字都没写时（「万」单独出现）才按 1 万读——所以缺省 1 要判**整段为 0**，
      // 不能只判 section===0（否则「十万」会变成 (10+1)*10000=110000，是同一类"漏掉已累计段"的错）。
      const upper = total + section;
      total = (upper === 0 ? 1 : upper) * 10000;
      section = 0;
      hasUnit = true;
    } else if (ch in CJK_DIGITS) {
      // v7.1.0 修正（审查 #34）：无位权叠字按**十进制位权累加**。
      // 旧版直接覆盖 `section`，于是「一二」静默取末位得 2（手写「第十二章」会被当成第 2 章）、
      // 「一零」得 0 → 落在下方 `!hasUnit && section === 0` 的判空里变成解析不出。
      // 现在「一二」= 12、「一零」= 10、「一零二四」= 1024；有位权字时行为不变
      //（「一千零一」= 1001、「十二」= 12——零/位权交替时 section 归零后再累加，不会串位）。
      // 「零」单独一个仍返回 undefined（见下）：第 0 章不存在，明确判为解析不出，
      // 而不是悄悄多出一个「第零章」目录项。
      section = section * 10 + CJK_DIGITS[ch];
    } else {
      return void 0;
    }
  }
  if (!hasUnit && section === 0) return void 0;
  return total + section;
}
// v4.3.0：章号解析前的字符宽度归一——全角数字（０-９）与全角连字符类（－．／）映射成半角。
// 不用整串 NFKC：NFKC 会把标题里的「。」(U+3002) 一起归一成「.」，再被 cleanChapterTitle 的
// [_\-.]+ 换成空格，破坏标题外观（"初遇。重逢" → "初遇 重逢"）；这里只映射章号相关字符，1 字符换 1 字符，
// 索引与原文一一对应（bookNameFromFileName 依赖索引切片，故不能改长度）。
const CHAPTER_WIDTH_PAIRS = /[\uFF10-\uFF19\uFF0D\uFF0E\uFF0F]/g;
function normalizeChapterWidth(text) {
  return String(text).replace(CHAPTER_WIDTH_PAIRS, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}
export function parseChapterNumber(name) {
  // v4.3.0 修正：入口先做宽度归一——旧版「第０１章 初遇.md」解析不出章号（number=undefined），
  // 可与「第01章.md」并存成为同一章并绕过重号防护（nextFreeChapterFile / novel_summary 归一化键都会失守）
  // v8.2.0 修（#39）：只剥离章节扩展名（.md/.markdown/.txt，与 CHAPTER_EXTENSIONS / normalizeChapterKey 同口径），
  // 避免把 "v1.2 第03章" / "书名.第03章" 中的书名点号误当成扩展名截掉章号。
  const stem = normalizeChapterWidth(name).replace(/\.(md|markdown|txt)$/i, "");
  // v6.2.1 修正：\d{1,4} → \d+ 并加 (?!\d) 顶住数字后边界——旧写法在 5 位以上时引擎右移起点、
  // 用尾部 4 位完成匹配（静默错号）。超出 MAX_CHAPTER_NUMBER 一律判为解析不出，绝不截尾。
  // 无「第」前缀时下探起点仍须顶住数字前边界（(?<!\d)），否则「书12345章」会从第 2 位起匹配「2345章」。
  const arabicMark = new RegExp("第?(?<!\\d)(\\d+)(?!\\d)[" + CHAPTER_MARK_CHARS + "]").exec(stem);
  if (arabicMark) {
    const n = Number(arabicMark[1]);
    if (n >= 1 && n <= MAX_CHAPTER_NUMBER) return n;
    return void 0;
  }
  // v7.1.0 修正（审查 #35）：**带「第」的中文分支**必须排在分隔符分支之前。
  // 旧顺序让 `sepMark` 先跑：「1984-第一章.md」里的「1984-」被当成章号 → 解析成第 1984 章
  //（文件真实是第 1 章，排序/重号防护/摘要槽位全部错位）。「第N章」是特异性最高的写法，
  // 先认它没有歧义损失；纯分离符写法（斗破苍穹-01-陨落）仍由下方 sepMark 兜住。
  const cjkMark = new RegExp("第([" + CJK_NUMERAL_CHARS + "]+)[" + CHAPTER_MARK_CHARS + "]").exec(stem); // v4.0.0：补"千"；v6.2.1：字符类收敛为常量
  if (cjkMark) {
    const n = cjkToNumber(cjkMark[1]);
    if (n !== void 0 && n >= 1 && n <= MAX_CHAPTER_NUMBER) return n; // v6.2.1：一万以上同阿拉伯分支口径（解析不出）
    return void 0;
  }
  // v3.7.0 ②：书名-01-标题 的中段数字也是章号（斗破苍穹-01-陨落 → 1）
  const sepMark = /(?<!\d)(\d+)(?!\d)[-._\s]/.exec(stem);
  if (sepMark) {
    const n = Number(sepMark[1]);
    if (n >= 1 && n <= MAX_CHAPTER_NUMBER) return n;
    return void 0;
  }
  const leading = LEADING_NUMBER.exec(stem);
  if (leading) {
    const n = Number(leading[1]);
    if (n >= 1 && n <= MAX_CHAPTER_NUMBER) return n;
    return void 0;
  }
  // v4.0.0 修正：书名-01 / 书名 01 这类"末尾章号"（旧版要求数字两侧都有分隔符 → 解析失败）
  const trailing = /(?<!\d)(\d+)(?!\d)$/.exec(stem);
  if (trailing) {
    const n = Number(trailing[1]);
    if (n >= 1 && n <= MAX_CHAPTER_NUMBER) return n;
    return void 0;
  }
  return void 0;
}
export function normalizeChapterKey(c) {
  // v4.3.0 修正：先做宽度归一（「第０１章」→「第01章」）——否则全角章号归一化失败，
  // novel_summary 会把全角章与半角章当成两个不同的槽位（重号防护被绕过）
  // v7.1.0 修正（审查 #37）：扩展名剥除覆盖 **.md / .markdown / .txt**（与 CHAPTER_EXTENSIONS 同口径）。
  // 旧版只剥 .md：「番外.txt」的归一键留着扩展名，「番外.md」却归成「番外」——同一章按不同格式
  // 落盘时摘要/索引槽位对不上（novel_summary 会存出两个槽位，静默分叉）。
  const s = normalizeChapterWidth(c ?? "").trim().replace(/\.(md|markdown|txt)$/i, "").replace(/^#+\s*/, "");
  // v4.3.0 修正：字符类与 parseChapterNumber 对齐（补「千万」）。
  // 旧版缺「千」→「第一千零一章」会从「千」之后开始匹配，归一成「第01章」，
  // 与 parseChapterNumber=1001 冲突，导致 novel_summary 把第 1001 章摘要写进第 1 章（静默覆盖）。
  // v6.2.1 修正：字符类收敛为常量（与解析同一份），并加数字前边界——旧写法在「第10001章」上
  // 从第 2 位起匹配「0001章」→ 归一成「第01章」，与真正的第 1 章撞槽位（正是上一段注释要防的失效模式，只是换成 5 位触发）。
  const m = new RegExp("第?(?<!\\d)(\\d+)(?!\\d)[" + CHAPTER_MARK_CHARS + "]|第([" + CJK_NUMERAL_CHARS + "]+)[" + CHAPTER_MARK_CHARS + "]").exec(s);
  if (m) {
    const n = m[1] !== void 0 ? Number(m[1]) : cjkToNumber(m[2]);
    if (n !== void 0 && Number.isInteger(n) && n >= 1 && n <= MAX_CHAPTER_NUMBER) return "第" + String(n).padStart(2, "0") + "章";
    return s;
  }
  // v7.3.1 修（#5）：纯数字分支改用 `\d+` 并复用同一个上界判据——与 parseChapterNumber 统一口径。
  // 旧版写死 `\d{1,4}`：「00001」走 parse 得 1（LEADING_NUMBER 是 `\d+`），归一键却因位数不匹配原样返回
  // 「00001」，于是同一章在摘要/索引里落两个槽位（分叉即静默覆盖）。
  // 上界同步到 MAX_CHAPTER_NUMBER：「12345」这类超出上界的，parse 判解析不出，归一键也必须原样返回。
  const numericKey = function (digits) {
    const n = Number(digits);
    return n >= 1 && n <= MAX_CHAPTER_NUMBER ? "第" + String(n).padStart(2, "0") + "章" : void 0;
  };
  const m2 = s.match(/^(\d+)[-._\s]/);
  if (m2) return numericKey(m2[1]) ?? s;
  const m3 = s.match(/^(\d+)$/);
  if (m3) return numericKey(m3[1]) ?? s; // v3.7.0 ③：纯数字章号（2/02）也归一
  return s;
}
function cleanChapterTitle(stem) {
  // v4.3.0 修正：宽度归一（「第０１章 初遇」→「第01章 初遇」），全角章号不再混进标题
  // v6.2.1 修正：两处字符类与解析/归一收敛到同一份常量（章/回/话/节）——旧版阿拉伯与中文分支都缺「节」，
  // 于是「第01节.md」解析出章号 1、标题却只剩一个「节」字（同一文件两套口径）。
  return normalizeChapterWidth(stem)
    .replace(new RegExp("第?\\d+(?!\\d)[" + CHAPTER_MARK_CHARS + "]", "g"), "")
    .replace(new RegExp("第[" + CJK_NUMERAL_CHARS + "]+[" + CHAPTER_MARK_CHARS + "]", "g"), "") // v4.3.0：补「千万」，与章号解析口径一致
    .replace(LEADING_NUMBER, "")
    .replace(/[_\-.]+/g, " ")
    .trim();
}
/**
 * v5.0.0 修正：从正文一级标题里取章节标题。
 *
 * 背景：`novel_new_chapter` 过去把 title 写进 Markdown 一级标题，文件名却固定是「第07章.md」；
 * 而章节标题一直只从**文件名**派生（cleanChapterTitle），于是用 title 建的章在 novel_chapters
 * 清单里显示成空标题（`第07章  —`）。这里做一次回退：文件名没有标题时读正文标题。
 * 只作为回退用——文件名有标题时一律以文件名为准（用户改文件名比改正文更直观）。
 * 一级标题若只是章号本身（「# 第07章」）则返回空串，不把章号当标题重复显示。
 */
function firstHeadingTitle(text) {
  const m = String(text ?? "").replace(/\r\n?/g, "\n").match(/^[ \t]*#{1,6}[ \t]*([^\n]+)/m);
  if (!m) return "";
  const heading = normalizeChapterWidth(m[1]).replace(/\s+/g, " ").trim();
  return cleanChapterTitle(heading).slice(0, 60);
}
export const CJK_STOP_CHARS = new Set(
  "的了是在有和就都而于及与或这那之其以被把让向着过也还又但更最很从对为等啊吧呢吗嗯哦呀哈啦么个中上下前后左右来去出进到说想看要会能可没有不".split("")
);
const EN_STOP_WORDS = new Set(
  "the and of to in a an is are was were be been being it its this that these those i you he she they we my your his her their our me him them us as at by for with on from or but not no so if then than when where which who whom what how why all any both each few more most other some such only own same too very just can could will would shall should may might must do does did done have has had having about into over under again further once here there".split(/\s+/)
);

// v7.3.2 修（N24③）：同名目录的 silent_skip 事件**同进程内同一路径只记一次**。该事件描述的是一条
// 结构性事实（名字像章节文件但不是文件），每次 scanChapters 都会看到同一个目录；不节流时一次开书/
// 审计/开写包就刷一串一模一样的记录（受日志轮转上限约束，噪音有界，但全是重复信息）。
// 为什么不会因此漏掉真故障：① 这里既不是 IO 失败也不是瞬时故障——目录在就一直会在，重复上报不增加
// 任何线索；② 权限/IO 导致的**读不动**由 scanChapters 的 readdir 失败抛出、由各调用方报错，不走这条；
// ③ 键是完整路径，新增/改名的目录照常各记一次，去重不会让这类问题整体失声（目录被修好后又坏掉，
// 本进程内那一条会少记一次，但仍可在 novel_diagnose 的历史日志里看到首次记录，且章表缺章本身可见）。
const loggedChapterDirs = new Set();
export async function scanChapters(bookPath) {
  let entries;
  try {
    entries = await readdir(bookPath, { withFileTypes: true });
  } catch (e) {
    // v3.9.0：缺失书目录不再抛裸 ENOENT——友好报错（各工具行为统一）
    throw new Error("书库中未找到作品目录：" + bookPath + "（检查书名是否精确匹配——可用 novel_books 查看全部作品名；或确认 novels/ 下已创建该书目录）", { cause: e });
  }
  const chapters = [];
  for (const entry of entries) {
    const ext = extname(entry.name).toLowerCase();
    if (!entry.isFile()) {
      // v7.3.1 修（#11）：目录名看起来像章节文件（带章扩展名）时不能只是 continue ——
      // 那样「读不到」会被讲成「没有」：该章从章表里静静消失，用户还以为章丢了。
      // 记一条 silent_skip，至少让 novel_diagnose 能看到「这个文件其实在，只是不是文件」。
      if (CHAPTER_EXTENSIONS.has(ext)) {
        const full = join(bookPath, entry.name);
        if (!loggedChapterDirs.has(full)) {
          loggedChapterDirs.add(full);
          logEvent("silent_skip", { file: full, level: "warn", detail: "章节目录被跳过：名字像章节文件但不是文件（该章不会出现在章表里）" });
        }
      }
      continue;
    }
    if (!CHAPTER_EXTENSIONS.has(ext)) continue;
    chapters.push({
      file: entry.name,
      number: parseChapterNumber(entry.name),
      title: cleanChapterTitle(entry.name.slice(0, -ext.length)) || "" // v3.6.0：无标题章节返回空串（不把文件名当标题）
    });
  }
  chapters.sort((a, b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) || a.file.localeCompare(b.file));
  return chapters;
}
export async function readTextFile(filePath, exec) {
  const buf = await readFile(filePath, { signal: exec?.signal });
  return decodeTextBuffer(buf, filePath);
}
// v4.3.0：无 BOM UTF-16 探测用的两个判定。
// ① 高字节结构：UTF-16 码元的高字节决定大致区块——0x00 ASCII/拉丁、0x4E-0x9F CJK 统一表意、
//    0x30-0x33 CJK 标点与假名、0xFF 全角形式、0xD8-0xDF 代理对……（LE 的高字节在奇数下标，BE 在偶数）
function isTextHighByte(b) {
  return b === 0x00 || (b >= 0x01 && b <= 0x06) || (b >= 0x0e && b <= 0x33) || (b >= 0x4e && b <= 0x9f) || (b >= 0xd8 && b <= 0xdf) || b >= 0xfe;
}
// ② 试解后可打印率：GBK 字节被误读成 UTF-16 时典型落点是谚文/彝文/私用区，
//    这里只认真正的文本区（CJK/ASCII/常见标点/全角形式），用来把"结构像"和"内容像"同时卡住
function isPlausibleTextCode(cp) {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return true;
  if (cp >= 0x20 && cp <= 0x7e) return true; // ASCII 可打印
  if (cp >= 0x00a0 && cp <= 0x024f) return true; // 拉丁扩展
  if (cp >= 0x0370 && cp <= 0x04ff) return true; // 希腊/西里尔
  if (cp >= 0x2010 && cp <= 0x206f) return true; // 通用标点
  if (cp >= 0x20a0 && cp <= 0x20bf) return true; // 货币符号
  if (cp >= 0x2190 && cp <= 0x21ff) return true; // 箭头
  if (cp >= 0x2460 && cp <= 0x27bf) return true; // 带圈字符/框线/装饰符号
  if (cp >= 0x3000 && cp <= 0x303f) return true; // CJK 标点
  if (cp >= 0x3040 && cp <= 0x30ff) return true; // 平假名/片假名
  if (cp >= 0x3105 && cp <= 0x312f) return true; // 注音符号
  if (cp >= 0x3400 && cp <= 0x4dbf) return true; // CJK 扩展 A
  if (cp >= 0x4e00 && cp <= 0x9fff) return true; // CJK 统一表意
  if (cp >= 0xd800 && cp <= 0xdfff) return true; // 代理对（emoji 等）
  if (cp >= 0xf900 && cp <= 0xfaff) return true; // CJK 兼容表意
  if (cp >= 0xfe30 && cp <= 0xfe4f) return true; // CJK 兼容形式
  return cp >= 0xff00 && cp <= 0xffef; // 全角/半角形式
}
// v4.3.0：按某字节序试解，返回 { coherent 高字节结构占比, plausible 可打印率 }
function scoreUtf16(buf, le) {
  const units = buf.length >> 1;
  let coherent = 0;
  let plausible = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const high = le ? buf[i + 1] : buf[i];
    const low = le ? buf[i] : buf[i + 1];
    if (isTextHighByte(high)) coherent += 1;
    if (isPlausibleTextCode(high * 256 + low)) plausible += 1;
  }
  return { coherent: coherent / units, plausible: plausible / units };
}
// v6.2.1：UTF-16 判据实测值的容器——严格 UTF-8「试解成功但内容不像文本」时要复用同一份测量，
// 故提到 try 之外（旧版整段判据都在 catch 之后的 3b，只有"严格 UTF-8 失败"才走得到）。
let utf16Score = null;
function utf16ScoreOf(buf) {
  // v6.2.1：进入门槛由 8 字节放宽到 4 字节（2 个 UTF-16 码元）——"世界。"这类 6 字节短文件
  // 旧门槛直接测不了，只能走"严格 UTF-8 恰巧成功"的静默错值路径。
  if (utf16Score === null && buf.length >= 4 && buf.length % 2 === 0) {
    const le = scoreUtf16(buf, true);
    const be = scoreUtf16(buf, false);
    const leWins = le.coherent + le.plausible >= be.coherent + be.plausible;
    const best = leWins ? { encoding: "utf-16le", score: le } : { encoding: "utf-16be", score: be };
    const other = leWins ? be : le;
    utf16Score = { best, other };
  }
  return utf16Score;
}
// 解出的文本里 C0 控制字符（除 tab/LF/CR）的占比。UTF-16 字节被当 UTF-8 收下时，
// 汉字/标点的低字节（0x00~0x1F 段）会解成一堆控制字符——这是"碰巧是合法 UTF-8"的典型指纹。
function controlRatio(text) {
  if (text.length === 0) return 0;
  let ctrl = 0;
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) ctrl += 1;
  }
  return ctrl / text.length;
}
export function decodeTextBuffer(buf, filePath) {
  utf16Score = null; // 每次调用重新测量（模块级只是"同一次调用内复用"，跨文件不得串味）
  // 1) BOM 检测
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8"); // UTF-8 BOM
  }
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le"); // UTF-16 LE BOM
    if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2)); // UTF-16 BE BOM
  }
  // 2) 无 BOM：先做 NUL 分布启发式——纯 ASCII 的 UTF-16 LE/BE 每两个字节含一个 0x00，
  //    若先走严格 UTF-8 会被静默收下（NUL 是合法 UTF-8），永远到不了启发式分支（v3.9.5 修正顺序）
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0) {
      if (i % 2 === 0) evenNul += 1;
      else oddNul += 1;
    }
  }
  const nulRatio = (evenNul + oddNul) / Math.max(buf.length, 1);
  if (nulRatio > 0.05) {
    // UTF-16LE 的 NUL 在奇数下标（41 00），BE 在偶数（00 41）
    return oddNul >= evenNul
      ? new TextDecoder("utf-16le").decode(buf)
      : new TextDecoder("utf-16be").decode(buf);
  }
  // 3) 无 BOM 且无 UTF-16 信号：严格按 UTF-8 解码
  let strict = null;
  try {
    strict = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    /* 非 UTF-8，继续尝试 */
  }
  // 3a) v6.2.1 修正：无 BOM 的 UTF-16（每字节都 < 0x80 时）**整串就是合法 UTF-8**——
  //     "你好世界" 的 UTF-16LE 字节解成 "0A4F60594E4E1675" 之类的控制字符乱码，严格 UTF-8 直接成功返回，
  //     永远到不了下面的 UTF-16 判据（静默读坏，无任何报错）。这里对"解出来控制字符超标"的候选做内容合理性判定：
  //     只有 UTF-16 判据满足结构与可打印阈值才改判，纯 ASCII/GBK 文本不受影响（控制字符占比极低）。
  //     结构阈值取 0.8 而非 3b 的 0.9：极短文本（如仅「世界。」2 个码元）的高字节样本太少，
  //     用 0.9 会漏判（实测 leCoherent=0.875），而 0.8 + 可打印 0.9 对 GBK/UTF-8 误读仍不会成立。
  if (strict !== null && controlRatio(strict) >= 0.05) {
    const scored = utf16ScoreOf(buf);
    if (scored && scored.best.score.coherent >= 0.8 && scored.best.score.plausible >= 0.9) {
      return new TextDecoder(scored.best.encoding).decode(buf);
    }
  }
  if (strict !== null) return strict;
  // 3b) v4.3.0 新增：中文正文的 UTF-16（尤其 LE）NUL 占比只有约 1.5%，过不了上面 5% 的阈值，
  //     旧版会一路落到 GBK 分支——要么解出乱码静默返回，要么把合法 UTF-16 报成"不是有效的 UTF-16"。
  //     这里用"高字节结构 + 试解可打印率"双阈值判定，且要求另一字节序明显不成立（避免 GBK 误判）
  let utf16Suspected = false;
  const scored = utf16ScoreOf(buf);
  if (scored) {
    if (scored.best.score.coherent >= 0.9 && scored.best.score.plausible >= 0.9 && scored.other.coherent < 0.9) {
      return new TextDecoder(scored.best.encoding).decode(buf);
    }
    // 结构像 UTF-16 但可打印率不够：只作为报错文案的线索（不当成结论，避免误吞 GBK 文件）
    utf16Suspected = scored.best.score.coherent >= 0.9 && scored.best.score.plausible >= 0.6;
  }
  // 4) 中文 Windows 常见的 GBK/GB18030（TextDecoder 原生支持 gbk）
  const gbk = new TextDecoder("gbk").decode(buf);
  if (!gbk.includes("\uFFFD")) return gbk;
  // v4.3.0：区分"可能是缺 BOM 的 UTF-16"与"真正无法识别"——旧文案把合法 UTF-16 也一并说成"不是有效的 UTF-16"
  const hint = utf16Suspected
    ? "；该文件的高位字节分布像 UTF-16，可能是缺 BOM 的 UTF-16LE/BE——请另存为 UTF-8（UTF-16 请带 BOM）"
    : "，也不像带 BOM 或缺 BOM 的 UTF-16";
  throw new Error(`cannot detect text encoding of "${filePath}": 不是有效的 UTF-8/GBK${hint}，请将文件另存为 UTF-8 编码`);
}
export function countTextLines(text) {
  // v4.3.0 新增：行数口径的唯一出口——空文件（含仅 BOM 已剥离后的空串）= 0 行。
  // 起因：chapterStats 给 0 行而 novel_read（index.js）用 text.split(/\r?\n/).length 给 1 行（split 至少返回 [""]），
  // 同一章在两处显示不同行数。index.js 侧建议改用本函数（见报告"需父代理裁决"）。
  return text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
}
export async function chapterStats(bookPath, chapter, exec) {
  const info = await stat(join(bookPath, chapter.file));
  // v4.0.0 修正：转发 exec.signal——宿主契约要求异步工作可取消；此前 novel_books/novel_chapters 读全书无法中断
  const text = await readTextFile(join(bookPath, chapter.file), exec);
  return {
    chars: text.length,
    lines: countTextLines(text), // v4.3.0：口径统一（空文件 0 行），不再内联三元表达式
    size: info.size,
    updated: info.mtime.toISOString(),
    // v5.0.0 修正：正文一级标题（可为空串）。novel_chapters 在"文件名没有标题"时回退用它，
    // 否则用 novel_new_chapter title 建的章在清单里标题为空。正文已读在这里，零额外 IO。
    heading: firstHeadingTitle(text)
  };
}
export function findChapter(chapters, chapterArg) {
  const needle = String(chapterArg).trim();
  const lower = needle.toLowerCase();
  // v4.3.1 修正（P0）：精确文件名（含省略扩展名的文件名）**优先于**章号解析。
  // 旧版把章号匹配放在最前，于是「第03章 重逢.md」这种完整文件名也会被 parseChapterNumber 解析出章号 3，
  // 命中同章的另一个文件；被抢走的那一份用章号/文件名/标题三条路都读不到（永久不可达，实测复现）。
  const exactFile = chapters.find((c) => c.file.toLowerCase() === lower);
  if (exactFile) return exactFile;
  const hasExtension = /\.(md|markdown|txt)$/i.test(lower);
  if (hasExtension) return void 0;
  const byStem = chapters.filter((c) => c.file.toLowerCase().replace(/\.[^.]+$/, "") === lower);
  if (byStem.length > 1) {
    throw new Error("章节文件名「" + needle + "」对应多份文件：" + byStem.map((c) => c.file).join("、") + "。请指定包含扩展名的完整文件名。");
  }
  if (byStem.length === 1) return byStem[0];
  const asNumber = parseChapterNumber(needle);
  if (asNumber !== void 0) {
    const matched = chapters.filter((c) => c.number === asNumber);
    // v4.3.1 修正（P0）：同章号多文件不再"静默取排序后的第一个"——那会让另一份永远读不到。
    // 改为拒绝并列出候选；候选文件名可直接回传给 chapter 参数（文件名匹配已在上方优先）。
    if (matched.length > 1) {
      throw new Error(
        `第 ${asNumber} 章有 ${matched.length} 个文件，无法确定要哪一份：` +
        matched.map((c) => c.file).join("、") +
        `。请把 chapter 参数写成其中一个文件名（同名不同扩展名时需保留扩展名）来指定；` +
        `或用 novel_continuity_check 查看同章号清单后改名。`
      );
    }
    if (matched.length === 1) return matched[0];
  }
  // v4.0.0 修正：纯数字参数必须"章号完全相等"，否则 findChapter("1") 会子串命中第 10/11/12 章
  // v4.3.0 修正：这里原有一段 `chapters.find(c => String(c.number) === needle)` 的"精确查找"，
  // 恒为无效代码——走到此处说明没有任何章号的数值等于 asNumber，而 c.number 是 parseChapterNumber 产出的
  // Number，String(c.number) === needle 只可能对 needle="01" 之类成立，此时数值必然等于 asNumber（早退命中）。
  // 故删除该死查找；但 `return void 0` 必须保留（它是"纯数字不下探子串兜底"的承重守卫，
  // 删掉后 findChapter("1") 会经 byTitle 命中 "第11章.md"）。宽度归一是为了全角参数（"０１"）同口径。
  if (/^\d+$/.test(normalizeChapterWidth(needle))) return void 0;
  const byTitle = chapters.find((c) => c.title.toLowerCase().includes(lower) || c.file.toLowerCase().includes(lower));
  if (byTitle) return byTitle;
  return void 0;
}
export function extractKeywords(text, top) {
  const cjkBigrams = new Map();
  const cjkTrigrams = new Map();
  const enWords = new Map();
  const nameCandidates = new Map();
  const cjkRun = [];
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjkRun.push(ch);
    else if (cjkRun.length > 0) {
      tallyCjkRun(cjkRun, cjkBigrams, cjkTrigrams);
      cjkRun.length = 0;
    }
  }
  if (cjkRun.length > 0) tallyCjkRun(cjkRun, cjkBigrams, cjkTrigrams);
  for (const match of text.toLowerCase().matchAll(/[a-z]{2,}/g)) {
    const word = match[0];
    if (!EN_STOP_WORDS.has(word)) enWords.set(word, (enWords.get(word) ?? 0) + 1);
  }
  // 疑似人名/专名：2~3 字 + 动作/称谓（"露西亚说着""琉璃小姐"）
  // v4.0.0 修正：量词改懒惰——贪婪会把"琉璃说道"吃成"琉璃说"（动词尾巴污染人名候选）
  const namePatterns = [
    /([\u4e00-\u9fff]{2,3}?)(?:说|道|问|喊|叫|想|笑|叹|答|喝|骂|念|哭|点头|摇头)/g,
    /([\u4e00-\u9fff]{2,3}?)(?:小姐|大人|先生|少爷|姑娘|殿下|老师|导师|婆婆|爷爷|奶奶|夫人|老爷|公子|长老|神甫|陛下)/g
  ];
  for (const pattern of namePatterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      // v3.5.0 #23：伪人名过滤——代词/功能词开头的（"他说/她又/我问道/摇头"）不是名字
      if (/^[他她我你它又再还这那谁]./.test(name)) continue;
      if (name === "那个" || name === "这个" || name === "什么" || name === "怎么" || name === "自己" || name === "她们" || name === "他们" || name === "你们") continue;
      nameCandidates.set(name, (nameCandidates.get(name) ?? 0) + 1);
    }
  }
  const byWord = new Map();
  const addKw = (word, count, kind) => {
    const prev = byWord.get(word);
    if (!prev) {
      byWord.set(word, { word, count, kind });
      return;
    }
    if (count > prev.count) prev.count = count;
    if (kind === "name-candidate") prev.kind = "name-candidate";
  };
  for (const [word, count] of cjkBigrams) {
    if (count > 1) addKw(word, count, "cjk-bigram");
  }
  for (const [word, count] of cjkTrigrams) {
    if (count > 1) addKw(word, count, "cjk-trigram");
  }
  for (const [word, count] of nameCandidates) {
    if (count >= 2) addKw(word, count, "name-candidate");
  }
  for (const [word, count] of enWords) {
    if (count > 1) addKw(word, count, "word");
  }
  const keywords = [...byWord.values()];
  keywords.sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
  return keywords.slice(0, top);
}
function tallyCjkRun(run, cjkBigrams, cjkTrigrams) {
  for (let i = 0; i < run.length; i += 1) {
    if (i + 1 < run.length) {
      const bigram = run[i] + run[i + 1];
      const meaningful = !CJK_STOP_CHARS.has(run[i]) && !CJK_STOP_CHARS.has(run[i + 1]);
      if (meaningful) cjkBigrams.set(bigram, (cjkBigrams.get(bigram) ?? 0) + 1);
    }
    if (i + 2 < run.length) {
      const trigram = run[i] + run[i + 1] + run[i + 2];
      const nonStop = [run[i], run[i + 1], run[i + 2]].filter((ch) => !CJK_STOP_CHARS.has(ch)).length;
      if (nonStop >= 2) cjkTrigrams.set(trigram, (cjkTrigrams.get(trigram) ?? 0) + 1);
    }
  }
}
const IMPORT_NOISE = new Set(["原稿件", "单章", "调教计划", "未命名", "新建文档", "草稿", "无题", "正文", "手稿"]);
function numberToCjk(n) {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (!Number.isInteger(n) || n <= 0 || n >= 10000) return null;
  if (n < 10) return digits[n];
  // v3.9.5 修正：完整支持 10~9999（旧实现只支持 <100，却只在 ≥10000 返回 null，100~9999 会拼出 “undefined十”）
  let out = "";
  const q1000 = Math.floor(n / 1000);
  if (q1000 > 0) {
    out += digits[q1000] + "千";
    n %= 1000;
    if (n === 0) return out;
    if (n < 100) out += "零";
  }
  const q100 = Math.floor(n / 100);
  if (q100 > 0) {
    out += digits[q100] + "百";
    n %= 100;
    if (n === 0) return out;
    if (n < 10) out += "零";
  }
  const q10 = Math.floor(n / 10);
  if (q10 > 0) {
    out += (out === "" && q10 === 1 ? "" : digits[q10]) + "十";
    n %= 10;
  }
  if (n > 0) out += digits[n];
  return out;
}
export function nextFreeChapterFile(destDir, fileName) {
  const extMatch = /\.(md|markdown|txt)$/i.exec(fileName);
  const ext = extMatch ? extMatch[0] : (/\.[a-z][a-z0-9]{0,9}$/i.test(fileName) ? extname(fileName) : "");
  const stem = ext !== "" ? fileName.slice(0, -ext.length) : fileName;
  const stemN = normalizeChapterWidth(stem);
  const baseNum = parseChapterNumber(fileName);
  // v3.9.0 复查修正：同名或同章号（异形）占用都触发改名
  const numOccupied = function (num) {
    try {
      for (const ex of readdirSync(destDir)) {
        if (parseChapterNumber(ex) === num) return true;
      }
    } catch { /* 目录不可读按同名处理 */ }
    return false;
  };
  if (baseNum === void 0) {
    // v6.3.0：章号超出支持上界（≥10000）时不再"改名避让"——旧版会走本兜底加 `-2` 后缀，
    // 而 parseChapterNumber 认不出 5 位章号，新文件名仍解析不出章号，重号防护（numOccupied）与
    // novel_summary 的归一键同时失守（同一章可以有第二份文件）。宁可显式报错，让调用方改章号或分批。
    if (/(?:^|第)\d{5,}(?=[章回话节])/.test(stemN)) {
      throw new Error("章号超出支持范围（最大 " + MAX_CHAPTER_NUMBER + "）：「" + fileName + "」无法解析出章号——请改用 4 位以内章号（如 第1000章），或把 10000 章以上的书拆分成多本。");
    }
    if (!existsSync(join(destDir, fileName))) return fileName;
    let k = 2;
    while (existsSync(join(destDir, stem + "-" + k + ext))) k += 1;
    return stem + "-" + k + ext;
  }
  if (!existsSync(join(destDir, fileName)) && !numOccupied(baseNum)) return fileName;
  // 扫描目录内全部已占用章号（第01章/第1章/第一章/01-标题 都算同一章）
  const used = new Set();
  try {
    for (const existing of readdirSync(destDir)) {
      const n = parseChapterNumber(existing);
      if (n !== void 0) used.add(n);
    }
  } catch { /* 目录不可读时按文件名探测 */ }
  let next = baseNum + 1;
  while (used.has(next)) next += 1;
  // v7.3.1 修（#6）：章号递增必须止于 MAX_CHAPTER_NUMBER。
  // 旧版这一句与下面每条候选循环都只加不校验，章号占满 9999 后会产出「第10000章」——影响**不是"重号"**，
  // 而是产出 parseChapterNumber 认不出的**孤章**：该文件从章表消失、重号防护看不见它、摘要归一键也对不上
  //（等于凭空多出一个谁都读不到的章）。这里选择**显式报错**而不是降级：降级只有两条路
  //（沿用 5 位章号 / 退回 `-2` 后缀），两条都同样产出孤章；报错至少让调用方（导入路径）看到真因
  //「章号已用尽，请拆书或改用分卷」。
  // v7.3.2 修（N8）：旧注释声称这里覆盖「novel_new_chapter / 导入」——**不实**。本函数只在导入路径被
  // 调用（index.js 的 novel_import 改名分支，全仓仅那两处），建章工具 novel_new_chapter 的
  // 自动章号走自己的 maxNumber+1、从不经过这里；它的上界校验由该工具自身负责（见 index.js 对应注释）。
  const assertBumpInRange = function (bump) {
    if (bump <= MAX_CHAPTER_NUMBER) return;
    throw new Error("章号已用尽：自动分配需要第 " + bump + " 章，超出支持上限 " + MAX_CHAPTER_NUMBER +
      "——请把 10000 章以上的书拆分成多本，或把本章改成 4 位以内章号（第1~9999章）。");
  };
  assertBumpInRange(next);
  // 按原文件名格式生成空闲章号（保持补零宽度；对全角数字/分隔符统一在 stemN 上匹配）
  const mArab = new RegExp("^(.*?第)(\\d+)([" + CHAPTER_MARK_CHARS + "].*)$").exec(stemN);
  if (mArab) {
    const width = mArab[2].length;
    let bump = next;
    let candidate = mArab[1] + String(bump).padStart(width, "0") + mArab[3] + ext;
    while (existsSync(join(destDir, candidate))) { bump += 1; assertBumpInRange(bump); candidate = mArab[1] + String(bump).padStart(width, "0") + mArab[3] + ext; }
    return candidate;
  }
  const mCjk = new RegExp("^(.*?第)([" + CJK_NUMERAL_CHARS + "]+)([" + CHAPTER_MARK_CHARS + "].*)$").exec(stemN);
  if (mCjk) {
    // v6.2.1 修正：删除「候选名」与「退出条件」耦合的旧循环——bump 越过 9999 时 numberToCjk 返回 null → break，
    // 此时 candidate 里存的是**上一轮算出的、可能已存在的**文件名（existsSync 为真才会进下一轮），
    // break 后 if (candidate) 成立 → 返回磁盘上已占用的路径，调用方落盘即覆盖旧章。
    // 现在每轮只在确认文件名空闲时才赋值 candidate，break 时 candidate 保持 null（走后面的兜底分支）。
    let bump = next;
    let candidate = null;
    while (candidate === null) {
      const cjk = numberToCjk(bump);
      if (cjk === null) break; // bump ≥ 10000：数字转中文章号表达不了，交给下方兜底分支
      const name = mCjk[1] + cjk + mCjk[3] + ext;
      if (!existsSync(join(destDir, name))) candidate = name;
      bump += 1;
    }
    if (candidate !== null) return candidate;
  }
  const mLead = /^(\d+)([-._\s—].*)$/.exec(stemN);
  if (mLead) {
    const width = mLead[1].length;
    let bump = next;
    let candidate = String(bump).padStart(width, "0") + mLead[2] + ext;
    while (existsSync(join(destDir, candidate))) { bump += 1; assertBumpInRange(bump); candidate = String(bump).padStart(width, "0") + mLead[2] + ext; }
    return candidate;
  }
  const mMid = /^(.*?[-._\s—])(\d{1,4})([-._\s—].*)$/.exec(stemN);
  if (mMid) {
    const width = mMid[2].length;
    let bump = next;
    let candidate = mMid[1] + String(bump).padStart(width, "0") + mMid[3] + ext;
    while (existsSync(join(destDir, candidate))) { bump += 1; assertBumpInRange(bump); candidate = mMid[1] + String(bump).padStart(width, "0") + mMid[3] + ext; }
    return candidate;
  }
  // v3.9.5 修正：可解析章号但格式未被识别（如空格分隔的 “01 标题.md”，或中文章号 >99 时 mCjk 生成失败）——
  // 不再用 “-k 后缀” 兜底（那样 parseChapterNumber 仍解析回原章号，产生同号重复），改为显式换成下一空闲章号
  // v4.0.0 修正：函数开头 baseNum === void 0 已提前 return，此处 baseNum 必然已定义——
  // 去掉恒真的 if 包裹与不可达的 “-k 兜底”（旧代码自相矛盾，误导维护者以为兜底仍生效）
  let bump = next;
  let candidate = "";
  do {
    assertBumpInRange(bump); // v7.3.1 修（#6）：兜底分支的递增同样不得越过上界
    candidate = "第" + String(bump).padStart(2, "0") + "章" + (stem.trim() ? " " + stem.trim() : "") + ext;
    bump += 1;
  } while (existsSync(join(destDir, candidate)));
  return candidate;
}
export function bookNameFromFileName(fileName) {
  const stem = fileName.replace(/\.[^.]+$/, "");
  // v3.6.0：文件名启发式只取章号前的书名前缀（"斗破苍穹 第1章 陨落.md" → "斗破苍穹"，不再把本章标题拼进书名）
  // v3.7.0 ②：数字+分隔符也算章号（斗破苍穹-01-陨落.md → 斗破苍穹；01-初遇.md 仍归未分类）
  // v4.3.0 修正：章号标记必须有 章/回/话/节，或数字两侧是明确边界——旧版把 [章回话节] 写成可选，
  // 「三 体.md」在 index 0 就被命中（中文数字"三" + 空格）→ head 截成空串 → 书名被判为 undefined 整本丢失。
  // 宽度归一只用于匹配（1 字符换 1 字符，索引一一对应），书名仍按原 stem 切分，不改写书名里的全角字符。
  const stemN = normalizeChapterWidth(stem);
  // v6.2.1 修正：四处字符类全部改用常量（章/回/话/节），与 parseChapterNumber 同一份口径——
  // 旧版这里认「节」而解析侧不认，「第1节 初遇.md」会被当成书名「初遇」并建出一本叫「初遇」的书。
  const chapterMark = stemN.match(new RegExp("第?\\d+(?!\\d)[" + CHAPTER_MARK_CHARS + "]|第[" + CJK_NUMERAL_CHARS + "]+[" + CHAPTER_MARK_CHARS + "]|(?:^|[\\s._\\-—~])\\d+(?!\\d)(?=[\\s._\\-—~]|$)"));
  const head = chapterMark ? stem.slice(0, chapterMark.index).trim() : stem;
  const parts = head
    .replace(LEADING_NUMBER, " ")
    .split(/[\s._\-—~]+/)
    .map((p) => p.trim())
    .filter((p) => p !== "" && !IMPORT_NOISE.has(p));
  const name = parts.join(" ").trim();
  // v3.5.0 #31：文件名以章号开头（"第1章 初遇.md"）且无书名前缀 → 不当作书名（归未分类）
  // v3.5.0 #31：章号开头 = "第N章"、"第N回"、纯数字前缀（01-初遇 / 1_初遇 / 001.初遇）
  // v7.1.0 修正（审查 #64）：删掉右侧恒假的 `(startsWithChapter && parts.length <= 2)`。
  // 可达性分析（写死在这里，防止以后有人"补回"这个条件）：
  //   startsWithChapter 的三个分支（^\d+章 / ^第[中文]+章 / ^\d+ 后跟分隔符）都能被上方 chapterMark
  //   在 index 0 命中（chapterMark 的第三支正好允许 ^ 作为前置边界）→ head 截成空串 → parts 为空 →
  //   name === ""。也就是说走到本行时：要么 name === ""（左支已处理），要么 startsWithChapter 必为 false，
  //   右支 100% 不可达。旧变量 startsWithChapter 随条件一并删除，避免留下新的死变量。
  return name === "" ? void 0 : name;
}
export function bookNameFromContent(text) {
  const lines = String(text).split(/\r?\n/).slice(0, 12);
  for (const raw of lines) {
    const line = raw.replace(/^#+\s*/, "").replace(/^\uFEFF/, "").trim();
    if (line === "") continue;
    if (IMPORT_NOISE.has(line)) continue;
    // v3.5.0 M9b：《书名》提取在前（《斗破苍穹》第一章 陨落 同行也能识别书名）——先看有没有《》包裹
    const bookMatch = line.match(/[《〈]\s*([^》〉]{2,30}?)\s*[》〉]/);
    if (bookMatch) {
      const name = bookMatch[1].trim();
      if (name.length >= 2 && name.length <= 30) return name;
      continue;
    }
  }
  return void 0;
}
export async function collectTextFiles(dir, recursive, out = [], prefix = "") {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // v6.6.0：读不动目录 → 只返回**已收集的部分**清单，调用方会以为"就这些文件"。
    // ENOENT 不记（空目录/首次使用是常态）；调用方（novel_import）已先 stat 过 src，
    // 递归也只进入刚列出的子目录，所以能走到这里的基本是真故障（EACCES/EIO/EMFILE）。
    logEvent("silent_skip", { path: dir, detail: "目录读取失败：只返回已收集的部分文件清单（结果不完整）" });
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : prefix + "/" + entry.name;
    if (entry.isDirectory()) {
      if (recursive) await collectTextFiles(join(dir, entry.name), recursive, out, rel);
    } else if (entry.isFile() && CHAPTER_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      out.push(rel);
    }
  }
  return out;
}
/**
 * v7.1.0 修正（审查 #38）：把宿主机绝对路径压成**模型可见的安全写法**。
 *
 * 为什么必须脱敏：导入回执的 `<path>` 节点会把作者本机的绝对路径（`C:\Users\…`、`/home/…`）
 * 原样送进大模型上下文——既泄露目录结构，又换一台机器就毫无意义。
 *
 * 规则：相对书库根；以下情况一律降级成 basename（只留最后一段）——
 *   · 拿不到书库根（render 回调里解析不出来）
 *   · 目标就在书库根上（relative 得 ""）
 *   · 跨盘符 / 跨根（relative 返回的仍是绝对路径）
 *   · 相对结果带 `..`（目标在书库根外，相对路径同样会泄露上级目录）
 * basename 用同时认 `/` 与 `\` 的实现（split），这样在 Linux 上拿到 Windows 形态路径也不会整串吐出。
 */
function displayPath(target, root) {
  const raw = String(target ?? "");
  if (raw === "") return "";
  const base = (() => {
    const segs = raw.split(/[\\/]+/).filter((x) => x !== "");
    return segs.length > 0 ? segs[segs.length - 1] : "";
  })();
  if (typeof root !== "string" || root.trim() === "") return base;
  let rel = "";
  try {
    rel = relative(root, raw);
  } catch {
    return base;
  }
  if (rel === "" || isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return base;
  return rel.replace(/\\/g, "/");
}
export function formatImport(value, root) {
  const lines = [`<path>${displayPath(value.src, root)}</path>`, `<type>novel-import-${value.mode}</type>`, "<content>", ""];
  lines.push(`扫描结果：${value.groups.reduce((n, g) => n + g.files.length, 0)} 个文件 → ${value.groups.length} 组` +
    (value.skipped.length > 0 ? `（跳过 ${value.skipped.length} 个文件：无法读取或未分类）` : ""));
  for (const group of value.groups) {
    const from = group.from === "file" ? "文件名" : group.from === "content" ? "文件头内容" : group.from === "unclassified" ? "未分类" : "强制指定";
    const maybeHint = Array.isArray(group.maybe) && group.maybe.length > 0
      ? ` [可能同书：${group.maybe.join(" / ")}]`
      : "";
    lines.push("");
    lines.push(`[${group.book}] (来自${from}, ${group.files.length} 个文件)${maybeHint}`);
    for (const f of group.files) {
      const ch = f.chapter === void 0 ? "?" : `第${f.chapter}章`;
      const candHint = typeof f.bookNameCandidate === "string" && f.bookNameCandidate.trim() !== ""
        ? `（候选书名：${f.bookNameCandidate.trim()}）`
        : "";
      lines.push(`  - ${ch} ${f.file}${candHint}`);
    }
  }
  if (value.skipped.length > 0) {
    lines.push("", "跳过：");
    for (const item of value.skipped) lines.push(`  - ${item}`);
  }
  if (value.imported.length > 0) {
    lines.push("");
    lines.push(`已导入 ${value.imported.length} 个文件：`);
    for (const item of value.imported) lines.push(`  - novels/${item.book}/${item.file}`);
  }
  lines.push("", "</content>");
  return lines.join("\n");
}

// ==================== v7.3.0：实时聊天写作的草稿镜像 ====================
/**
 * 草稿镜像必须放在**独立目录**（`<书库>/.novel-writer/drafts/<书>/`），绝不能与正文同目录。
 *
 * 原因是插件所有章节扫描都按 `novels/<书>/` 下的**文件**枚举（`core.scanChapters`），
 * 并把每个 .md 当成一章参与字数统计、六维基线、语义索引与风格自检。把"正在写的半成品"
 * 放进那个目录，会让这些数字被草稿污染（同一章出现两份、章号重复、基线漂移），
 * 而这类错误在界面上只表现为"数字怪怪的"，极难自查。
 *
 * 这里刻意同时导出「镜像目录」与「正式目录」两套函数，就是为了在工具层显式对比：
 * 只要镜像路径落在正文目录下就拒绝执行（见 index.js 的 novel_draft / assertMirrorOutsideChapters）。
 */
const DRAFT_DIRNAME = "drafts";
export const DRAFT_FILE_SUFFIX = "__draft.md";
const DRAFT_STATE_SUFFIX = "__state.json";

export function draftRootDir(root) {
  return join(novelDataDir(root), DRAFT_DIRNAME);
}
export function draftBookDir(root, book) {
  return join(draftRootDir(root), sanitizeSegment(book, "book"));
}
/**
 * 章键归一：镜像文件与计数器文件共用同一套清洗/兜底，保证两者永远配对。
 *
 * v7.3.0 修正（真实数据暴露的问题）：**只要能解析出章号，就统一用「第NN章」**。
 * 旧行为按原始字面量命名，于是 AI 提交时写 `chapter:"3"` 得到 `3__draft.md`，
 * 而建章时用文件名 `第03章 证词里的空白` 又得到另一个文件——**同一章两份镜像**，
 * 用户看到的那份恰好只有「定稿」，于是以为"镜像没多写"。
 */
export function draftKeyFor(chapterKey) {
  const raw = String(chapterKey ?? "").trim() || "未命名章";
  const num = parseChapterNumber(raw);
  if (typeof num === "number" && Number.isFinite(num)) {
    return "第" + String(num).padStart(2, "0") + "章";
  }
  let key = "";
  try {
    key = sanitizeSegment(raw, "chapter");
  } catch {
    key = "";
  }
  // v7.3.1 修（#10）：此处原有 `.replace(/\.{2,}/g,".").replace(/^\.+|\.+$/g,"").trim()` 三个恒空操作。
  // sanitizeSegment 已经把**连续点号折叠成 `_`**、剥掉首尾点号与空白并把 `[.\s]+$` 清干净，
  // 所以那串 replace 永远命中不到任何东西（删掉行为完全不变）。下方 draftFileFor 的注释 ② 一并更新。
  const hash = () => createHash("sha1").update(raw).digest("hex").slice(0, 6);
  if (key === "") {
    key = "章-" + createHash("sha1").update(raw).digest("hex").slice(0, 8);
  } else if (key.length > 48) {
    key = key.slice(0, 48) + "-" + hash();
  }
  return key;
}
/**
 * 解析"这一章到底该用哪个镜像文件"：优先用规范键，其次**认领同章号的既有文件**。
 *
 * 第二层是为了兼容早期按字面量命名的镜像（如 `3__draft.md`）——
 * 否则升级后同一章会再多出一个 `第03章__draft.md`，历史内容看起来像丢了。
 */
export function resolveDraftTarget(root, book, chapterKey) {
  const dir = draftBookDir(root, book);
  const key = draftKeyFor(chapterKey);
  const canonicalFile = join(dir, key + DRAFT_FILE_SUFFIX);
  if (existsSync(canonicalFile)) return { key, dir, file: canonicalFile, stateFile: join(dir, key + DRAFT_STATE_SUFFIX) };
  const num = parseChapterNumber(String(chapterKey ?? "").trim());
  if (typeof num === "number" && Number.isFinite(num)) {
    try {
      const names = readdirSync(dir).filter((n) => n.endsWith(DRAFT_FILE_SUFFIX)).sort();
      for (const name of names) {
        const base = name.slice(0, -DRAFT_FILE_SUFFIX.length);
        if (parseChapterNumber(base) === num) {
          return { key: base, dir, file: join(dir, name), stateFile: join(dir, base + DRAFT_STATE_SUFFIX) };
        }
      }
    } catch { /* 目录不存在 = 新书 */ }
  }
  return { key, dir, file: canonicalFile, stateFile: join(dir, key + DRAFT_STATE_SUFFIX) };
}
/**
 * 草稿镜像文件名：`<章键>__draft.md`。
 *
 * 两道兜底，都是实测踩出来的：
 *   ① 清洗后为空（".." / "///" / 纯非法字符）→ 稳定短哈希名，绝不抛错；
 *   ② 长度截断到 48 + 6 位哈希（实测 300 字章名会让整条路径超过 Windows 260 上限，直接 ENOENT）。
 *
 * v7.3.1 修（#10）：上一版这里还有一条「连续点号折叠、首尾点号去掉」，实际上 sanitizeSegment
 * 早就做完了（连续点号折叠成 `_`，首尾点/空白剥掉）——draftKeyFor 里对应的 replace 是恒空操作，
 * 已删除；注释也不再声称有一道不存在的兜底。
 */
export function draftFileFor(root, book, chapterKey) {
  return join(draftBookDir(root, book), draftKeyFor(chapterKey) + DRAFT_FILE_SUFFIX);
}
// v7.3.1 修（#8）：删除 `draftStateFileFor(root, book, chapterKey)`——生产侧从来没用过它，
// 唯一调用在 test/chat-writing-test.mjs，而 resolveDraftTarget() 的返回值里**已经带 stateFile**
// （且它会在「同章号既有镜像」被认领时给出与镜像配对的那个，裸拼路径反而会指错）。
// 需要账本路径的调用方请用 `resolveDraftTarget(root, book, chapterKey).stateFile`。
// v7.3.1 修（#7）：删除 `draftMirrorHeader` / `renderDraftMirror` 两个导出（及二者之间的内部互调）。
// 写入路径（lib/index.js 的 novel_draft / 建章钩子）一直是 **appendFile 逐段追加**，从没调用过它们；
// 全仓库唯一的引用就是 renderDraftMirror → draftMirrorHeader 这一处自环，属纯死代码。
// 注意：下面 `parseDraftSegments` **不是**死代码（面板路由 lib/index.js 用它取分段），必须保留。
/**
 * 解析草稿镜像里的分段。约定每段以 `## 第N段` 开头（N 从 1 起），其后为正文，直到下一个段头。
 * @returns {Array<{ index:number, text:string }>}
 */
export function parseDraftSegments(content) {
  const text = String(content ?? "").replace(/\r\n?/g, "\n");
  const out = [];
  // v7.3.0 修正（合并时发现）：`novel_draft` 写入的段头是 `## 第1段 · <时间戳>`，
  // 而这里原来只认 `## 第N段`（`\s*$` 要求段名后直接结束）——**解析不了自己的写入格式**，
  // 结果是"数段"对（建章用的正则没有 $ 锚点）、"取正文"永远 0 段，面板预览会显示成空。
  // 现在允许段名后跟可选的 `· 时间戳`（也兼容人工只写 `## 第N段`）。
  const re = /^##\s*第\s*(\d+)\s*段(?:\s*[·・:：-].*)?$/gm;
  const finalRe = /^##\s*定稿落盘(?:$|[\s·・:：-].*)$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) marks.push({ kind: "seg", index: Number(m[1]), start: m.index, bodyStart: re.lastIndex });
  if (marks.length > 0) {
    while ((m = finalRe.exec(text)) !== null) marks.push({ kind: "final", start: m.index, bodyStart: finalRe.lastIndex });
    marks.sort((a, b) => a.start - b.start);
    for (let i = 0; i < marks.length; i += 1) {
      if (marks[i].kind !== "seg") continue;
      const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
      out.push({ index: marks[i].index, text: text.slice(marks[i].bodyStart, end).replace(/^\n+/, "").replace(/\s+$/, "") });
    }
    return out;
  }
  if (/^##\s*定稿落盘(?:$|[\s·・:：-].*)$/m.test(text)) {
    const stripped = text
      .replace(/^##\s*定稿落盘(?:$|[\s·・:：-].*)(?:\n(?:[ \t]*\n)*[ \t]*>\s*本章已写入正式章节[^\n]*)?/gm, "")
      .replace(/^\n+/, "")
      .replace(/\s+$/, "");
    if (stripped !== "") out.push({ index: 1, text: stripped });
  }
  return out;
}

const EMOTION_CODE = { joy: "喜", anger: "怒", sorrow: "哀", fear: "惧", surprise: "惊", neutral: "中性" };
export function buildBriefLine(result, scopeText) {
  const top3 = (result.categories || []).slice().sort(function (a, b) { return b.count - a.count; }).slice(0, 3).map(function (c) { return c.label + " " + Math.round(c.ratio * 100) + "%"; });
  const base = scopeText + " " + result.totalSentences + " 句：句式以 " + top3.join("、") + " 为主；均句长 " + (result.lengths ? result.lengths.avg.toFixed(1) : "-") + "；主导情绪 " + (result.emotion?.dominant || "-") + "。";
  const el = (result.categories || []).find(function (c) { return c.type === "ellipsis"; });
  return base + (el && el.ratio > 0.2 ? "留白较多，注意节奏" : "");
}
export function formatSentenceAnalysis(value) {
  if (value.enabled === false) {
    return `<path>novels/${value.book}</path>
<type>novel-sentence-analysis</type>
<content>
句式模式分析已关闭（${value.scope}，共 ${value.totalChars} 字）。
${value.message ?? ""}
（可用 novel_sentence_config 查看/开启）
</content>`;
  }
  const lines = [`<path>novels/${value.book}</path>`, "<type>novel-sentence-analysis</type>", "<content>", `统计范围: ${value.scope} (共 ${value.totalChars} 字 / ${value.totalSentences} 句)`, ""];
  lines.push("【句式分布】");
  for (const category of value.categories) {
    lines.push(`- ${category.label} ${(category.ratio * 100).toFixed(1)}% (${category.count} 句, 均长 ${category.avgLength})`);
  }
  lines.push("", "【句式排列】");
  const topTransitions = value.transitions.slice(0, 8).map((t) => `${CATEGORY_LABELS[t.from] ?? t.from}→${CATEGORY_LABELS[t.to] ?? t.to} ×${t.count}`).join("  ");
  lines.push(`- 高频转移: ${topTransitions || "-"}`);
  const topMotifs = value.motifs.slice(0, 5).map((m) => `${m.pattern.split("→").map((code) => CATEGORY_LABELS[code] ?? code).join("→")} ×${m.count}`).join("  ");
  lines.push(`- 句式模板: ${topMotifs || "-"}`);
  // v4.0.0：段落结构补"叙述"桶（narrationOnly，与 dialogueOnly+psychologyOnly+mixed 四类合计=total；缺字段按 0 容错）
  const narrationOnly = Number.isFinite(value.paragraphs.narrationOnly) ? value.paragraphs.narrationOnly : 0;
  lines.push(`- 段落结构: 共 ${value.paragraphs.total} 段（对话 ${value.paragraphs.dialogueOnly} / 心理 ${value.paragraphs.psychologyOnly} / 混合 ${value.paragraphs.mixed} / 叙述 ${narrationOnly}），均 ${value.paragraphs.avgSentences} 句/段; 对话连珠 ${value.paragraphs.exchanges}`);
  const opening = value.paragraphs.opening.slice(0, 4).map((o) => `${CATEGORY_LABELS[o.type] ?? o.type}×${o.count}`).join(" ");
  const closing = value.paragraphs.closing.slice(0, 4).map((o) => `${CATEGORY_LABELS[o.type] ?? o.type}×${o.count}`).join(" ");
  lines.push(`- 段首句式: ${opening || "-"}; 段尾句式: ${closing || "-"}`);
  if (value.chapterPatterns && value.chapterPatterns.length > 0) {
    lines.push(`- 章节节奏（压缩序列 S=陈述 ENV=环境 PSY=心理 DLG=对话 Q=疑问 RQ=反问 EX=感叹 IMP=祈使 …=省略）:`);
    for (const item of value.chapterPatterns.slice(0, 12)) lines.push(`  ${item.chapter}: ${item.sequence}`);
  }
  lines.push("", "【句长与风格】");
  lines.push(`- 均长 ${value.lengths.avg}, 中位 ${value.lengths.median}; 短句 ${(value.lengths.shortRatio * 100).toFixed(1)}%, 长句 ${(value.lengths.longRatio * 100).toFixed(1)}%`);
  lines.push(`- 对话占比 ${(value.style.dialogueRatio * 100).toFixed(1)}%, 心理占比 ${(value.style.psychologyRatio * 100).toFixed(1)}%, 环境占比 ${(value.style.environmentRatio * 100).toFixed(1)}%, 反问+疑问 ${(value.style.questionRatio * 100).toFixed(1)}%, 感叹 ${(value.style.exclamationRatio * 100).toFixed(1)}%`);
  lines.push(`- 主观性指数 ${value.style.subjectivityIndex}/100, 情感密度 ${value.style.emotionDensity}/千字, 第一人称密度 ${value.style.firstPersonDensity}/千字`);
  lines.push("", "【主观情感】");
  lines.push(`- 主导情绪: ${EMOTION_CODE[value.emotion.dominant] ?? value.emotion.dominant} (强度 ${value.emotion.intensity}/千字)`);
  const emoWords = value.emotion.scores.filter((s) => s.count > 0).map((s) => `${EMOTION_CODE[s.emotion] ?? s.emotion}:${s.count}`).join(" ");
  lines.push(`- 情绪分布: ${emoWords || "无明显情绪词"}`);
  const curve = value.emotion.curve.map((point) => `${point.segment}:${EMOTION_CODE[point.dominant] ?? point.dominant}${point.intensity}`).join(" ");
  lines.push(`- 情感曲线: ${curve || "-"}`);
  // v3.9.0：render 补全——情感净化预警/量化三指标/细节密度/语义隐性情感（此前只在 value，模型看不到）
  if (value.emotion && value.emotion.cleanDominant && value.emotion.cleanDominant !== value.emotion.dominant) {
    lines.push("", "【情感净化预警】");
    lines.push(`- 规则主导: ${EMOTION_CODE[value.emotion.dominant] ?? value.emotion.dominant}，净化后主导: ${EMOTION_CODE[value.emotion.cleanDominant] ?? value.emotion.cleanDominant}（置信度 ${value.emotion.confidence ?? "?"}）`);
    if (value.emotion.caveat) lines.push(`- 注意: ${value.emotion.caveat}`);
    if (value.emotion.aiAction) lines.push(`- 建议: ${value.emotion.aiAction}`);
    if (value.emotion.pollution && Object.keys(value.emotion.pollution).length > 0) {
      lines.push(`- 污染词: ${Object.entries(value.emotion.pollution).map(([k, v]) => k + "=" + JSON.stringify(v)).join("; ")}`);
    }
  }
  if (value.emotion && value.emotion.quantification) {
    const q = value.emotion.quantification;
    const stats = q.stats || {};
    if (Object.keys(stats).length > 0) {
      lines.push("", "【情感量化】");
      lines.push(`- Valence: 均值 ${stats.meanValence ?? 0}, 方差V ${stats.variance ?? 0}, 相邻撕裂 ${stats.adjVariance ?? 0}, 斜率Δ ${stats.delta ?? 0}, 矛盾指数C ${stats.conflict ?? 0}`);
      if (q.compare) lines.push(`- 显隐对比: ${JSON.stringify(q.compare).slice(0, 120)}`);
      if (q.complexity) {
        const cx = q.complexity;
        // v6.6.5 修正（用户反馈「情感复杂度会直接爆掉」的真凶）：
        // 原先这里打印的是 `JSON.stringify(q.complexity).slice(0, 120)` ✗ —— 而 `reliable` /
        // `reliabilityNote` 排在对象**末尾**，**必然被 120 字符截掉** ✗，于是「本项不可采信」
        // 这个最要紧的信息永远到不了渲染文本：读者只看到一个 `high`，看不到旁边的警告。
        // 现在改成可读行，并在不可采信时**单独起一行**写明原因。
        lines.push("- 复杂度: " + (cx.score ?? 0) + "（" + (cx.level ?? "?") + "）"
          + "熵 " + (cx.entropy ?? 0) + "/" + (cx.maxEntropy ?? 0) + "，多样性 " + (cx.diversity ?? 0)
          + (cx.conflict ? "，主次 " + cx.conflict + "（" + (cx.conflictStrength ?? 0) + "）" : "")
          + (cx.chapterDrift ? "，章间漂移 " + (cx.chapterDrift.swinging ? "有" : "无") + "（基准 " + (cx.chapterDrift.basis ?? "?") + "）" : ""));
        if (cx.reliable === false) lines.push("  " + String(cx.reliabilityNote ?? "⚠️ 本项不可采信，请勿据此下结论。"));
      }
      if (q.implicit && (q.implicit.ambiguous || []).length > 0) {
        // v3.9.0 修正：implicit 无 hits 字段（不再输出误导性的「隐性情感句 0 处」）
        lines.push(`- 隐性意象: 变色龙词 ${(q.implicit.ambiguous || []).length} 个（语义层裁决见下文/quantification.implicit）`);
      }
    }
    if (q.semanticImplicit && (q.semanticImplicit.hits || []).length > 0) {
      lines.push("", "【语义隐性情感】");
      const si = q.semanticImplicit;
      const sample = si.hits.slice(0, 3).map((h) => "[" + (h.top || "?") + "] " + h.text.slice(0, 30)).join(" / "); // v3.9.0 修正：字段是 top（情感标签）
      lines.push(`- 命中 ${si.hits.length} 处（情感原型语义检索）: ${sample}`);
      if (si.distribution && Object.keys(si.distribution).length > 0) lines.push(`- 分布: ${JSON.stringify(si.distribution).slice(0, 120)}`);
    }
  }
  if (value.density) {
    const d = value.density;
    const parts = [];
    if (typeof d.actionVerbsPer1000 === "number") parts.push(`动作动词 ${d.actionVerbsPer1000}/千字`);
    if (typeof d.actionChainRatio === "number") parts.push(`动作链占比 ${d.actionChainRatio.toFixed(1)}%`); // v3.9.0 修正：已是百分数（0~100），不再 ×100
    if (typeof d.objectNounsPer1000 === "number") parts.push(`物体名词 ${d.objectNounsPer1000}/千字`);
    if (typeof d.sensePer1000 === "number") parts.push(`感官词 ${d.sensePer1000}/千字`);
    if (parts.length > 0) {
      lines.push("", "【细节密度】");
      lines.push("- " + parts.join(" | "));
      // v7.1.0：口径标识随版本走。v7.0.0 去噪了细节密度，v7.1.0 又让六维动作密度接入同一张豁免表——
      // 两处都在改数值含义，并列写明，否则作者会拿旧报告的数字跟新报告比。
      lines.push("- 口径 " + METRIC_CALIBER + "（v7.0.0 起动作/物件/感官词表已去噪；v7.1.0 起六维动作密度共用同一张豁免表——同一章新旧数值不可直接比较）");
      if (Array.isArray(d.actionChainExamples) && d.actionChainExamples.length > 0) lines.push(`- 动作链例: ${d.actionChainExamples.slice(0, 3).join(" / ")}`);
    }
  }
  lines.push("", "【节奏建议】");
  if (value.guidance) {
    for (const line of value.guidance.split("\n")) lines.push(`- ${line}`);
  }
  lines.push("", "【风格指纹】");
  lines.push(`- ${value.fingerprint}`);
  lines.push("", "【AI 解读提示】");
  lines.push("结合上述统计与 novel_keywords 词汇偏好，说明作者的句式习惯（对话/心理/环境驱动、长短句节奏、反问或感叹的修辞倾向）、");
  lines.push("句式排列规律（如“对话→陈述→心理”循环）与主观情感倾向，并给出具体例证。");
  lines.push("注意：句式模式是参考节奏而非模板套用——若机械复刻导致僵硬必须优先自然表达。");
  lines.push("", "</content>");
  return lines.join("\n");
}

export async function listBookNames(root) {
  try {
    const dir = join(root, "novels");
    const entries = await readdir(dir, { withFileTypes: true });
    const names = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "创作资料") continue;
      if (entry.name.startsWith(".")) continue;
      names.push(entry.name);
    }
    return names.sort((a, b) => a.localeCompare(b, "zh"));
  } catch (e) {
    // v6.6.0：同 bookStats——读不到 ≠ 没有书；空列表把两者说成同一件事
    if (e?.code !== "ENOENT") {
      logEvent("silent_skip", { root, level: "warn", detail: "作品清单读取失败（作品列表按空处理）：" + String(e?.message ?? e) });
    }
    return [];
  }
}

export async function readBookAllText(root, book, exec, opts) {
  const dir = join(root, "novels", sanitizeSegment(book, "book"));
  if (!existsSync(dir)) throw new Error("书库中未找到作品：" + book + " 【解决：用 novel_books 查看可用作品名，或确认 novels/ 目录下已创建对应文件夹】");
  const chapters = await scanChapters(dir);
  let text = "";
  const texts = [];
  for (const chapter of chapters) {
    const t = await readTextFile(join(dir, chapter.file), exec);
    // v4.3.0 修正：逐章拼接补分隔符——旧版 text += t 在"章末无换行 + 下章开头无换行"时把两章粘成一句
    // （跨章句子粘连 → 统计出伪句/伪段落，内容指纹无谓失效）；口径与 buildStyleAnchorPackage 一致（章间必有 \n）
    text += t.endsWith("\n") ? t : t + "\n";
    texts.push({ file: chapter.file, text: t });
  }
  // v3.9.5：opts.withTexts=true 时一并返回逐章文本，供 style_report 六维基线复用（避免全书二次读盘）
  return opts?.withTexts === true ? { text, chapters, texts } : { text, chapters };
}
// ============ v6.5.0：用语审计的**定位**与**正则安全** ============

/**
 * 找出包含 needle 的**全部行号**（升序、去重）。
 *
 * 行号口径 = **该文件内的真实行号**。这一条有历史教训（见 index.js 里那段
 * "旧实现把各章首尾拼成一份文本再取行号，报出的 Lx 既不是任何文件的真实行号、也不带章名"）：
 * 必须先**逐章**取行号，再带章名合并；绝不可把多章拼成一份文本后取偏移。
 */
export function linesContaining(rawLines, needle) {
  const out = [];
  if (!needle || !Array.isArray(rawLines)) return out;
  for (let i = 0; i < rawLines.length; i += 1) {
    if (rawLines[i].includes(needle)) out.push(i + 1);
  }
  return out;
}

/**
 * 行号数组 → 区间数组（合并相邻/近邻行，避免"第2行，第3行，第5行"这种啰嗦输出）。
 * `gap` = 允许合并的最大行距：0 表示仅相邻行合并；1 表示隔一行也并进来。
 * [2,3,5,6,7] gap=0 → [{from:2,to:3},{from:5,to:7}]
 */
export function mergeLineRanges(lineNos, gap = 0) {
  const sorted = [...new Set((Array.isArray(lineNos) ? lineNos : [])
    .filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const out = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n - last.to <= gap + 1) last.to = n;
    else out.push({ from: n, to: n });
  }
  return out;
}

/** 区间 → 「第2-10行，第52行」；超出 max 段则截断并注明总段数。 */
export function formatLineRanges(ranges, max = 8) {
  const list = Array.isArray(ranges) ? ranges : [];
  if (list.length === 0) return "";
  const seg = (r) => "第" + (r.from === r.to ? r.from : r.from + "-" + r.to) + "行";
  const head = list.slice(0, max).map(seg).join("，");
  return list.length > max ? head + "，等 " + list.length + " 段" : head;
}

function shorthandSampleChar(code) {
  if (code === "d") return "1";
  if (code === "s") return " ";
  if (code === "W") return "，";
  return "a";
}

function sampleCharFromPredicate(pred) {
  if (!pred) return "a";
  if (pred.kind === "cp") return String.fromCodePoint(pred.cp);
  if (pred.kind === "dot") return "a";
  if (pred.kind === "shorthand") return shorthandSampleChar(pred.code);
  if (pred.kind === "class") {
    if (!pred.negated) {
      if (pred.ranges.length > 0) return String.fromCodePoint(pred.ranges[0][0]);
      for (const s of pred.shorthands) return shorthandSampleChar(s);
    }
    for (const ch of ["a", "1", "中", "，", " "]) {
      if (matchesPredicate(pred, ch.codePointAt(0))) return ch;
    }
  }
  return "a";
}

function isVariableQuantifier(q) {
  if (!q) return false;
  const base = q.length > 1 && q.endsWith("?") ? q.slice(0, -1) : q;
  if (base === "*" || base === "+" || base === "?") return true;
  const m = /^\{(\d+)(,)?(\d*)\}$/.exec(base);
  if (!m) return false;
  if (!m[2]) return false;
  if (m[3] === "") return true;
  return Number(m[1]) !== Number(m[3]);
}

function canRepeatMultiple(q) {
  if (!q) return false;
  const base = q.length > 1 && q.endsWith("?") ? q.slice(0, -1) : q;
  if (base === "*" || base === "+") return true;
  const m = /^\{(\d+)(,)?(\d*)\}$/.exec(base);
  if (!m) return false;
  if (!m[2]) return Number(m[1]) >= 2;
  if (m[3] === "") return true;
  return Number(m[3]) >= 2;
}

function isUnboundedQuant(q) {
  if (!q) return false;
  const base = q.length > 1 && q.endsWith("?") ? q.slice(0, -1) : q;
  return base === "*" || base === "+" || /^\{\d+,\}$/.test(base);
}

function isMandatoryQuant(q) {
  if (!q) return true;
  const base = q.length > 1 && q.endsWith("?") ? q.slice(0, -1) : q;
  if (base === "+") return true;
  if (base === "*" || base === "?") return false;
  const m = /^\{(\d+)/.exec(base);
  return m ? Number(m[1]) >= 1 : true;
}

/** 从模式里挑几个代表字符做探针输入（优先采集量化分组内与字符类中的标点/字面字符）。 */
function pickProbeChars(pattern, max = 8) {
  const src = String(pattern ?? "");
  const out = [];
  const push = (ch) => {
    if (ch && !out.includes(ch) && out.length < max) out.push(ch);
  };
  const sampleSegment = (seg) => {
    for (let i = 0; i < seg.length && out.length < max; i += 1) {
      const ch = seg[i];
      if (ch === "\\" && i + 1 < seg.length) {
        const nextCh = seg[i + 1];
        if (nextCh === "b" || nextCh === "B" || (nextCh >= "1" && nextCh <= "9")) {
          i += 1;
          continue;
        }
        const atom = parseEscapeAtom(seg, i);
        if (atom.shorthand) push(shorthandSampleChar(atom.shorthand));
        else if (atom.cp !== void 0) push(String.fromCodePoint(atom.cp));
        i = atom.next - 1;
        continue;
      }
      if (ch === "[") {
        const close = skipCharClass(seg, i);
        if (close < seg.length) {
          const m = parseCharClassMatcher(seg.slice(i, close + 1));
          if (!m.negated) {
            for (const s of m.shorthands) push(shorthandSampleChar(s));
            for (const [lo] of m.ranges) {
              push(String.fromCodePoint(lo));
              if (out.length >= max) break;
            }
          } else {
            push(sampleCharFromPredicate(m));
          }
        }
        i = close;
        continue;
      }
      if (ch === "(") {
        const hdr = seg.slice(i + 1).match(/^\?(?:[ims]*:|[:=!]|<=|<!|<[^>]+>)/);
        if (hdr) i += hdr[0].length;
        continue;
      }
      if (ch === "{") {
        const q = seg.slice(i).match(/^\{\d+,?\d*\}/);
        if (q) { i += q[0].length - 1; continue; }
      }
      if (ch === ".") { push("a"); continue; }
      if (")|*+?^$".includes(ch)) continue;
      const cp = seg.codePointAt(i);
      push(String.fromCodePoint(cp));
      if (cp > 0xFFFF) i += 1;
    }
  };
  for (const g of scanGroups(src)) {
    if (canRepeatMultiple(g.quant)) sampleSegment(g.inner);
    if (out.length >= max) break;
  }
  if (out.length < max) sampleSegment(src);
  if (out.length === 0) out.push("a", "1");
  return out;
}

/** 跑一次模式，返回毫秒（异常返回 -1）。 */
function timeRegex(pattern, input) {
  const t0 = process.hrtime.bigint();
  try {
    new RegExp(pattern, "g").test(input);
  } catch {
    return -1;
  }
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

/**
 * **深度感知**扫描出「分组 + 紧跟的限定符」。
 *
 * 为什么不能用正则做这件事：`[^()\\]` 这类字符类**匹配不了嵌套的括号**，
 * 于是 `((a)*)*` 这种「括号套括号」的形态会被整体漏掉——独立验证代理找出的 8 个漏网模式里，
 * 就有 2 个正是这样躲过去的。所以这里手写一个小扫描器（栈 + 跳过转义与字符类）。
 */
function skipCharClass(s, openIdx) {
  let i = openIdx + 1;
  while (i < s.length && s[i] !== "]") { if (s[i] === "\\") i += 1; i += 1; }
  return i;
}

function scanGroups(pattern) {
  const out = [];
  const stack = [];
  const p = String(pattern ?? "");
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i];
    if (ch === "\\") { i += 1; continue; }
    if (ch === "[") { i = skipCharClass(p, i); continue; }
    if (ch === "(") { stack.push(i); continue; }
    if (ch === ")") {
      const start = stack.pop();
      if (start === undefined) continue;
      const q = p.slice(i + 1).match(/^(?:[+*]|\{\d+,?\d*\})\??/);
      out.push({ start, end: i, inner: p.slice(start + 1, i), quant: q ? q[0] : "" });
    }
  }
  return out;
}

function splitTopLevelAlts(body) {
  const alts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "\\") { i += 1; continue; }
    if (ch === "[") { i = skipCharClass(body, i); continue; }
    if (ch === "(") { depth += 1; continue; }
    if (ch === ")") { if (depth > 0) depth -= 1; continue; }
    if (ch === "|" && depth === 0) {
      alts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  alts.push(body.slice(start));
  return alts;
}

function findMatchingParen(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "\\") { i += 1; continue; }
    if (ch === "[") { i = skipCharClass(s, i); continue; }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseEscapeAtom(str, idx) {
  const ch = str[idx + 1];
  if (ch === "d" || ch === "D" || ch === "w" || ch === "W" || ch === "s" || ch === "S") {
    return { next: idx + 2, shorthand: ch };
  }
  const fixed = { n: 10, r: 13, t: 9, f: 12, v: 11, "0": 0 };
  if (Object.prototype.hasOwnProperty.call(fixed, ch)) {
    return { next: idx + 2, cp: fixed[ch] };
  }
  if (ch === "x" && /^[0-9A-Fa-f]{2}/.test(str.slice(idx + 2, idx + 4))) {
    return { next: idx + 4, cp: parseInt(str.slice(idx + 2, idx + 4), 16) };
  }
  if (ch === "u") {
    if (str[idx + 2] === "{") {
      const m = /^\{([0-9A-Fa-f]+)\}/.exec(str.slice(idx + 2));
      if (m) return { next: idx + 2 + m[0].length, cp: parseInt(m[1], 16) };
    }
    if (/^[0-9A-Fa-f]{4}/.test(str.slice(idx + 2, idx + 6))) {
      return { next: idx + 6, cp: parseInt(str.slice(idx + 2, idx + 6), 16) };
    }
  }
  if (ch === "c" && idx + 2 < str.length && /[A-Za-z]/.test(str[idx + 2])) {
    return { next: idx + 3, cp: str.charCodeAt(idx + 2) % 32 };
  }
  const cp = str.codePointAt(idx + 1);
  return { next: idx + 1 + (cp > 0xFFFF ? 2 : 1), cp };
}

function parseCharClassMatcher(token) {
  let i = 1;
  let negated = false;
  if (token[i] === "^") { negated = true; i += 1; }
  const ranges = [];
  const shorthands = new Set();
  const end = token.length - 1;
  const readItem = (pos) => {
    if (token[pos] === "\\") return parseEscapeAtom(token, pos);
    const cp = token.codePointAt(pos);
    return { next: pos + (cp > 0xFFFF ? 2 : 1), cp };
  };
  while (i < end) {
    const first = readItem(i);
    if (first.shorthand) {
      shorthands.add(first.shorthand);
      i = first.next;
      continue;
    }
    if (first.next + 1 < end && token[first.next] === "-") {
      const second = readItem(first.next + 1);
      if (!second.shorthand && first.cp <= second.cp) {
        ranges.push([first.cp, second.cp]);
        i = second.next;
        continue;
      }
    }
    ranges.push([first.cp, first.cp]);
    i = first.next;
  }
  return { kind: "class", negated, ranges, shorthands };
}

function matchesShorthand(code, cp) {
  if (code === "d") return cp >= 48 && cp <= 57;
  if (code === "D") return !(cp >= 48 && cp <= 57);
  if (code === "w") return (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122) || cp === 95;
  if (code === "W") return !matchesShorthand("w", cp);
  if (code === "s") return cp === 32 || (cp >= 9 && cp <= 13) || cp === 160 || cp === 0x3000;
  if (code === "S") return !matchesShorthand("s", cp);
  return false;
}

function matchesPredicate(pred, cp) {
  if (pred.kind === "cp") return cp === pred.cp;
  if (pred.kind === "dot") return cp !== 10 && cp !== 13 && cp !== 0x2028 && cp !== 0x2029;
  if (pred.kind === "shorthand") return matchesShorthand(pred.code, cp);
  if (pred.kind === "class") {
    let hit = false;
    for (const s of pred.shorthands) {
      if (matchesShorthand(s, cp)) { hit = true; break; }
    }
    if (!hit) {
      for (const [lo, hi] of pred.ranges) {
        if (cp >= lo && cp <= hi) { hit = true; break; }
      }
    }
    return pred.negated ? !hit : hit;
  }
  return false;
}

function leadingCharPredicates(expr, depth = 0) {
  const s = String(expr ?? "");
  const preds = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "^") { i += 1; continue; }
    if (s.startsWith("\\b", i) || s.startsWith("\\B", i)) { i += 2; continue; }
    let atomEnd = i;
    if (s[i] === "(") {
      const close = findMatchingParen(s, i);
      if (close < 0) break;
      const rawInner = s.slice(i + 1, close);
      atomEnd = close + 1;
      if (/^\?(?:=|!|<=|<!)/.test(rawInner)) {
        const q = s.slice(atomEnd).match(/^(?:[?*+]|\{\d+,?\d*\})\??/);
        i = atomEnd + (q ? q[0].length : 0);
        continue;
      }
      if (depth < 5) {
        const cleanSub = rawInner.replace(/^\?(?:[ims]*:|<[^>]+>)/, "");
        for (const subAlt of splitTopLevelAlts(cleanSub)) preds.push(...leadingCharPredicates(subAlt, depth + 1));
      }
    } else if (s[i] === "[") {
      const close = skipCharClass(s, i);
      if (close >= s.length) break;
      preds.push(parseCharClassMatcher(s.slice(i, close + 1)));
      atomEnd = close + 1;
    } else if (s[i] === "\\" && i + 1 < s.length) {
      const atom = parseEscapeAtom(s, i);
      preds.push(atom.shorthand ? { kind: "shorthand", code: atom.shorthand } : { kind: "cp", cp: atom.cp });
      atomEnd = atom.next;
    } else if (s[i] === ".") {
      preds.push({ kind: "dot" });
      atomEnd = i + 1;
    } else {
      const cp = s.codePointAt(i);
      preds.push({ kind: "cp", cp });
      atomEnd = i + (cp > 0xFFFF ? 2 : 1);
    }
    const q = s.slice(atomEnd).match(/^(?:[?*+]|\{\d+,?\d*\})\??/);
    const isOptional = q ? (q[0][0] === "?" || q[0][0] === "*" || /^\{0,/.test(q[0])) : false;
    if (!isOptional) break;
    i = atomEnd + q[0].length;
  }
  return preds;
}

function predicatesOverlap(predsA, predsB) {
  if (predsA.length === 0 || predsB.length === 0) return false;
  const probes = new Set([0x3000, 0x4E00, 0x4E01, 0x10000, 0x10001]);
  for (let ascii = 0; ascii <= 127; ascii += 1) probes.add(ascii);
  for (const list of [predsA, predsB]) {
    for (const p of list) {
      if (p.kind === "cp") probes.add(p.cp);
      else if (p.kind === "class") {
        for (const [lo, hi] of p.ranges) {
          probes.add(lo);
          probes.add(hi);
          if (lo > 0) probes.add(lo - 1);
          if (hi < 0x10FFFF) probes.add(hi + 1);
        }
      }
    }
  }
  for (const cp of probes) {
    if (predsA.some((pa) => matchesPredicate(pa, cp)) && predsB.some((pb) => matchesPredicate(pb, cp))) return true;
  }
  return false;
}

/** 分组内的分支是否**可能重叠**（识别字面相同、简写与字符类子集/交集重叠，如 (a|a)、(?:[a-z]|a)、(\d|[0-9])）。 */
function hasOverlappingAlternation(inner) {
  const body = String(inner ?? "").replace(/^\?(?:[ims]*:|[:=!]|<=|<!|<[^>]+>)/, "");
  const alts = splitTopLevelAlts(body);
  if (alts.length < 2) return false;
  const branchPreds = alts.map((a) => leadingCharPredicates(a)).filter((ps) => ps.length > 0);
  for (let i = 0; i < branchPreds.length; i += 1) {
    for (let j = i + 1; j < branchPreds.length; j += 1) {
      if (predicatesOverlap(branchPreds[i], branchPreds[j])) return true;
    }
  }
  return false;
}

/** 分组内是否含可变长度量词（* / + / ? / {n,} / {n,m} 且 n≠m）或空分支（等价可空重复）。固定 {n} 不算可变重复。 */
function hasVariableInnerQuantifier(inner) {
  const body = String(inner ?? "").replace(/^\?(?:[ims]*:|[:=!]|<=|<!|<[^>]+>)/, "");
  const topAlts = splitTopLevelAlts(body);
  if (topAlts.length >= 2 && topAlts.some((a) => a === "")) return true;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "\\") { i += 1; continue; }
    if (ch === "[") { i = skipCharClass(body, i); continue; }
    if (ch === "(") {
      const close = findMatchingParen(body, i);
      if (close > i) {
        if (hasVariableInnerQuantifier(body.slice(i + 1, close))) return true;
        i = close;
        continue;
      }
      const hdr = body.slice(i + 1).match(/^\?(?:[ims]*:|[:=!]|<=|<!|<[^>]+>)/);
      if (hdr) i += hdr[0].length;
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "?") return true;
    if (ch === "{") {
      const m = /^\{(\d+)(,)?(\d*)\}/.exec(body.slice(i));
      if (m) {
        if (isVariableQuantifier(m[0])) return true;
        i += m[0].length - 1;
        if (body[i + 1] === "?") i += 1;
      }
    }
  }
  return false;
}

/**
 * 同一分支内，两个可相交原子被无界量词修饰且中间无**必选且不相交**的分隔符（如 a*a* / .+.+ / \d+\d+ / \d+.*\d+）
 * → 多项式级回溯。按顶层 `|` 拆分分支并在不相交的必选分隔符处重置追踪，避免误杀线性的 `\d+年\d+月` / `上\d+柱香|点\d+根蜡烛`。
 */
function scanRepeatedUnboundedInBranch(branch, initialSeen, depth, budget) {
  const seen = new Map(initialSeen);
  const s = String(branch ?? "");
  let i = 0;
  while (i < s.length) {
    budget.steps += 1;
    if (budget.steps > 500) return { hit: false, seen };
    if (s[i] === "^" || s[i] === "$") { i += 1; continue; }
    if (s.startsWith("\\b", i) || s.startsWith("\\B", i)) { i += 2; continue; }

    let atomEnd = i;
    let pred = null;
    let atomKey = "";
    if (s[i] === "(") {
      const close = findMatchingParen(s, i);
      if (close < 0) break;
      const rawInner = s.slice(i + 1, close);
      atomEnd = close + 1;
      const qMatch = s.slice(atomEnd).match(/^(?:[?*+]|\{\d+,?\d*\})\??/);
      const q = qMatch ? qMatch[0] : "";
      const nextIdx = atomEnd + q.length;
      const cleanInner = rawInner.replace(/^\?(?:[ims]*:|[:=!]|<=|<!|<[^>]+>)/, "");
      if (/^\?(?:=|!|<=|<!)/.test(rawInner)) {
        if (depth < 6) {
          for (const subAlt of splitTopLevelAlts(cleanInner)) {
            if (scanRepeatedUnboundedInBranch(subAlt, new Map(), depth + 1, budget).hit) {
              return { hit: true, seen };
            }
          }
        }
        i = nextIdx;
        continue;
      }
      if (depth < 6) {
        const alts = splitTopLevelAlts(cleanInner);
        const merged = isMandatoryQuant(q) ? new Map() : new Map(seen);
        for (const subAlt of alts) {
          const res = scanRepeatedUnboundedInBranch(subAlt, seen, depth + 1, budget);
          if (res.hit) return { hit: true, seen };
          for (const [k, v] of res.seen) merged.set(k, v);
        }
        seen.clear();
        for (const [k, v] of merged) seen.set(k, v);
      }
      i = nextIdx;
      continue;
    } else if (s[i] === "[") {
      const close = skipCharClass(s, i);
      if (close >= s.length) break;
      atomKey = s.slice(i, close + 1);
      pred = parseCharClassMatcher(atomKey);
      atomEnd = close + 1;
    } else if (s[i] === "\\" && i + 1 < s.length) {
      const nextCh = s[i + 1];
      if (nextCh >= "1" && nextCh <= "9") {
        atomEnd = i + 2;
      } else if ((nextCh === "p" || nextCh === "P") && s[i + 2] === "{") {
        const endBrace = s.indexOf("}", i + 3);
        atomEnd = endBrace >= 0 ? endBrace + 1 : i + 2;
      } else {
        const atom = parseEscapeAtom(s, i);
        atomKey = s.slice(i, atom.next);
        pred = atom.shorthand ? { kind: "shorthand", code: atom.shorthand } : { kind: "cp", cp: atom.cp };
        atomEnd = atom.next;
      }
    } else if (s[i] === ".") {
      atomKey = ".";
      pred = { kind: "dot" };
      atomEnd = i + 1;
    } else {
      const cp = s.codePointAt(i);
      const len = cp > 0xFFFF ? 2 : 1;
      atomKey = s.slice(i, i + len);
      pred = { kind: "cp", cp };
      atomEnd = i + len;
    }

    const qMatch = s.slice(atomEnd).match(/^(?:[?*+]|\{\d+,?\d*\})\??/);
    const q = qMatch ? qMatch[0] : "";
    if (pred) {
      if (isMandatoryQuant(q)) {
        for (const [k, prevPred] of [...seen.entries()]) {
          if (!predicatesOverlap([prevPred], [pred])) seen.delete(k);
        }
      }
      if (isUnboundedQuant(q)) {
        for (const [k, prevPred] of seen.entries()) {
          if (k === atomKey || predicatesOverlap([prevPred], [pred])) {
            return { hit: true, seen };
          }
        }
        seen.set(atomKey, pred);
      }
    }
    i = atomEnd + q.length;
  }
  return { hit: false, seen };
}

function hasRepeatedUnboundedAtom(pattern) {
  const p = String(pattern ?? "");
  const budget = { steps: 0 };
  for (const branch of splitTopLevelAlts(p)) {
    if (scanRepeatedUnboundedInBranch(branch, new Map(), 0, budget).hit) return true;
  }
  return false;
}

/** 扫描无界通配（.* / .+ / .{n,} / [\s\S]* / [\S\s]+ 等），跳过转义与普通字符类（如 Mr\.* / [.*] 不误报）。 */
function hasUnboundedWildcard(pattern) {
  const p = String(pattern ?? "");
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i];
    if (ch === "\\") { i += 1; continue; }
    if (ch === "[") {
      const close = skipCharClass(p, i);
      if (close < p.length) {
        const cls = parseCharClassMatcher(p.slice(i, close + 1));
        const isAllChar = !cls.negated && (
          (cls.shorthands.has("s") && cls.shorthands.has("S")) ||
          (cls.shorthands.has("d") && cls.shorthands.has("D")) ||
          (cls.shorthands.has("w") && cls.shorthands.has("W"))
        );
        if (isAllChar && /^(?:[*+]|\{\d+,\})/.test(p.slice(close + 1))) return true;
      }
      i = close;
      continue;
    }
    if (ch === "." && /^(?:[*+]|\{\d+,\})/.test(p.slice(i + 1))) return true;
  }
  return false;
}

function hasTopLevelUnboundedBrace(pattern) {
  const p = String(pattern ?? "");
  for (let i = 0; i < p.length; i += 1) {
    if (p[i] === "\\") { i += 1; continue; }
    if (p[i] === "[") { i = skipCharClass(p, i); continue; }
    if (p[i] === "{" && /^\{\d+,\}/.test(p.slice(i))) return true;
  }
  return false;
}

function hasBoundaryAnchor(pattern) {
  const p = String(pattern ?? "");
  if (p.startsWith("^")) return true;
  for (let i = 0; i < p.length; i += 1) {
    if (p[i] === "\\") { i += 1; continue; }
    if (p[i] === "[") { i = skipCharClass(p, i); continue; }
    if (p[i] === "$" && i === p.length - 1) return true;
  }
  return false;
}

/** 提取每个顶层分支在首个量化分组/可变重复之前的字面引导前缀，使 `前(?:a?a?)+终` 在经验探测中也能触发回溯。 */
function sampleLeadingPrefix(branch, depth = 0) {
  const s = String(branch ?? "");
  let buf = "";
  let hitRepeat = false;
  let i = 0;
  while (i < s.length && buf.length < 32) {
    if (s[i] === "^" || s[i] === "$") { i += 1; continue; }
    if (s.startsWith("\\b", i) || s.startsWith("\\B", i)) { i += 2; continue; }
    if (s[i] === "(") {
      const close = findMatchingParen(s, i);
      if (close < 0) break;
      const rawInner = s.slice(i + 1, close);
      const atomEnd = close + 1;
      const qMatch = s.slice(atomEnd).match(/^(?:[?*+]|\{\d+,?\d*\})\??/);
      const q = qMatch ? qMatch[0] : "";
      if (/^\?(?:=|!|<=|<!)/.test(rawInner)) { i = atomEnd + q.length; continue; }
      if (canRepeatMultiple(q)) { hitRepeat = true; break; }
      if (depth < 2 && isMandatoryQuant(q)) {
        const cleanSub = rawInner.replace(/^\?(?:[ims]*:|<[^>]+>)/, "");
        const firstAlt = splitTopLevelAlts(cleanSub)[0] || "";
        const sub = sampleLeadingPrefix(firstAlt, depth + 1);
        buf += sub.prefix;
        if (sub.hitRepeat) { hitRepeat = true; break; }
      }
      i = atomEnd + q.length;
      continue;
    }
    let atomEnd = i;
    let pred = null;
    if (s[i] === "[") {
      const close = skipCharClass(s, i);
      if (close >= s.length) break;
      pred = parseCharClassMatcher(s.slice(i, close + 1));
      atomEnd = close + 1;
    } else if (s[i] === "\\" && i + 1 < s.length) {
      const nextCh = s[i + 1];
      if (nextCh >= "1" && nextCh <= "9") {
        atomEnd = i + 2;
      } else {
        const atom = parseEscapeAtom(s, i);
        pred = atom.shorthand ? { kind: "shorthand", code: atom.shorthand } : { kind: "cp", cp: atom.cp };
        atomEnd = atom.next;
      }
    } else if (s[i] === ".") {
      pred = { kind: "dot" };
      atomEnd = i + 1;
    } else {
      const cp = s.codePointAt(i);
      pred = { kind: "cp", cp };
      atomEnd = i + (cp > 0xFFFF ? 2 : 1);
    }
    const qMatch = s.slice(atomEnd).match(/^(?:[?*+]|\{\d+,?\d*\})\??/);
    const q = qMatch ? qMatch[0] : "";
    if (isUnboundedQuant(q) || (isVariableQuantifier(q) && canRepeatMultiple(q))) {
      hitRepeat = true;
      break;
    }
    if (pred && isMandatoryQuant(q)) {
      const fixedM = /^\{(\d+)/.exec(q);
      const count = fixedM ? Math.min(4, Number(fixedM[1])) : 1;
      buf += sampleCharFromPredicate(pred).repeat(count);
    }
    i = atomEnd + q.length;
  }
  return { prefix: buf.slice(0, 32), hitRepeat };
}

function extractLeadingPrefixes(pattern, maxPrefixes = 4) {
  const out = [""];
  for (const branch of splitTopLevelAlts(String(pattern ?? ""))) {
    const res = sampleLeadingPrefix(branch, 0);
    if (res.hitRepeat && res.prefix !== "" && !out.includes(res.prefix)) {
      out.push(res.prefix);
      if (out.length >= maxPrefixes) break;
    }
  }
  return out;
}

/**
 * **经验探测**：把模式在**短对抗输入**上跑两遍，用耗时增长判定是否存在指数回溯。
 *
 * 为什么不能只靠形状黑名单：独立验证代理实测 8 个形状（`(a|a)*b`、`(香|香)*上`、`(a{0,10}){0,10}b`、
 * `a*a*…*b`、`((a)*)*b`、`(?:a|a)*b` …）**全部绕过了最初的嵌套量词检查**，而它们在 30 字输入上要跑 7.5 秒、
 * 33 字上超过 45 秒。形状枚举永远追不上——**必须实测**。
 *
 * 为什么探测本身不会挂住：指数回溯的代价随长度**指数增长**，而 n=18/22 时最坏也只有 2^21 ≈ 2×10^6 步
 * （实测同类模式 20 字 ~10ms、24 字 ~120ms、30 字 7.5 秒）。所以短输入上探测是安全的，
 * 而线性模式的耗时是**微秒级**——两者差三四个数量级，判定极稳。
 *
 * 两个判据取其一即拒绝：**22 字耗时 ≥ 5ms**（绝对量级），或 **22 字/18 字增长 ≥ 4 倍**（增长形态）。
 * 用两条是因为首次测量会含正则编译开销（约 1~3ms），会稀释比值——绝对量级那条把它兜住。
 * 除纯重复串外，同步附加引导前缀与尾失配符（`\u0007` 与 `\n`）以捕获前缀门控与 `$` 尾锚定回溯（如 `前(?:a?a?)+终`、`(?:[a-z]|a)+$`）。
 *
 * **已知残留（如实记录）**：多项式级（如 5 个以上 `a*` 串联）在 22 字下确实很快（<1ms），
 * 本探测抓不到，靠 `hasRepeatedUnboundedAtom` 的结构检查兜。但**两者都不是完备的**——
 * 理论上仍存在既非指数、又无重复原子、却在长文本上很慢的模式。故运行期还有第三道：逐句扫描 + 长度上限。
 */
function probeReDoS(pattern) {
  let worstMs = 0;
  let worstRatio = 0;
  let sample = "";
  const suffixes = ["", "\u0007", "\n"];
  const prefixes = extractLeadingPrefixes(pattern);
  const chars = pickProbeChars(pattern);
  for (const prefix of prefixes) {
    for (const ch of chars) {
      for (const suffix of suffixes) {
        const t18 = timeRegex(pattern, prefix + ch.repeat(18) + suffix);
        if (t18 < 0) return { worstMs: 0, worstRatio: 0, sample: ch, failed: true };
        if (t18 >= 20) return { worstMs: t18, worstRatio, sample: ch, failed: false };
        const t22 = timeRegex(pattern, prefix + ch.repeat(22) + suffix);
        if (t22 < 0) return { worstMs: 0, worstRatio: 0, sample: ch, failed: true };
        const ms = Math.max(t18, t22);
        if (ms > worstMs) { worstMs = ms; sample = ch; }
        if (t18 >= 1 && t22 >= 1) {
          const ratio = t22 / t18;
          if (ratio > worstRatio) worstRatio = ratio;
        }
        if (worstMs >= 20) return { worstMs, worstRatio, sample, failed: false };
      }
    }
  }
  return { worstMs, worstRatio, sample, failed: false };
}

/**
 * 正则**安全校验**（静态 + 经验，登记时用）。
 *
 * 为什么必须有：用户登记的语用模式会被 `new RegExp(p, "g")` 原样编译并执行，
 * 而 Node 的同步正则**无法中断**——不能在运行期"跑 50ms 就掐掉"。
 * 实测（29 字符输入）：`/(上+)+香/` 18.4 秒、`/(上*)*香/` **40.8 秒**、`/上{0,20}香/` 0.05 毫秒。
 * 也就是说一个写法有毒的模式能让宿主长时间无响应，而它只是"世界观里的一条仪式禁式"。
 *
 * 三层：① 形状黑名单（嵌套量词 / 量词套在含分支的分组上 / 无界通配）
 *       ② **经验探测**（形状枚举追不上的那些，靠实测耗时增长抓）
 *       ③ 运行期逐句扫描（把跨句与单次输入规模限住，见 splitSentences）
 *
 * @returns {{ok: boolean, level: "ok"|"warn"|"reject", reason: string, suggestion: string}}
 */
export function validatePattern(pattern) {
  const p = typeof pattern === "string" ? pattern : "";
  if (p.trim() === "") return { ok: false, level: "reject", code: "empty", reason: "模式为空", suggestion: "" };
  if (p.length > 200) {
    return { ok: false, level: "reject", code: "too-long", reason: "模式超过 200 字符上限", suggestion: "拆成多条更短的模式" };
  }
  try {
    new RegExp(p, "g");
  } catch (e) {
    return { ok: false, level: "reject", code: "syntax", reason: "正则语法错误：" + String(e && e.message || e).slice(0, 120), suggestion: "检查括号与转义是否配对" };
  }

  // ①-a / ①-b 分组上的量词：用**深度感知扫描**（正则匹配不了嵌套括号，会漏掉 ((a)*)* 这类）
  //   · 分组内含**可变重复/可空量词**（* / + / ? / {n,m} 且 n≠m）+ 外层可重复多次 → 嵌套重复（(x+)+ / ((a)*)* / (a?a?)+ / (a{0,10}){0,10}）
  //     注意固定次数重复 (\d{2}){2} 零回溯，不误拒
  //   · 分组内含**可能重叠的分支** + 外层可重复多次 → 重叠分支回溯（(a|a)* / (香|香)*）
  //     注意 (上|下)+ 这种**不重叠**的分支是安全的，不误拒（判据：任两分支首字符集是否相交）
  for (const g of scanGroups(p)) {
    if (!canRepeatMultiple(g.quant)) continue;
    if (hasVariableInnerQuantifier(g.inner)) {
      const cleanInner = g.inner.replace(/^\?(?:[ims]*:|[:=!]|<=|<!|<[^>]+>)/, "");
      const atom = cleanInner
        .replace(/(\\.|\[(?:\\.|[^\]\\])*\])|(?:[+*?]|\{\d+,?\d*\})\??/g, (full, keep) => keep || "")
        .replace(/[()]/g, "");
      let validDemo = false;
      if (atom && !/^\s*$/.test(atom) && !/\\$/.test(atom)) {
        try { new RegExp(atom + "{0,20}"); validDemo = true; } catch { /* 示范串语法不完整时退回通用提示 */ }
      }
      const demo = validDemo ? "例如 " + atom + "{0,20}" : "例如将内层 * / + / ? 改成有界写法";
      return {
        ok: false, level: "reject", code: "redos",
        reason: "量词套在含可变重复或可空量词的分组上（嵌套重复），会造成指数级回溯——实测同类模式在 29 字符上要跑 40 秒",
        suggestion: "把内层重复改成有界量词，" + demo + "；或去掉外层的重复"
      };
    }
    if (hasOverlappingAlternation(g.inner)) {
      return {
        ok: false, level: "reject", code: "redos",
        reason: "量词套在**分支重叠**的分组上（如 (a|a)*），会造成指数级回溯——实测同类模式在 30 字符上要跑 7.5 秒",
        suggestion: "合并重复的分支（(a|a) → a），或把外层量词改成有界（如 {0,20}）"
      };
    }
  }

  // ①-c 同一原子被两个以上无界量词修饰：a*a*…*b 属**多项式**级回溯，
  //      在 22 字下确实很快（<1ms），经验探测抓不到，但长文本上仍会炸（n^6 量级）
  if (hasRepeatedUnboundedAtom(p)) {
    return {
      ok: false, level: "reject", code: "redos",
      reason: "同一个原子被两个以上无界量词修饰（如 a*a*a*），长文本上会造成多项式级回溯",
      suggestion: "合并成一个有界量词，例如 a*a* → a{0,20}"
    };
  }

  // ①-d 无界通配：跨句匹配（审计是整章文本，会跨越句号与换行）
  if (hasUnboundedWildcard(p)) {
    return {
      ok: false, level: "reject", code: "wildcard",
      reason: "无界通配（.* / .+ / [\\s\\S]* 等）会跨越句号与换行，把不相干的上下文连起来误报",
      suggestion: "改成句内且有界的间隔，例如 .* → [^。！？\\n]{0,20}"
    };
  }

  // ② 经验探测（形状枚举追不上的那些，靠实测抓）
  const probe = probeReDoS(p);
  if (probe.failed) {
    return { ok: false, level: "reject", code: "exec-throws", reason: "模式在执行时抛错，无法用于扫描", suggestion: "检查模式的转义与分组" };
  }
  if (probe.worstMs >= 5 || (probe.worstRatio >= 4 && probe.worstMs >= 1)) {
    return {
      ok: false, level: "reject", code: "redos",
      reason: "实测该模式存在回溯爆炸（对抗输入 22 字耗时 " + probe.worstMs.toFixed(1) + "ms" +
        (probe.worstRatio >= 4 ? "、增长 " + probe.worstRatio.toFixed(1) + " 倍" : "") + "），长文本上会让检查长时间卡住",
      suggestion: "把重复改成有界量词（如 {0,20}）、去掉重叠的分支（(a|a) → a）、或避免量词套量词"
    };
  }

  // ③ 顶层无界重复：线性但不封顶，长文本上代价不可控
  if (hasTopLevelUnboundedBrace(p)) {
    return {
      ok: false, level: "warn",
      reason: "存在无上界的重复次数（{n,}），长文本上代价不可控",
      suggestion: "给出上界，例如 {1,} → {1,20}"
    };
  }

  // ④ 边界锚：本审计是"在正文里找可疑片段"，锚定整串的模式几乎必然匹配不到
  if (hasBoundaryAnchor(p)) {
    return { ok: false, level: "warn", reason: "模式带有整串锚定（^ / $），在正文扫描里通常匹配不到", suggestion: "去掉 ^ 与 $，或改用更小的片段作为模式" };
  }

  return { ok: true, level: "ok", reason: "", suggestion: "" };
}

/**
 * 把章节文本切成**句级**片段（正则扫描的单位）。
 *
 * 为什么必须逐句：模式若含 `.` 类通配，在整章文本上会跨越句号与换行——
 * 实测 `/上.*香/` 在一段 121 字的文本上命中了 115 字（跨 3 句）。逐句后这种跨句在结构上不可能。
 * 同时它把单次匹配的输入规模限住，是 ReDoS 的第二道防线（第一道是 validatePattern 的静态+经验校验）。
 *
 * 超长"句子"（无标点的长段落）按 `hardLimit` 硬切。**硬切必须带重叠**：
 * 独立验证代理实测，不带重叠时「上……香 相距 6 字但跨过 1000 字切点」的那条命中**整条丢失**
 * （对照组正常命中）。重叠 `overlap` 字即可让跨切点的模式在相邻窗口里被完整看到；
 * 重复命中由调用方按行号去重（locations 是行号区间，天然去重）。
 *
 * 上限从 1000 收到 400：句子通常远短于此，而更小的单位让"万一漏过校验的有毒模式"
 * 也炸不起来（同步正则无法中断，只能靠限制输入规模）。
 */
export function splitSentences(text, hardLimit = 400, overlap = 32) {
  const src = typeof text === "string" ? text : "";
  if (src === "") return [];
  const step = Math.max(1, hardLimit - overlap);
  const out = [];
  for (const raw of src.split(/(?<=[。！？!?；;\n])/)) {
    if (raw === "") continue;
    if (raw.length <= hardLimit) { out.push(raw); continue; }
    for (let i = 0; i < raw.length; i += step) {
      out.push(raw.slice(i, i + hardLimit));
      if (i + hardLimit >= raw.length) break;
    }
  }
  return out;
}

export function parseEvidenceCounts(arr) {
  let n = 0;
  for (const item of arr || []) {
    const m = String(item).match(/^(?:.*?)(?:×|\u00d7)(\d+)$/);
    n += m ? parseInt(m[1], 10) : 1;
  }
  return n;
}
export function extractTopKeywords(text, topN) {
  // v2.6.0：①超长文本等距抽样（头/中/尾各一段，避免全量匹配+全量排序）②复用 extractKeywords
  // （含三字组/疑似人名）③人名/三字词优先展示，并过滤被三字词包含的二字碎片——修复"薇薇安"被拆成"薇薇/薇安"
  const sampled = text.length > 300000
    ? text.slice(0, 100000) + text.slice(Math.floor(text.length / 2) - 50000, Math.floor(text.length / 2) + 50000) + text.slice(-100000)
    : text;
  const kws = extractKeywords(sampled, topN * 3);
  const rank = { "name-candidate": 0, "cjk-trigram": 1, "cjk-bigram": 2, word: 3 };
  const sorted = [...kws].sort((a, b) => rank[a.kind] - rank[b.kind] || b.count - a.count || a.word.localeCompare(b.word));
  const trigrams = sorted.filter((k) => k.kind === "cjk-trigram").map((k) => k.word);
  const seen = new Set();
  const out = [];
  for (const k of sorted) {
    if (seen.has(k.word)) continue;
    if (k.kind === "cjk-bigram" && trigrams.some((t) => t.includes(k.word))) continue;
    seen.add(k.word);
    out.push(k.word + "(" + k.count + ")");
    if (out.length >= topN) break;
  }
  return out;
}

export function formatBooks(value) {
  // v6.3.0 修正（旧清单 #92）：`<path>` 一律用**书库根相对路径**，三种工具同一口径。
  // 旧版是 `${value.root}/novels`：绝对路径 + 混合分隔符（Windows 的根用反斜杠、这里又拼正斜杠），
  // 与 formatChapters 的 `novels/<书>` 相对路径、formatRead 的绝对全反斜杠路径三方不一致，
  // 且把用户本机绝对路径写进了模型可见输出。
  const lines = [`<path>novels</path>`, `<type>novel-library</type>`, `<content>`, ""];
  if (value.books.length === 0) lines.push("（暂无作品。请在 novels/<书名>/ 下存放章节文件，如 第01章.md）");
  for (const book of value.books) lines.push(`- ${book.name}: ${book.chapters} 章, ${book.chars} 字`);
  lines.push("", "</content>");
  return lines.join("\n");
}
export function formatChapters(value) {
  const lines = [`<path>novels/${value.book}</path>`, `<type>novel-chapters</type>`, `<content>`, ""];
  if (value.chapters.length === 0) lines.push("（该作品下没有章节文件）");
  for (const chapter of value.chapters) {
    const number = chapter.number === void 0 ? "?" : String(chapter.number).padStart(2, "0");
    lines.push(`- 第${number}章 ${chapter.title} — ${chapter.chars} 字 / ${chapter.lines} 行 (${chapter.file}, 更新于 ${chapter.updated.slice(0, 10)})`);
  }
  // v4.3.1：同章号多文件提示。这类书按章号读取会被 findChapter 拒绝（避免静默读错稿），
  // 但列表里两条只是"同名条目"，不主动说明的话用户不知道磁盘上是两份文件——必须在这里就看见。
  const dupByNumber = new Map();
  for (const chapter of value.chapters) {
    if (chapter.number === void 0) continue;
    const list = dupByNumber.get(chapter.number) ?? [];
    list.push(chapter.file);
    dupByNumber.set(chapter.number, list);
  }
  const conflicts = [...dupByNumber.entries()].filter(([, files]) => files.length > 1);
  if (conflicts.length > 0) {
    lines.push("", `⚠️ 同章号多文件 ${conflicts.length} 组（按章号读取会因歧义被拒绝；请改名到空闲章号，或用 novel_import 重新导入自动避让）：`);
    for (const [number, files] of conflicts) {
      lines.push(`  第${String(number).padStart(2, "0")}章: ${files.join(" / ")}`);
    }
  }
  lines.push("", "</content>");
  return lines.join("\n");
}
export function formatRead(value) {
  const endLine = value.lines.length > 0 ? value.lines[value.lines.length - 1].number : value.offset - 1;
  const body = value.lines.map((line) => `${line.number}: ${line.text}`).join("\n");
  const hasMoreLines = endLine < value.totalLines;
  let footer;
  // v3.7.0 ④ / v7.4.0：chars 是已显示部分字数；仅在后续仍有未读行时提示用 offset 续读，
  // 已到末行却因单行 >3000 字裁剪而 truncated 时不再误导调用方传入越界 offset。
  if (value.truncated && hasMoreLines) {
    footer = `(输出截断${value.hitLineCap ? "，且含超 3000 字裁剪行" : ""}。本章共 ${value.totalLines} 行，已显示 ${value.offset}-${endLine} 行 / ${value.chars} 字。用 offset=${endLine + 1} 继续阅读。)`;
  } else if (value.truncated) {
    footer = `(单行超 3000 字已裁剪。本章共 ${value.totalLines} 行，已显示 ${value.offset}-${endLine} 行 / ${value.chars} 字。)`;
  } else {
    footer = `(本章共 ${value.totalLines} 行 / ${value.chars} 字)`;
  }
  // v6.3.0 修正（旧清单 #92）：`<path>` 与另两个工具统一为书库根相对路径。
  // 旧版用 value.path（index.js 传来的绝对路径，Windows 上还是全反斜杠）——与 formatBooks/formatChapters 的
  // 相对口径不一致，且把用户本机路径写进模型可见输出。file/book 是同一份返回体里的字段，零额外 IO。
  return `<path>novels/${value.book}/${value.file}</path>
<type>novel-chapter</type>
<content>
${body === "" ? "" : `${body}\n`}
${footer}
</content>`;
}
export function formatKeywords(value) {
  const lines = [`<path>novels/${value.book}</path>`, `<type>novel-keywords</type>`, `<content>`, `统计范围: ${value.scope} (共 ${value.totalChars} 字)`, ""];
  if (value.keywords.length === 0) lines.push("（未提取到重复出现的关键词）");
  for (const keyword of value.keywords) {
    const kind = keyword.kind === "cjk-bigram" ? "词组" : keyword.kind === "cjk-trigram" ? "三字组" : keyword.kind === "name-candidate" ? "疑似人名" : "英文词";
    lines.push(`- ${keyword.word} × ${keyword.count} (${kind})`);
  }
  lines.push("", "</content>");
  return lines.join("\n");
}
export function cleanOutput(v) {
  if (typeof v === "number") return Object.is(v, -0) ? 0 : (Number.isNaN(v) ? null : v);
  if (v instanceof Date) return v.toISOString();
  if (v instanceof RegExp) return String(v);
  if (v instanceof Map) return cleanOutput(Array.from(v.entries()));
  if (v instanceof Set) return cleanOutput(Array.from(v.values()));
  if (Array.isArray(v)) return v.map(function (x) { return cleanOutput(x); });
  if (v !== null && typeof v === "object") {
    const outObj = {};
    for (const k of Object.keys(v)) {
      const val = v[k];
      if (val === undefined) continue;
      outObj[k] = cleanOutput(val);
    }
    return outObj;
  }
  return v;
}
