require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { chromium } = require('playwright');
const config = require('./config');
const fs = require('fs');

// Recon крок 4: вкладка "Адреси доставки" (#tab-shipping_addresses) в
// модалці "Новий покупець" — дивимось поля адреси і чи є там окрема
// кнопка збереження. Моніторимо мережеві запити при заповненні полів
// і кліку "Додати" в цій вкладці, щоб зрозуміти momент фактичного
// збереження на бекенді. НЕ натискаємо "Створити замовлення".
fs.mkdirSync('output/debug', { recursive: true });
const logPath = 'output/debug/fill-step4-console.log';
fs.writeFileSync(logPath, '', 'utf-8');
// Пишемо в файл одразу (append), а не буферизуємо в пам'яті — щоб
// нічого не губилось, якщо процес обірветься (напр. апаратний збій).
const log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 2))).join(' ');
  console.log(...args);
  fs.appendFileSync(logPath, line + '\n', 'utf-8');
};

(async () => {
  const browser = await chromium.launch({ headless: config.HEADLESS });
  const context = await browser.newContext({ storageState: config.STORAGE_STATE_PATH });
  const page = await context.newPage();

  const apiCalls = [];
  page.on('request', (req) => {
    const method = req.method();
    if (method === 'GET') return;
    const url = req.url();
    if (!url.includes('api.keycrm.app') && !url.includes('/api/')) return;
    let body = null;
    try { body = req.postData(); } catch (e) {}
    apiCalls.push({ method, url, body, ts: Date.now() });
    log(`[XHR ${method}]`, url, body ? body.slice(0, 400) : '');
  });
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('api.keycrm.app') && !url.includes('/api/')) return;
    if (res.request().method() === 'GET') return;
    log(`[RESP ${res.status()}]`, url);
  });

  await page.goto(config.LEADS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.locator('.icon-menu-orders').first().click();
  await page.waitForTimeout(2000);

  const addBtn = page.locator('button, .el-button, [role="button"]', { hasText: /Додати замовлення/i });
  await addBtn.first().click();
  await page.waitForTimeout(2000);

  const buyerInput = page.locator('input[placeholder*="Пошук за іменем"]').first();
  await buyerInput.click();
  await buyerInput.fill('ТЕСТ Олег recon4');
  await page.waitForTimeout(1500);

  const addNewBuyer = page.locator('text=/Додати нового покупця/i').first();
  await addNewBuyer.click();
  await page.waitForTimeout(1500);

  log('\n--- Клікаю вкладку "Адреси доставки" (#tab-shipping_addresses) ---');
  await page.locator('#tab-shipping_addresses').click();
  await page.waitForTimeout(1500);

  await page.screenshot({ path: 'output/debug/fill-step4-shipping-tab.png', fullPage: false }).catch(() => {});
  const html = await page.content();
  fs.writeFileSync('output/debug/fill-step4-shipping-tab.html', html, 'utf-8');
  log('Скріншот і HTML вкладки "Адреси доставки" збережено.');

  log('\n--- Шукаю кнопку "Додати" всередині вкладки адреси ---');
  const pane = page.locator('#pane-shipping_addresses');
  const paneButtons = await pane.locator('button').allTextContents();
  log('Кнопки у вкладці адреси:', JSON.stringify(paneButtons.map((b) => b.trim()).filter(Boolean)));

  log('\n--- Пробую клікнути "+ Додати адресу" (якщо є) ---');
  const addAddressBtn = pane.locator('button, [role="button"]', { hasText: /Додати/i }).first();
  const addAddressCount = await addAddressBtn.count();
  log('Кандидатів на "додати адресу":', addAddressCount);
  const apiCountBeforeAddClick = apiCalls.length;
  if (addAddressCount > 0) {
    await addAddressBtn.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'output/debug/fill-step4-address-form.png', fullPage: false }).catch(() => {});
    const html2 = await page.content();
    fs.writeFileSync('output/debug/fill-step4-address-form.html', html2, 'utf-8');
    log('API-викликів після кліку "додати адресу":', apiCalls.length - apiCountBeforeAddClick);
  }

  log('\nЗалишаю браузер відкритим 15с для ручного огляду...');
  await page.waitForTimeout(15000);

  log('\n=== Усі перехоплені API-виклики ===');
  log(JSON.stringify(apiCalls, null, 2));
  fs.writeFileSync('output/debug/fill-step4-api-calls.json', JSON.stringify(apiCalls, null, 2), 'utf-8');

  await browser.close();
})().catch((e) => { log('FATAL ERROR:', e.message, e.stack); process.exit(1); });
