import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findChapter, readSettings } from "../lib/core.js";
import { buildChapterBrief } from "../lib/brief.js";
import { buildFixPlan, verifyFixPlan } from "../lib/fixplan.js";
import { buildStoryGraph } from "../lib/graph.js";

async function withBook(run) {
  const root = await mkdtemp(join(tmpdir(), "dsh-core-regression-"));
  const book = "测试书";
  const chapterDir = join(root, "novels", book);
  await mkdir(chapterDir, { recursive: true });
  try {
    await run({ root, book, chapterDir, dataDir: join(root, ".novel-writer") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSettings(root, book, data) {
  const dir = join(root, ".novel-writer", "settings");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, book + ".json"), JSON.stringify(data), "utf8");
}

test("complete chapter filenames win and ambiguous stems fail", () => {
  const chapters = [
    { file: "第01章.md", number: 1, title: "" },
    { file: "第01章.txt", number: 1, title: "" }
  ];
  assert.equal(findChapter(chapters, "第01章.txt"), chapters[1]);
  assert.equal(findChapter(chapters, "第01章.md"), chapters[0]);
  assert.throws(() => findChapter(chapters, "第01章"), /第01章\.md.*第01章\.txt/);
  assert.equal(findChapter(chapters, "第01章.markdown"), undefined);
});

test("verify compares all findings, including those beyond the display limit", async () => {
  await withBook(async ({ root, book, chapterDir }) => {
    const file = join(chapterDir, "第01章.md");
    const addedWords = Array.from({ length: 12 }, (_, i) => "NEWTOKEN" + i);
    await writeSettings(root, book, { worldview: [{ name: "规范", bannedWords: [...addedWords, "OLDTOKEN"] }] });
    await writeFile(file, "前文。\n\n继续。\n\nOLDTOKEN 仍在这一章。", "utf8");
    const first = await buildFixPlan(root, book, "第01章.md", {});
    assert.equal(first.items.length, 1);
    await writeFile(file, addedWords.join(" ") + "\n\n继续。\n\nOLDTOKEN 仍在这一章。", "utf8");
    const result = await verifyFixPlan(root, book, "第01章.md", {});
    assert.equal(result.checked.find((item) => item.id === first.items[0].id)?.status, "pending");
    assert.equal(result.checked.filter((item) => item.status === "new").length, 12);
  });
});

test("verify does not pair different banned words by type", async () => {
  await withBook(async ({ root, book, chapterDir }) => {
    const file = join(chapterDir, "第01章.md");
    await writeSettings(root, book, { worldview: [{ name: "规范", bannedWords: ["OLDTOKEN", "NEWTOKEN"] }] });
    await writeFile(file, "OLDTOKEN 在正文中。", "utf8");
    const first = await buildFixPlan(root, book, "第01章.md", {});
    await writeFile(file, "NEWTOKEN 在正文中。", "utf8");
    const result = await verifyFixPlan(root, book, "第01章.md", {});
    assert.equal(result.checked.find((item) => item.id === first.items[0].id)?.status, "resolved");
    assert.equal(result.checked.filter((item) => item.status === "new").length, 1);
  });
});

test("brief does not treat a relative's death as the character's death", async () => {
  await withBook(async ({ root, book, chapterDir }) => {
    await writeFile(join(chapterDir, "第01章.md"), "张三正在调查父亲死亡真相。", "utf8");
    await writeSettings(root, book, { characters: [{ name: "张三", description: "调查父亲死亡真相" }] });
    const living = await buildChapterBrief(root, book, "next", {});
    assert.equal(living.characters.find((item) => item.name === "张三")?.offstage, undefined);
    assert.equal(living.avoid.some((item) => item.kind === "已退场角色"), false);
    await writeSettings(root, book, { characters: [{ name: "张三", status: "已死", description: "调查父亲死亡真相" }] });
    const dead = await buildChapterBrief(root, book, "next", {});
    assert.equal(dead.characters.find((item) => item.name === "张三")?.offstage, true);
  });
});

test("graph distinguishes corrupt settings from missing settings", async () => {
  await withBook(async ({ root, book, chapterDir, dataDir }) => {
    await writeFile(join(chapterDir, "第01章.md"), "正文。", "utf8");
    const missing = await buildStoryGraph(root, book, {});
    assert.equal(missing.degraded.some((item) => item.includes("设定表读取失败")), false);
    const dir = join(dataDir, "settings");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, book + ".json"), "{broken", "utf8");
    const corrupt = await buildStoryGraph(root, book, {});
    assert.equal(corrupt.degraded.some((item) => item.includes("设定表读取失败")), true);
    await assert.rejects(readSettings(root, book, { strict: true }), SyntaxError);
  });
});

test("fix plan reports corrupt settings instead of calling them unregistered", async () => {
  await withBook(async ({ root, book, chapterDir, dataDir }) => {
    await writeFile(join(chapterDir, "第01章.md"), "这是一段测试正文。", "utf8");
    const dir = join(dataDir, "settings");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, book + ".json"), "{broken", "utf8");
    const plan = await buildFixPlan(root, book, "第01章.md", {});
    assert.match(plan.summary, /设定表读取失败/);
    assert.doesNotMatch(plan.summary, /未登记 worldview/);
    const verify = await verifyFixPlan(root, book, "第01章.md", {});
    assert.match(verify.summary, /设定表读取失败/);
  });
});

test("verify retains setting-dependent items when settings cannot be read", async () => {
  await withBook(async ({ root, book, chapterDir, dataDir }) => {
    await writeFile(join(chapterDir, "第01章.md"), "OLDTOKEN 和 HONORWORD 出现在正文中。", "utf8");
    await writeSettings(root, book, {
      worldview: [{ name: "规范", bannedWords: ["OLDTOKEN"], speechStyle: { honorBad: ["HONORWORD"] } }]
    });
    const plan = await buildFixPlan(root, book, "第01章.md", {});
    assert.deepEqual(new Set(plan.items.map((item) => item.type)), new Set(["禁用词", "语用不符"]));
    await writeFile(join(chapterDir, "第01章.md"), "正文已改写，不再含原来的用语。", "utf8");
    await writeFile(join(dataDir, "settings", book + ".json"), "{broken", "utf8");
    const verify = await verifyFixPlan(root, book, "第01章.md", {});
    assert.equal(verify.checked.length, 2);
    assert.ok(verify.checked.every((item) => item.status === "pending" && item.detail.includes("无法复测")));
    assert.match(verify.summary, /设定表读取失败/);
    assert.doesNotMatch(verify.summary, /已解决 [1-9]/);
  });
});

test("verify reads legacy plots without migrating them or writing an analysis cache", async () => {
  await withBook(async ({ root, book, chapterDir, dataDir }) => {
    for (let n = 1; n <= 3; n += 1) {
      await writeFile(join(chapterDir, `第0${n}章.md`), "这是一段足够长的章节正文，人物走过院子，打开门，看见屋内的灯仍然亮着。".repeat(2), "utf8");
    }
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, book + ".json"), JSON.stringify({ entries: [{ id: "p1", content: "旧伏笔", status: "open", chapter: "第01章" }] }), "utf8");
    await verifyFixPlan(root, book, "第03章.md", {});
    await assert.rejects(readFile(join(dataDir, "plots", book + ".json"), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(join(dataDir, "analysis", book + "-chapters-metrics.json"), "utf8"), { code: "ENOENT" });
  });
});
