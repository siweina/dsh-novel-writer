/**
 * 验证假设：菜单打不开，是因为「滚动即关闭」的监听被 Playwright 的自动滚动触发。
 * 做法：先手动把触发器滚进视口（此后 click 不再需要滚动），再点开。
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotClient, vendorReact, HERE } from './prepare.mjs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PW = 'C:\\Users\\zg\\.dsh\\profiles\\desktop\\node_modules\\playwright';
snapshotClient(); vendorReact();
const pw = await import(pathToFileURL(join(PW, 'index.js')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);
const browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-gpu', '--no-first-run'] });
const ctx = await browser.newContext({ viewport: { width: 1268, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce', locale: 'zh-CN', bypassCSP: true });
const page = await ctx.newPage();
await page.goto(pathToFileURL(join(HERE, 'fixture.html')).href, { waitUntil: 'load' });
await page.waitForFunction('window.__NW_READY_STATE__ !== undefined', null, { timeout: 15000 });
await page.evaluate((v) => window.__NW__.gotoView(v), 'lexicon');
await page.waitForTimeout(400);

const trig = page.locator('button.nwSelTrigger').first();
await trig.scrollIntoViewIfNeeded();      // ← 先滚好，让 click 不再需要滚动
await page.waitForTimeout(300);

const before = await page.locator('div.nwSelMenu').count();
await trig.click();
await page.waitForTimeout(300);
const after = await page.locator('div.nwSelMenu').count();
console.log('  预先滚动后：点击前菜单数 =', before, '| 点击后 =', after, after === 1 ? '✓ 菜单能开（假设成立：是自动滚动把它关掉的）' : '✗ 仍打不开，另有原因');

// 再验证「滚动确实会关闭菜单」（这是设计行为，不是 bug）
if (after === 1) {
  await page.mouse.wheel(0, 40);
  await page.waitForTimeout(250);
  console.log('  滚动后菜单数 =', await page.locator('div.nwSelMenu').count(), '（滚动即关闭 = 设计行为）');
}
await browser.close();
