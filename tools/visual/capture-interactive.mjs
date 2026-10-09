/**
 * 交互态拍摄：拍**展开的下拉框**（capture.mjs 只拍闭合态，而"展开好不好看"正是这次要验的）。
 * 另拍「书库根」行（已由 fixture 补上 root/rootSource）。
 *
 * 用法：node capture-interactive.mjs [--out 目录]
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { snapshotClient, vendorReact, HERE } from './prepare.mjs';

const CHROME = process.env.NW_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PLAYWRIGHT_DIR = process.env.NW_PLAYWRIGHT || 'C:\\Users\\zg\\.dsh\\profiles\\desktop\\node_modules\\playwright';
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };
const OUT = resolve(HERE, argVal('--out') || 'shots-interactive');
const WIDTH = Number(argVal('--width') || 1268);   // 真实面板宽度
const H = 900;

snapshotClient();
vendorReact();

const pw = await import(pathToFileURL(join(PLAYWRIGHT_DIR, 'index.js')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);
if (!chromium) { console.error('拿不到 chromium'); process.exit(1); }

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-gpu', '--no-first-run', '--disable-extensions'] });
const ctx = await browser.newContext({
  viewport: { width: WIDTH, height: H }, deviceScaleFactor: 1, colorScheme: 'light',
  reducedMotion: 'reduce', locale: 'zh-CN', timezoneId: 'Asia/Shanghai', bypassCSP: true
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
await page.goto(pathToFileURL(join(HERE, 'fixture.html')).href, { waitUntil: 'load' });
await page.waitForFunction('window.__NW_READY_STATE__ !== undefined', null, { timeout: 15000 });

const shot = async (name, clip) => {
  const file = join(OUT, name);
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  console.log('  [shot] ' + name);
};

// ---------- ① 词表视图：下拉框闭合态 ----------
await page.evaluate((v) => window.__NW__.gotoView(v), 'lexicon');
await page.waitForTimeout(300);
const trig = page.locator('button.nwSelTrigger').first();
const box = await trig.boundingBox();
if (!box) { console.error('✗ 找不到下拉触发器'); process.exit(1); }
// 触发器周围区域（含弹层要占的位置）
const clip = { x: Math.max(0, box.x - 320), y: Math.max(0, box.y - 40), width: Math.min(WIDTH, 640), height: 460 };
await shot(`dropdown-closed-${WIDTH}.png`, clip);

// ---------- ② 点开它 ----------
await trig.click();
await page.waitForTimeout(250);
const menuVisible = await page.locator('div.nwSelMenu').count();
console.log('  展开后菜单节点数 =', menuVisible);
await shot(`dropdown-open-${WIDTH}.png`, clip);
const openFull = join(OUT, `dropdown-open-full-${WIDTH}.png`);
await page.screenshot({ path: openFull });
console.log('  [shot] dropdown-open-full-' + WIDTH + '.png');

// ---------- ③ 键盘：下移一格再回车，确认能选中且菜单关闭 ----------
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(120);
await shot(`dropdown-keynav-${WIDTH}.png`, clip);
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
console.log('  Esc 后菜单节点数 =', await page.locator('div.nwSelMenu').count());

// ---------- ④ 词表视图：书库根行（v6.4.0 起根行只在词表面板里）----------
// 注意：此时仍在 lexicon 视图（上面 ③ 只是按了 Esc）
await page.evaluate((v) => window.__NW__.gotoView(v), 'lexicon');
await page.waitForTimeout(350);
const rootRow = page.locator('.nwRootRow').first();
if (await rootRow.count()) {
  // 根行在词表卡片下方，先滚进视口再裁，否则截图会被视口底边截断
  await rootRow.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const rb = await rootRow.boundingBox();
  await shot(`root-row-${WIDTH}.png`, rb ? { x: 0, y: Math.max(0, rb.y - 60), width: WIDTH, height: Math.min(H - Math.max(0, rb.y - 60), 420) } : undefined);
  console.log('  书库根行文本: ' + (await rootRow.innerText()).replace(/\s+/g, ' ').slice(0, 160));
} else {
  console.log('  ⚠ 词表视图里没找到 .nwRootRow');
}
await page.screenshot({ path: join(OUT, `lexicon-full-${WIDTH}.png`) });

// ---------- ⑤ 主视图：确认根行**已从主页移除** ----------
await page.evaluate((v) => window.__NW__.gotoView(v), 'main');
await page.waitForTimeout(350);
const rootOnMain = await page.locator('.nwRootRow').count();
console.log('  主视图里的 .nwRootRow 数量（应为 0）: ' + rootOnMain + (rootOnMain === 0 ? ' ✓' : ' ✗ 还在主页！'));
await page.screenshot({ path: join(OUT, `main-full-${WIDTH}.png`) });

await browser.close();
console.log('\nconsole 错误: ' + (errors.length ? errors.join(' | ') : '无'));
console.log('产物目录: ' + OUT);
