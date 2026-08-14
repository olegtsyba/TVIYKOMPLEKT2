require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { chromium } = require('playwright');
const config = require('./config');
const fs = require('fs');

// Recon крок 1: знайти модуль "Замовлення" (не Ліди) і кнопку створення
// нового замовлення. Нічого не створюємо і не зберігаємо на цьому кроці —
// лише дивимось UI.
(async () => {
  const browser = await chromium.launch({ headless: config.HEADLESS });
  const context = await browser.newContext({ storageState: config.STORAGE_STATE_PATH });
  const page = await context.newPage();

  console.log('Переходжу на', config.LEADS_URL || (config.BASE_URL + '/app/leads'));
  await page.goto(config.LEADS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  fs.mkdirSync('output/debug', { recursive: true });
  await page.screenshot({ path: 'output/debug/fill-step1-app-root.png', fullPage: true }).catch(() => {});
  console.log('URL:', page.url());

  // Сайдбар (SPA, Vue router) — елементи навігації можуть бути не <a>, а div/li з click-хендлером.
  const navItems = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('[class*="sidebar"] *, [class*="menu"] *, [class*="nav"] *')];
    const seen = new Set();
    const out = [];
    for (const el of candidates) {
      if (el.children.length > 0) continue; // листові елементи
      const cls = el.className && typeof el.className === 'string' ? el.className : '';
      const key = cls + '|' + (el.getAttribute('title') || '');
      if (seen.has(key)) continue;
      seen.add(key);
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      out.push({ tag: el.tagName, cls, title: el.getAttribute('title'), text: el.textContent.trim().slice(0, 40), x: Math.round(rect.x), y: Math.round(rect.y) });
    }
    return out.slice(0, 60);
  });
  console.log('Елементи навігації:', JSON.stringify(navItems, null, 2));

  console.log('\nКлікаю іконку "Замовлення" (icon-menu-orders)...');
  await page.locator('.icon-menu-orders').first().click();
  await page.waitForTimeout(2500);
  console.log('URL після кліку:', page.url());
  await page.screenshot({ path: 'output/debug/fill-step1-orders-page.png', fullPage: true }).catch(() => {});

  const addBtn = page.locator('button, .el-button, [role="button"]', { hasText: /Додати замовлення/i });
  const addCount = await addBtn.count();
  console.log('Кандидатів на кнопку "Додати замовлення":', addCount);

  if (addCount > 0) {
    await addBtn.first().click();
    await page.waitForTimeout(2500);
    console.log('URL після кліку "Додати замовлення":', page.url());
    await page.screenshot({ path: 'output/debug/fill-step1-create-order-form.png', fullPage: true }).catch(() => {});
    const html = await page.content();
    fs.writeFileSync('output/debug/fill-step1-create-order-form.html', html, 'utf-8');
    console.log('Скріншот і HTML форми створення збережено.');
  }

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
