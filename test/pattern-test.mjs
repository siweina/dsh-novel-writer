import { readFile } from "node:fs/promises";
import { analyzePattern, classifySentence, splitSentences } from "file:///D:/Deep%20Seek%E6%8F%92%E4%BB%B6%E5%BA%93/novel-writer/lib/pattern.js";

const dir = "D:/Deep Seek插件库/novels/予虫神";
const files = ["原稿件-予虫神 第一章.txt", "原稿件-予虫神 第二章.txt", "原稿件-予虫神 第三章.txt"];
let text = "";
for (const f of files) text += (await readFile(`${dir}/${f}`, "utf8")) + "\n";
console.log("句子总数:", splitSentences(text).length);
const a = analyzePattern(text, { top: 8 });
console.log("占比:", JSON.stringify(a.ratios));
console.log("高频组合:", a.topPatterns.slice(0, 5).map((p) => `${p.pattern}×${p.count}`).join(" "));
console.log("压缩序列(前160字):", a.sequence.slice(0, 160));
console.log("--- 分类抽查 ---");
const samples = [
  "她已经在等一个人，等了整整三天。",
  "那人却像是没有听见。",
  "窗外风急，雨打芭蕉。",
  "难道就这样算了？",
  "「小姐，先歇下吧。」",
  "她心里一紧，想起当年那场大火。",
  "他怔了怔，说不出话来。",
  "「你迟了。」",
  "庙外，天边滚过一声闷雷。",
  "你怎么能这样对我？"
];
for (const s of samples) console.log(classifySentence(s), "<=", s.slice(0, 24));
