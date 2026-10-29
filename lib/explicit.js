/**
 * v6.9.0：**直白度 / 淡化标记**度量（纯规则、零 token、不调模型）。
 *
 * 为什么需要它：非净化模式（rawWriting）此前只是往系统提示里加一段话——
 * 用户没法判断它到底有没有生效，反馈原话是「开了好像跟没开一样」。
 * 本模块给这件事一个**可核对的数字**：一篇正文里有多少处「把正在发生的场面淡化/跳过去」的写法，
 * 以及这一章相对原著基线的密度差。它不生成任何内容，只测量（与插件其它部分同一立场）。
 *
 * 口径说明（避免"数字看起来很准其实没意义"）：
 *   · 密度分母是**去空白后的字符数**，单位「处/千字」；
 *   · 只数**明确的淡化写法**（省略号整段、明示跳过、时间跳/黑场、代称替代、跳出场景的评论），
 *     不数"比喻多""句子长"这类风格差异——那属于六维基线，不在这里重复计分；
 *   · 这是**启发式**：它不能证明"写得够直白"，只能提示"这里被绕过去了"，
 *     供模型自查与作者判断，不当作质量评分。
 */

/** 淡化写法清单：id 稳定（测试与渲染按 id 取），label 给人看 */
export const SOFTENING_RULES = Object.freeze([
  { id: "ellipsis", label: "整段省略号", re: /^[\s…\.。·—\-]{2,}$/gm },
  { id: "skipPhrase", label: "明示跳过/不写", re: /此处省略|一笔带过|略过|跳过|按下不表|不作赘述|不宜(?:展开|细写)|不便(?:描写|展开)|自行想象|自行脑补|留白处理/g },
  { id: "timeJump", label: "时间跳/黑场", re: /不知(?:过了|不觉)?多久|再(?:次)?醒来(?:时|后)?已|一觉醒来|翌日(?:清晨|醒来)?|事后|等到.{0,6}(?:结束|平息|散去|停下)|红烛燃尽|烛火熄灭|天光大亮|东方既白|不知折腾到几时|后半夜才(?:歇下|睡去)|次日日上三竿/g },
  { id: "euphemism", label: "代称/隐喻替代", re: /云雨|不可描述|那件事|那种事|亲密(?:过后|之后)|事毕|鱼水之欢|一番(?:云雨|折腾|翻云覆雨|缠绵|温存)|巫山|共赴巫山|水乳交融|抵死缠绵|春风一度|红浪翻滚|衣衫尽褪.{0,10}春光|满室旖旎|共效于飞|坦诚相见|极尽缠绵/g },
  { id: "metaComment", label: "跳出场景的评论/免责", re: /作为(?:一个)?(?:AI|人工智能|语言模型)|我(?:无法|不能|不便)(?:描写|展开|写|细写)|(?:这|此)(?:一)?段(?:我)?不(?:展开|写|细写)|这类内容(?:不宜|不适合)|点到为止|保持(?:含蓄|克制)|此处不展开|由于(?:安全|合规|平台|内容)(?:限制|策略|规范)|无法继续生成|少儿不宜|和谐处理|拉灯/g },
  { id: "english", label: "英文淡化写法", re: /fade[sd]? to black|skip(?:ping)? (?:that|this) (?:part|scene)|not (?:able|going) to (?:describe|write)|implied only/gi }
]);

/** 只用于"模型在动笔时自己刹住"的那几类（P1 兜底用；不含时间跳与代称——那两类也可能是正常叙事手法） */
export const SOFT_STOP_RULE_IDS = Object.freeze(["skipPhrase", "metaComment", "english"]);

function clip(value, max) {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * 量一篇正文的直白度。
 * @returns {{
 *   chars: number, lines: number, dialogueRatio: number,
 *   softening: { total: number, per1000: number, items: Array<{ id: string, label: string, count: number, samples: string[] }> }
 * }}
 */
export function measureExplicitness(text) {
  const raw = String(text ?? "");
  const chars = raw.replace(/\s+/g, "").length;
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  const dialogueLines = lines.filter((l) => /[「」“”"]/.test(l)).length;
  const items = [];
  let total = 0;
  for (const rule of SOFTENING_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g");
    const samples = [];
    let count = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      count += 1;
      if (samples.length < 3) samples.push(clip(raw.slice(Math.max(0, m.index - 12), m.index + 24), 40));
      if (m.index === re.lastIndex) re.lastIndex += 1; // 零宽命中的死循环兜底
      if (count > 5000) break; // 病态输入保护
    }
    if (count > 0) {
      total += count;
      items.push({ id: rule.id, label: rule.label, count, samples });
    }
  }
  return {
    chars,
    lines: lines.length,
    dialogueRatio: lines.length > 0 ? round2(dialogueLines / lines.length) : 0,
    softening: {
      total,
      per1000: chars > 0 ? round2((total / chars) * 1000) : 0,
      items
    }
  };
}

/**
 * 本章 vs 原著基线。
 * verdict 只看淡化密度（`ratio` = 本章/基线），对话占比变化只作参考信息：
 * 「对话少」不等于「写得隐晦」，不能拿它下结论，只在报告里并列出来。
 */
export function compareExplicitness(target, baseline) {
  const t = target && target.softening ? target : measureExplicitness("");
  const b = baseline && baseline.softening ? baseline : measureExplicitness("");
  const tPer = t.softening.per1000;
  const bPer = b.softening.per1000;
  // 基线为 0 时比值无意义：本章只要出现淡化就算「新增」，否则算「干净」
  const ratio = bPer > 0 ? round2(tPer / bPer) : (tPer > 0 ? null : 1);
  let verdict;
  if (t.softening.total === 0) verdict = "clean";
  else if (ratio === null) verdict = "new";
  else if (ratio >= 2) verdict = "much-softer";
  else if (ratio >= 1.3) verdict = "softer";
  else if (ratio <= 0.6) verdict = "more-explicit";
  else verdict = "similar";
  return {
    chapter: { chars: t.chars, total: t.softening.total, per1000: tPer, dialogueRatio: t.dialogueRatio },
    baseline: { chars: b.chars, total: b.softening.total, per1000: bPer, dialogueRatio: b.dialogueRatio },
    ratio,
    verdict,
    items: t.softening.items,
    note: verdictNote(verdict, tPer, bPer, ratio)
  };
}

function verdictNote(verdict, tPer, bPer, ratio) {
  switch (verdict) {
    case "clean":
      return "本章没有检出淡化写法（省略号整段 / 明示跳过 / 时间跳 / 代称替代 / 跳出场景的评论）。";
    case "new":
      return "原著基线里没有这类写法，本章出现了 " + tPer + " 处/千字——若是刻意为之可以保留，否则回看这几处是不是把场面绕过去了。";
    case "much-softer":
      return "本章的淡化密度是原著的 " + ratio + " 倍（" + tPer + " vs " + bPer + " 处/千字），明显更含蓄——非净化模式下应回到场景里写。";
    case "softer":
      return "本章比原著略含蓄（" + ratio + " 倍，" + tPer + " vs " + bPer + " 处/千字）。";
    case "more-explicit":
      return "本章比原著更直白（" + ratio + " 倍，" + tPer + " vs " + bPer + " 处/千字）。";
    default:
      return "本章与原著的淡化密度接近（" + tPer + " vs " + bPer + " 处/千字）。";
  }
}

/**
 * P1 兜底用：判断一段**模型输出开头**是不是"在动笔时自己刹住了"。
 * 只认 `SOFT_STOP_RULE_IDS`（明示跳过 / 跳出场景的评论 / 英文淡化），
 * 不认时间跳与代称——那两类在正常叙事里也常见，误判会让重试变噪音。
 */
export function looksLikeSoftStop(text) {
  const head = String(text ?? "").slice(0, 600);
  if (head.trim() === "") return false;
  for (const rule of SOFTENING_RULES) {
    if (!SOFT_STOP_RULE_IDS.includes(rule.id)) continue;
    const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g");
    if (re.test(head)) return true;
  }
  return false;
}
