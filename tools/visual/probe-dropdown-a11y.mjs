/**
 * 直接问浏览器：下拉菜单展开后，**键盘高亮那一行**与菜单底色的实际计算值差多少？
 * （capture-interactive 的两张截图肉眼看不出差别，需要量化确认。）
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotClient, vendorReact, HERE } from './prepare.mjs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PW = 'C:\\Users\\zg\\.dsh\\profiles\\desktop\\node_modules\\playwright';
snapshotClient(); vendorReact();
const pw = await import(pathToFileURL(join(PW, 'index.js')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

for (const scheme of ['light', 'dark']) {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-gpu', '--no-first-run'] });
  const ctx = await browser.newContext({ viewport: { width: 1268, height: 900 }, colorScheme: scheme, reducedMotion: 'reduce', locale: 'zh-CN', bypassCSP: true });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(join(HERE, 'fixture.html')).href, { waitUntil: 'load' });
  await page.waitForFunction('window.__NW_READY_STATE__ !== undefined', null, { timeout: 15000 });
  await page.evaluate((v) => window.__NW__.gotoView(v), 'lexicon');
  await page.waitForTimeout(250);
  await page.locator('button.nwSelTrigger').first().click();
  await page.waitForTimeout(200);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(200);

  const r = await page.evaluate(() => {
    const menu = document.querySelector('div.nwSelMenu');
    const opts = [...document.querySelectorAll('div.nwSelMenu .nwSelOpt, div.nwSelMenu [role=option]')];
    const act = opts.find((o) => o.className.indexOf('nwSelOptAct') >= 0);
    const cnt = (el, p) => (el ? getComputedStyle(el)[p] : '(无)');
    return {
      optCount: opts.length,
      optClasses: opts.map((o) => o.className),
      menuBg: cnt(menu, 'backgroundColor'),
      actFound: !!act,
      actBg: cnt(act, 'backgroundColor'),
      actText: act ? act.innerText.trim().slice(0, 20) : '(无)',
      selFound: opts.some((o) => o.className.indexOf('nwSelOptSel') >= 0),
      tokenHover: getComputedStyle(document.body).getPropertyValue('--dsw-alias-interactive-bg-hover').trim(),
      tokenLayer2: getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-layer-3').trim()
    };
  });
  console.log('=== ' + scheme + ' ===');
  console.log('  选项数:', r.optCount, '| 高亮行找到:', r.actFound, r.actFound ? '（' + r.actText + '）' : '');
  console.log('  菜单底色   :', r.menuBg);
  console.log('  高亮行底色 :', r.actBg, r.actBg === r.menuBg ? '  ← ⚠️ 与菜单底色相同 = 高亮不可见！' : '  ← 有差别 ✓');
  console.log('  --dsw-alias-interactive-bg-hover =', r.tokenHover, '| --dsw-alias-bg-layer-3 =', r.tokenLayer2);
  await browser.close();
}
