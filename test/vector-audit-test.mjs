/**
 * v7.0.0（v2.1 Phase 2）：向量审计的**确定性**测试。
 *
 * 为什么要注入假嵌入器：真嵌入要加载本地 ONNX 模型（首次几百毫秒、CI 上可能根本没有模型文件）。
 * 这里用「按段首标记字映射到固定向量」的假嵌入器，把"相似度"变成可精确编排的输入，
 * 从而钉住这几件真正需要保证的事：
 *   ① 判据是本**章内稳健 z 分数**（中位数/MAD，不是总体标准差、不是绝对余弦）——
 *      总体 z 存在自抑制：k 个高相似对时 z_max = sqrt((M-k)/k)，打转越长 z 越小，反而越不报；
 *   ② 「有没有新信息」的参照系是**首段 + 前文**（不是窗口之前的全文）——
 *      旧参照系让「章首打转」和「新场景连写三遍」双双漏检；
 *   ③ 必须**同时**满足"词汇零新颖度"才报——否则同一处境换个说法重复，会被当成原地打转；
 *   ④ 任何一步不可用（引擎缺失 / 嵌入失败 / 块太少）都要**明确 return checked:false**，
 *      而不是返回"没发现循环"（那两句在调用方看来是一回事，但含义完全相反）；
 *   ⑤ 大纲兑现不能用"任意一个二字组命中"短路——一个主角名就能放过整条大纲。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { checkOutlineFulfillment, detectSemanticLoop, QUERY_PREFIX, __clearVectorCache } from "../lib/vector-audit.js";

/** 段首标记字 → 固定向量（16 维 one-hot；同标记 = 余弦 1，不同标记 = 0） */
const MARKERS = ["壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖", "拾", "甲", "乙", "丙", "丁"];
function fakeEmbed(text) {
  const t = String(text).startsWith(QUERY_PREFIX) ? String(text).slice(QUERY_PREFIX.length) : String(text);
  const head = t.trim()[0];
  const idx = MARKERS.indexOf(head);
  const v = new Array(16).fill(0);
  v[idx >= 0 ? idx : 15] = 1;
  return v;
}

/**
 * 「分级余弦」假嵌入器：同标记 = 1.0；不同标记 = a_i × a_j（a = t/√(1+t²)，t = 0.1·(i+1)），
 * 于是相邻块余弦是 0.02~0.17 的一簇连续值 —— 用来构造**非退化**分布（MAD > 0），
 * 让测试真正走到"稳健 z"这条主判据上，而不是只走 σ=0 的绝对余弦兜底。
 */
function gradedEmbed(text) {
  const t = String(text).startsWith(QUERY_PREFIX) ? String(text).slice(QUERY_PREFIX.length) : String(text);
  const head = t.trim()[0];
  const idx = MARKERS.indexOf(head);
  const v = new Array(24).fill(0);
  v[idx >= 0 ? idx : 14] = 1;
  v[23] = 0.1 * ((idx >= 0 ? idx : 0) + 1);
  return v;
}
const always = () => true;

/** 组一段长度足够（≥8 字）的正文；marker 决定向量 */
function para(marker, body) {
  return marker + body;
}

/** 补足正文长度（< 200 字时审计会明确跳过，测试正文得够长）。
 *  刻意避开断言里用到的字眼（推开/城楼/烽火 等），免得"关键词命中"被填充文本误触发。 */
const FILLER = [
  "捌另外的段落，讲的是院墙外的天色和路边的水洼，字数够长就行。",
  "玖还有一段，提到更夫从墙外走过，灯笼晃了一路，声音渐远。",
  "拾最后一段也是填充，说的是窗纸被风吹得作响，屋里没人应声。",
  "乙再补一段，讲灶上的水开了又凉，凉了又开，最后没人管它。"
].join("\n\n");
const withFiller = (body) => body + "\n\n" + FILLER;

/** 12 块「互不相同」的填充段落（marker 各不相同 → 相邻余弦 0），用来给重复段做对照组 */
const DISTINCT = [
  "他推开门，把长刀靠在墙边，然后坐下。",
  "窗外的风灌进来，烛火晃了一下，影子散开。",
  "她数了三枚铜钱，推到柜台另一边，袖口沾了泥。",
  "巷道尽头传来脚步声，越来越近，夹着铁器碰撞。",
  "他握紧刀柄，指节抵住护手，掌心出了汗。",
  "有人在敲门，很轻，像怕吵醒谁。",
  "他把灯芯剪短，屋里更暗了，雨点砸在瓦上。",
  "雨停的时候，天边泛出一点灰白。",
  "她终于开口，说了一句他听不懂的话。",
  "院里的井绳断了一截，垂在水面上。",
  "更夫敲了三下，声音从墙外过去。",
  "柜台后的老人抬眼看了他一下，又低下头。"
];

// ---------------------------------------------------------------------------
// bug 1：novelty 参照系（旧版拿「窗口之前的全文」当参照，章首恒 1.0 / 新场景虚高）
// ---------------------------------------------------------------------------

test("① 章首打转：fromBlock===0 的连续 3 块完全相同 → 必须报出（旧版参照系是空串，novelty 恒 1.0 必漏）", async () => {
  __clearVectorCache();
  const S = "他在雨里站了很久，什么也没有说，只是看着水洼里的倒影。";
  // 章首三块一字不差；后面全是不同内容 → 只有 sim(0,1) 与 sim(1,2) 是热点对
  const paras = [
    para("叁", S),
    para("叁", S),
    para("叁", S),
    para("肆", DISTINCT[2]),
    para("伍", DISTINCT[3]),
    para("陆", DISTINCT[4]),
    para("柒", DISTINCT[5]),
    para("捌", DISTINCT[6]),
    para("玖", DISTINCT[7]),
    para("拾", DISTINCT[8]),
    para("甲", DISTINCT[9]),
    para("乙", DISTINCT[10])
  ];
  const r = await detectSemanticLoop(paras.join("\n\n"), { embed: fakeEmbed, isAvailable: always });
  assert.equal(r.checked, true, "应当真的跑了：" + JSON.stringify(r));
  assert.equal(r.blocks, 12, "块数应为 12，实际 " + r.blocks);
  assert.equal(r.loops.length, 1, "章首打转必须报出（旧版此处恒漏）：" + JSON.stringify(r.loops));
  const loop = r.loops[0];
  assert.equal(loop.fromBlock, 0, "应从第 0 块起报：" + JSON.stringify(loop));
  assert.equal(loop.toBlock, 2, "应覆盖到第 2 块：" + JSON.stringify(loop));
  assert.ok(loop.novelty < 0.18, "重复部分相对首块零新词，novelty 应很低：" + loop.novelty);
  assert.ok(loop.sim >= 0.99, "相似度应为 1 左右：" + loop.sim);
  assert.ok(loop.lineFrom >= 1 && loop.lineTo >= loop.lineFrom, "行号区间不合法：" + JSON.stringify(loop));
  assert.ok(typeof loop.excerpt === "string" && loop.excerpt.length > 0, "应带引文片段");
});

test("② 新场景复制 3 遍：前 5 块互不相同，第 6/7/8 块一字不差 → 必须报出（旧版前文没这些词，novelty 虚高放行）", async () => {
  __clearVectorCache();
  const FRESH = "雾气漫过石阶，灯笼在檐下晃，他没有回头看。";
  const paras = [
    para("壹", DISTINCT[0]),
    para("贰", DISTINCT[1]),
    para("肆", DISTINCT[2]),
    para("伍", DISTINCT[3]),
    para("陆", DISTINCT[4]),
    para("叁", FRESH), // 新场景，前文从未出现
    para("叁", FRESH),
    para("叁", FRESH),
    para("柒", DISTINCT[5]),
    para("捌", DISTINCT[6]),
    para("玖", DISTINCT[7]),
    para("拾", DISTINCT[8])
  ];
  const r = await detectSemanticLoop(paras.join("\n\n"), { embed: fakeEmbed, isAvailable: always });
  assert.equal(r.checked, true, "应当真的跑了：" + JSON.stringify(r));
  assert.equal(r.blocks, 12, "块数应为 12，实际 " + r.blocks);
  assert.equal(r.loops.length, 1, "新场景连写三遍必须报出：" + JSON.stringify(r.loops));
  assert.equal(r.loops[0].fromBlock, 5, "应从第 5 块（新场景第一遍）起报：" + JSON.stringify(r.loops[0]));
  assert.equal(r.loops[0].toBlock, 7, "应覆盖到第 7 块：" + JSON.stringify(r.loops[0]));
  assert.ok(r.loops[0].novelty < 0.18, "重复块相对首块没有新词：" + r.loops[0].novelty);
});

// ---------------------------------------------------------------------------
// bug 2：总体 z 的自抑制悖论（z_max = sqrt((M-k)/k)）
// ---------------------------------------------------------------------------

test("③ 打转越长越要报：连续 3 块 vs 连续 5 块都必须报（旧版 k=4 时 z_max=sqrt(7/4)=1.32 < 2 必漏）", async () => {
  __clearVectorCache();
  const S = "他把这句话又咽了回去，喉咙里像是堵了一块冷石头。";

  // A：12 块，S 出现在第 2 块 + 第 5/6/7 块（k = 2，旧版 z_max = sqrt(9/2) = 2.12，勉强触发）
  const a = [
    para("壹", DISTINCT[0]),
    para("贰", DISTINCT[1]),
    para("叁", S),
    para("肆", DISTINCT[2]),
    para("伍", DISTINCT[3]),
    para("叁", S),
    para("叁", S),
    para("叁", S),
    para("柒", DISTINCT[4]),
    para("捌", DISTINCT[5]),
    para("玖", DISTINCT[6]),
    para("拾", DISTINCT[7])
  ];
  const ra = await detectSemanticLoop(a.join("\n\n"), { embed: fakeEmbed, isAvailable: always });
  assert.equal(ra.checked, true, "应当真的跑了：" + JSON.stringify(ra));
  assert.equal(ra.blocks, 12);
  assert.equal(ra.loops.length, 1, "连续 3 块重复应报出：" + JSON.stringify(ra.loops));
  assert.equal(ra.loops[0].toBlock - ra.loops[0].fromBlock, 2, "应覆盖 3 块：" + JSON.stringify(ra.loops[0]));

  // B：12 块，S 出现在第 2 块 + 第 5/6/7/8/9 块（k = 4，旧版 z_max = sqrt(7/4) = 1.32 → 打转更严重反而漏报）
  const b = [
    para("壹", DISTINCT[0]),
    para("贰", DISTINCT[1]),
    para("叁", S),
    para("肆", DISTINCT[2]),
    para("伍", DISTINCT[3]),
    para("叁", S),
    para("叁", S),
    para("叁", S),
    para("叁", S),
    para("叁", S),
    para("玖", DISTINCT[6]),
    para("拾", DISTINCT[7])
  ];
  const rb = await detectSemanticLoop(b.join("\n\n"), { embed: fakeEmbed, isAvailable: always });
  assert.equal(rb.checked, true, "应当真的跑了：" + JSON.stringify(rb));
  assert.equal(rb.blocks, 12);
  assert.equal(rb.loops.length, 1, "连续 5 块重复必须报出（旧版必漏）：" + JSON.stringify(rb.loops));
  assert.equal(rb.loops[0].toBlock - rb.loops[0].fromBlock, 4, "应覆盖 5 块：" + JSON.stringify(rb.loops[0]));
  assert.ok(rb.loops[0].novelty < 0.18, "重复块相对首块没有新词：" + rb.loops[0].novelty);
});

test("④ 短章兜底：9 块（8 个相邻对）里连续 3 块重复 → 必须报出（旧版 z_max=sqrt(6/2)=1.73 < 2，短章永不触发）", async () => {
  __clearVectorCache();
  const S = "灯花爆了一下，他抬手把火苗按灭，屋里彻底黑了。";
  const paras = [
    para("壹", DISTINCT[0]),
    para("贰", DISTINCT[1]),
    para("叁", S),
    para("肆", DISTINCT[2]),
    para("伍", DISTINCT[3]),
    para("叁", S),
    para("叁", S),
    para("叁", S),
    para("柒", DISTINCT[4])
  ];
  const r = await detectSemanticLoop(paras.join("\n\n"), { embed: fakeEmbed, isAvailable: always });
  assert.equal(r.checked, true, "应当真的跑了：" + JSON.stringify(r));
  assert.equal(r.blocks, 9, "块数应为 9（短章），实际 " + r.blocks);
  assert.equal(r.loops.length, 1, "短章里的连续 3 块重复必须报出：" + JSON.stringify(r.loops));
  assert.equal(r.loops[0].fromBlock, 5, "应从第 5 块起报：" + JSON.stringify(r.loops[0]));
  assert.ok(typeof r.loops[0].mode === "string" && r.loops[0].mode.length > 0, "应注明判定路径：" + JSON.stringify(r.loops[0]));
});

test("⑤ 稳健 z 主判据（非退化分布，MAD > 0）：热点对由章内稳健 z 抓出，mode === robustZ", async () => {
  __clearVectorCache();
  // 同标记 = 余弦 1；不同标记 = 0.02~0.17 的一簇连续值 → 中位数 0.11 / MAD 0.059 / σ≈0.088
  const S = "他把伞收起来，抖了抖，水珠落了一地，谁也没有说话。";
  const paras = [
    para("壹", DISTINCT[0]),
    para("贰", DISTINCT[1]),
    para("叁", DISTINCT[2]),
    para("肆", DISTINCT[3]),
    para("伍", S),
    para("伍", S),
    para("伍", S),
    para("肆", DISTINCT[4]),
    para("叁", DISTINCT[5]),
    para("贰", DISTINCT[6]),
    para("壹", DISTINCT[7]),
    para("伍", DISTINCT[8])
  ];
  const r = await detectSemanticLoop(paras.join("\n\n"), { embed: gradedEmbed, isAvailable: always });
  assert.equal(r.checked, true, "应当真的跑了：" + JSON.stringify(r));
  assert.equal(r.blocks, 12, "块数应为 12，实际 " + r.blocks);
  assert.equal(r.loops.length, 1, "应只报出中间那一处打转：" + JSON.stringify(r.loops));
  const loop = r.loops[0];
  assert.equal(loop.fromBlock, 4, "应从第 4 块起报：" + JSON.stringify(loop));
  assert.equal(loop.toBlock, 6, "应覆盖到第 6 块：" + JSON.stringify(loop));
  assert.equal(loop.mode, "robustZ", "非退化分布应走稳健 z 判据，而不是绝对余弦兜底：" + JSON.stringify(loop));
  assert.ok(loop.z >= 1.8, "稳健 z 应达阈值：" + loop.z);
  assert.ok(loop.sim >= 0.82, "绝对余弦应达下限：" + loop.sim);
  assert.ok(loop.novelty < 0.18, "重复块没有新词：" + loop.novelty);
});

test("⑥ 词汇新颖度兜底：相似度高但每块都有新词 → 不报（否则同处境换说法会被误判）", async () => {
  __clearVectorCache();
  // 三块用同一标记（向量完全相同），但正文互不相同 → 新颖度高 → 必须压掉
  const paras = [
    para("壹", "他推开门，把长刀靠在墙边，然后坐下。"),
    para("贰", "窗外的风灌进来，烛火晃了一下，影子散开。"),
    para("柒", "她数了三枚铜钱，推到柜台另一边，袖口沾了泥。"),
    para("柒", "巷道尽头传来脚步声，越来越近，夹着铁器碰撞。"),
    para("柒", "他把灯芯剪短，屋里更暗了，雨点砸在瓦上。"),
    para("叁", "有人在敲门，很轻，像怕吵醒谁。"),
    para("肆", "他握紧刀柄，指节抵住护手，掌心出了汗。"),
    para("伍", "雨停的时候，天边泛出一点灰白。"),
    para("陆", "她终于开口，说了一句他听不懂的话。"),
    para("捌", "院里的井绳断了一截，垂在水面上。"),
    para("玖", "更夫敲了三下，声音从墙外过去。"),
    para("拾", "柜台后的老人抬眼看了他一下，又低下头。"),
    para("甲", "他把铜钱收进袋里，系紧袋口，转身走开。")
  ];
  const r = await detectSemanticLoop(paras.join("\n\n"), { embed: fakeEmbed, isAvailable: always });
  assert.equal(r.checked, true);
  assert.equal(r.loops.length, 0, "新颖度高时不应报原地打转：" + JSON.stringify(r.loops));
});

test("⑦ 全不相同 → 不报；且 σ=0/无热对时不产生 NaN", async () => {
  __clearVectorCache();
  const paras = MARKERS.map((m, i) => para(m, "第" + (i + 1) + "件事发生了，内容和别的都不一样，字数也凑够了。"));
  const r = await detectSemanticLoop(paras.join("\n\n"), { embed: fakeEmbed, isAvailable: always });
  assert.equal(r.checked, true);
  assert.equal(r.loops.length, 0);
  assert.ok(Number.isFinite(r.blocks) && !Number.isNaN(r.blocks));
});

test("⑧ 块太少 / 引擎不可用 / 嵌入失败：必须 checked:false（不是「没发现问题」）", async () => {
  __clearVectorCache();
  const short = [para("壹", "短短一段话，字数不够切很多块。"), para("贰", "另一段话，也不长。")].join("\n\n");
  const a = await detectSemanticLoop(short, { embed: fakeEmbed, isAvailable: always });
  assert.equal(a.checked, false);
  assert.ok(a.reason.includes("块") || a.reason.includes("过短"), "要给原因：" + a.reason);

  const b = await detectSemanticLoop(short.repeat(3), { embed: fakeEmbed, isAvailable: () => false });
  assert.equal(b.checked, false, "引擎不可用时必须 checked:false");
  assert.ok(b.reason.includes("不可用"), "要给原因：" + b.reason);

  const boom = async () => { throw new Error("wasm oom"); };
  const long = MARKERS.map((m, i) => para(m, "第" + (i + 1) + "段正文，用于触发一次嵌入异常，字数足够长。")).join("\n\n");
  const c = await detectSemanticLoop(long, { embed: boom, isAvailable: always });
  assert.equal(c.checked, false, "嵌入失败时必须 checked:false");
  assert.ok(c.reason.includes("嵌入"), "要给原因：" + c.reason);
});

test("⑨ 缓存生效：同文本第二次调用不再重新嵌入", async () => {
  __clearVectorCache();
  let calls = 0;
  const counting = (t) => { calls += 1; return fakeEmbed(t); };
  const long = MARKERS.map((m, i) => para(m, "第" + (i + 1) + "段正文，用于验证块文本哈希缓存是否命中。")).join("\n\n");
  await detectSemanticLoop(long, { embed: counting, isAvailable: always });
  const first = calls;
  assert.ok(first >= 13, "首次应逐块嵌入：" + first);
  await detectSemanticLoop(long, { embed: counting, isAvailable: always });
  assert.equal(calls, first, "第二次应全部命中缓存，实际又调了 " + (calls - first) + " 次");
});

test("⑩ Markdown 标题行不进语义块（否则多出一个空块，行号也会错位）", async () => {
  __clearVectorCache();
  const S = "他坐在门槛上，把那封信折了又展开，纸边已经起毛。";
  const paras = [
    para("壹", DISTINCT[0]),
    para("贰", DISTINCT[1]),
    para("肆", DISTINCT[2]),
    para("伍", DISTINCT[3]),
    para("叁", S),
    para("叁", S),
    para("叁", S),
    para("柒", DISTINCT[4]),
    para("捌", DISTINCT[5]),
    para("玖", DISTINCT[6]),
    para("拾", DISTINCT[7]),
    para("甲", DISTINCT[8])
  ];
  const withHeading = "## 巷口那一夜的风与灯\n\n" + paras.join("\n\n");
  const r = await detectSemanticLoop(withHeading, { embed: fakeEmbed, isAvailable: always });
  assert.equal(r.checked, true, "应当真的跑了：" + JSON.stringify(r));
  assert.equal(r.blocks, 12, "标题行不应自成一块（旧版会多出第 13 块），实际 " + r.blocks);
  assert.equal(r.loops.length, 1, "正文那处打转仍应报出：" + JSON.stringify(r.loops));
  assert.ok(!r.loops[0].excerpt.startsWith("#"), "引文不应取自标题行：" + r.loops[0].excerpt);
  assert.ok(r.loops[0].lineFrom >= 3, "行号应按原文计（标题在第 1 行）：" + r.loops[0].lineFrom);
});

test("⑪ 大纲兑现：子句二字组按比例命中才算字面兑现；无关键词且向量也不像 → 报出", async () => {
  __clearVectorCache();
  const body = [
    para("壹", "他推开门，把长刀靠在墙边，然后坐下。"),
    para("贰", "窗外的风灌进来，烛火晃了一下，影子散开。"),
    para("叁", "她数了三枚铜钱，推到柜台另一边，袖口沾了泥。"),
    para("肆", "巷道尽头传来脚步声，越来越近，夹着铁器碰撞。"),
    para("伍", "他把灯芯剪短，屋里更暗了，雨点砸在瓦上。"),
    para("陆", "有人在敲门，很轻，像怕吵醒谁。"),
    para("柒", "他握紧刀柄，指节抵住护手，掌心出了汗。"),
    para("捌", "雨停的时候，天边泛出一点灰白。")
  ].join("\n\n");
  // 方向行几乎逐字对应正文 → 二字组命中比例远超 40% → 算兑现
  const r = await checkOutlineFulfillment("他推开门把长刀靠在墙边然后坐下", withFiller(body), { embed: fakeEmbed, isAvailable: always });
  assert.equal(r.checked, true);
  assert.equal(r.unfulfilled.length, 0, "关键词命中比例达标时不应报漏写：" + JSON.stringify(r.unfulfilled));

  const r2 = await checkOutlineFulfillment("登上城楼点燃烽火号令三军", withFiller(body), { embed: fakeEmbed, isAvailable: always });
  assert.equal(r2.checked, true);
  assert.equal(r2.unfulfilled.length, 1, "完全没提到的大纲子句应报出：" + JSON.stringify(r2.unfulfilled));
  assert.ok(r2.unfulfilled[0].clause.includes("烽火"), "报出的应是那条子句");
  assert.ok(r2.unfulfilled[0].bestSim <= 0.42, "向量也不该达标：" + r2.unfulfilled[0].bestSim);
});

test("⑫ 大纲一词短路：子句只命中主角名「林风」→ 必须报漏写（旧版 some() 一词即放过）", async () => {
  __clearVectorCache();
  // 正文里确实出现过主角名，但「登上城楼 / 点燃烽火 / 号令三军」一件事都没发生
  const body = [
    para("壹", "林风站在廊下，看着雨水顺着瓦檐往下滴。"),
    para("贰", "窗外的风灌进来，烛火晃了一下，影子散开。"),
    para("叁", "她数了三枚铜钱，推到柜台另一边，袖口沾了泥。"),
    para("肆", "巷道尽头传来脚步声，越来越近，夹着铁器碰撞。"),
    para("伍", "他把灯芯剪短，屋里更暗了，雨点砸在瓦上。"),
    para("陆", "有人在敲门，很轻，像怕吵醒谁。"),
    para("柒", "他握紧刀柄，指节抵住护手，掌心出了汗。"),
    para("捌", "雨停的时候，天边泛出一点灰白。")
  ].join("\n\n");
  const r = await checkOutlineFulfillment("林风登上城楼点燃烽火号令三军", withFiller(body), { embed: fakeEmbed, isAvailable: always });
  assert.equal(r.checked, true, "应当真的跑了：" + JSON.stringify(r));
  assert.equal(r.unfulfilled.length, 1, "只命中主角名不算兑现，必须报漏写：" + JSON.stringify(r.unfulfilled));
  assert.equal(r.unfulfilled[0].clause, "林风登上城楼点燃烽火号令三军", "报出的应是这条子句");
  assert.equal(r.unfulfilled[0].keywordHit, false, "一字面短路不应再判 keywordHit");
});

test("⑬ 大纲兑现：无关键词但向量达标 → 算兑现（OR 合并，防误报）", async () => {
  __clearVectorCache();
  const body = para("叁", "他数了三枚铜钱，推到柜台另一边，袖口沾了泥。");
  const filler = [
    para("壹", "另一段无关但足够长的文字用来凑块数，免得被字数下限挡住。"),
    para("贰", "第三段同样无关，只是把正文撑到两百字以上，供判定使用。"),
    para("肆", "第四段继续无关，讲的是院墙外的天色和路边的水洼。"),
    para("伍", "第五段还是无关，提到有人从巷口经过，脚步很慢。")
  ].join("\n\n");
  // 子句首字与正文块同标记 → 假嵌入器给同一向量 → 余弦 1.0；且二字组命中比例达不到 40%
  const r = await checkOutlineFulfillment("叁人去楼空", withFiller(body + "\n\n" + filler), { embed: fakeEmbed, isAvailable: always });
  assert.equal(r.checked, true);
  assert.equal(r.unfulfilled.length, 0, "向量达标时应算兑现：" + JSON.stringify(r.unfulfilled));
});

test("⑭ 大纲兑现：方向行过短 / 引擎不可用 → checked:false 且给原因", async () => {
  const body = [
    para("壹", "他推开门，把长刀靠在墙边，然后坐下，很久没有说话。"),
    para("贰", "窗外的风灌进来，烛火晃了一下，影子在墙上散开又聚拢。"),
    para("叁", "她数了三枚铜钱，推到柜台另一边，袖口沾着雨水泥点。"),
    para("肆", "巷道尽头传来脚步声，越来越近，还夹着铁器碰撞的轻响。")
  ].join("\n\n");
  const a = await checkOutlineFulfillment("", withFiller(body), { embed: fakeEmbed, isAvailable: always });
  assert.equal(a.checked, false);
  assert.ok(a.reason.includes("大纲"), "要给原因：" + a.reason);
  const b = await checkOutlineFulfillment("登上城楼点燃烽火", withFiller(body), { embed: fakeEmbed, isAvailable: () => false });
  assert.equal(b.checked, false);
  assert.ok(b.reason.includes("不可用"), "要给原因：" + b.reason);
});

// ---------------------------------------------------------------------------
// 缺陷 #7：查询向量推理异常不得被吞成「最高相似度 0」→ 假报大纲漏写
// ---------------------------------------------------------------------------

test("⑮ 查询向量推理异常：该子句进 skipped（未判定），绝不进 unfulfilled；全部失败 → checked:false", async () => {
  __clearVectorCache();
  const body = [
    para("壹", "另一段无关但足够长的文字用来凑块数，免得被字数下限挡住。"),
    para("贰", "第三段同样无关，只是把正文撑到两百字以上，供判定使用。"),
    para("叁", "他数了三枚铜钱，推到柜台另一边，袖口沾着泥。"),
    para("肆", "第四段继续无关，讲的是院墙外的天色和路边的水洼。"),
    para("伍", "第五段还是无关，提到有人从巷口经过，脚步很慢。")
  ].join("\n\n");
  const text = withFiller(body);
  const direction = "叁人去楼空，登上城楼点燃烽火号令三军";

  // 第 1 条子句的查询能够推理（向量命中「叁」块 → 兑现），第 2 条查询抛错 → 必须进 skipped
  let queries = 0;
  const flaky = (t) => {
    if (String(t).startsWith(QUERY_PREFIX)) {
      queries += 1;
      if (queries === 2) throw new Error("wasm oom");
    }
    return fakeEmbed(t);
  };
  const r = await checkOutlineFulfillment(direction, text, { embed: flaky, isAvailable: always });
  assert.equal(r.checked, true, "只有一条子句未判定时整体仍应 checked:true：" + JSON.stringify(r));
  assert.equal(r.unfulfilled.length, 0, "推理异常的子句不许被当成漏写：" + JSON.stringify(r.unfulfilled));
  assert.equal(r.skipped.length, 1, "推理异常的子句应进 skipped：" + JSON.stringify(r.skipped));
  assert.equal(r.skipped[0].clause, "登上城楼点燃烽火号令三军", "skipped 应是被抛错的那一条：" + JSON.stringify(r.skipped));
  assert.ok(r.skipped[0].reason.includes("未做判定"), "skipped 要说明「没判定」而不是「漏写」：" + r.skipped[0].reason);
  assert.ok(!r.unfulfilled.some((u) => u.clause.includes("烽火")), "unfulfilled 里绝不能出现推理失败的子句");

  // 全部查询推理失败 → 整体不可判定（checked:false），且没有一条被算成漏写
  __clearVectorCache();
  const boomQuery = (t) => {
    if (String(t).startsWith(QUERY_PREFIX)) throw new Error("wasm oom");
    return fakeEmbed(t);
  };
  const r2 = await checkOutlineFulfillment(direction, text, { embed: boomQuery, isAvailable: always });
  assert.equal(r2.checked, false, "全部子句都无法判定时必须 checked:false：" + JSON.stringify(r2));
  assert.ok(r2.reason.includes("推理"), "要给原因：" + r2.reason);
  assert.equal(r2.unfulfilled.length, 0, "全部失败时不许报漏写：" + JSON.stringify(r2.unfulfilled));
  assert.equal(r2.skipped.length, 2, "两条子句都应记为未判定：" + JSON.stringify(r2.skipped));
});

// ---------------------------------------------------------------------------
// 缺陷 #25：块定位游标必须按整块长度推进（只步进 40 字会让行号贴到前一块里）
// ---------------------------------------------------------------------------

test("⑯ 重复语料下块行号按整块推进：18 行同一句 → 末块必须落在第 18 行（旧版只步进 40 字 → 第 8 行）", async () => {
  __clearVectorCache();
  // 50 字一行 × 18 行：chunkText 每 3 行拼成一块（150 字），共 6 块；块首 40 字完全相同。
  // 旧版游标只 +40，下一块会在**前一块内部**命中，行号逐块前移贴到前面，末块只到第 8 行。
  const S = "叁他在雨里站了很久没有作声只是看着水洼里的倒影和远处的灯火明灭不定谁也没有回头凑字数的填充句子用来补";
  assert.equal(S.length, 50, "夹具必须是 50 字一行（3 行 = 一块 150 字）");
  const lines = Array.from({ length: 18 }, () => S);
  const r = await detectSemanticLoop(lines.join("\n"), { embed: fakeEmbed, isAvailable: always });
  assert.equal(r.checked, true, "应当真的跑了：" + JSON.stringify(r));
  assert.equal(r.blocks, 6, "18 行应切成 6 块，实际 " + r.blocks);
  assert.equal(r.loops.length, 1, "整章同一句应报一处打转：" + JSON.stringify(r.loops));
  const loop = r.loops[0];
  assert.equal(loop.fromBlock, 0);
  assert.equal(loop.toBlock, 5);
  assert.equal(loop.lineFrom, 1, "首块应从第 1 行起：" + JSON.stringify(loop));
  assert.equal(loop.lineTo, 18, "末块应到第 18 行（游标按整块推进）；旧版只到第 8 行：" + JSON.stringify(loop));
});

// ---------------------------------------------------------------------------
// 缺陷 #68：detectSemanticLoop 返回体不再带无意义的 degraded: "" 字段
// ---------------------------------------------------------------------------

test("⑰ 返回体不再输出死字段 degraded（缺陷 #68）", async () => {
  __clearVectorCache();
  const S = "灯花爆了一下，他抬手把火苗按灭，屋里彻底黑了。";
  const paras = [
    para("壹", DISTINCT[0]),
    para("贰", DISTINCT[1]),
    para("叁", S),
    para("叁", S),
    para("叁", S),
    para("肆", DISTINCT[2]),
    para("伍", DISTINCT[3]),
    para("陆", DISTINCT[4]),
    para("柒", DISTINCT[5]),
    para("捌", DISTINCT[6])
  ];
  const r = await detectSemanticLoop(paras.join("\n\n"), { embed: fakeEmbed, isAvailable: always });
  assert.equal(r.checked, true);
  assert.ok(r.loops.length > 0, "夹具应报出打转（旧版会在这里塞 degraded: \"\"）");
  assert.equal(Object.hasOwn(r, "degraded"), false, "返回体不应再有 degraded 键：" + JSON.stringify(r));
});