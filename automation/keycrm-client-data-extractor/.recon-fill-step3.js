require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { chromium } = require('playwright');
const config = require('./config');
const fs = require('fs');

// Recon крок 3: у модалці "Новий покупець" — дивимось другу вкладку
// (іконка-піна, ймовірно "Адреса доставки"), і моніторимо мережеві
// запити, щоб зрозуміти, чи поля зберігаються миттєво (autosave через
// API при зміні/blur), чи лише при натисканні кнопки "Додати"/
// "Створити замовлення". Кнопку "Створити замовлення" НЕ натискаємо.
fs.mkdirSync('output/debug', { recursive: true });
const logPath = 'output/debug/fill-step3-console.log';
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
    log(`[XHR ${method}]`, url, body ? body.slice(0, 300) : '');
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
  await buyerInput.fill('ТЕСТ Олег recon3');
  await page.waitForTimeout(1500);

  const addNewBuyer = page.locator('text=/Додати нового покупця/i').first();
  await addNewBuyer.click();
  await page.waitForTimeout(1500);

  log('\n--- Заповнюю поле "Повне ім\'я" в модалці нового покупця (перевірка autosave на blur) ---');
  const nameInput = page.locator('input').filter({ hasText: '' }).first();
  // Точніше: за лейблом "Повне ім'я" беремо найближчий input
  const fullNameInput = page.locator('input[value*="ТЕСТ"], input').first();
  await page.screenshot({ path: 'output/debug/fill-step3-new-buyer-general.png', fullPage: false }).catch(() => {});

  const apiCallsBeforeBlur = apiCalls.length;
  await page.keyboard.press('Tab'); // blur з поля імені
  await page.waitForTimeout(1200);
  log('API-викликів після blur поля імені:', apiCalls.length - apiCallsBeforeBlur);

  log('\n--- Клікаю другу вкладку (іконка-піна) в модалці нового покупця ---');
  const tabs = page.locator('.el-dialog, [class*="modal"], [role="dialog"]').last().locator('svg, i, [class*="icon"]');
  const tabCount = await tabs.count();
  log('Кандидатів на іконки-вкладки:', tabCount);

  // Пробуємо клікнути по другій іконці у верхній частині модалки (біля "Загальне")
  const dialogHeaderIcons = page.locator('div').filter({ hasText: /^Загальне$/ }).first();
  let clicked = false;
  try {
    // іконки зазвичай перед написом "Загальне", беремо контейнер і шукаємо клікабельні елементи ліворуч
    const container = page.locator('[class*="dialog"], [class*="modal"]').last();
    const clickableIcons = container.locator('svg, i[class*="icon"], span[class*="icon"]');
    const n = await clickableIcons.count();
    log('Клікабельних іконок у контейнері:', n);
    for (let i = 0; i < n; i++) {
      const box = await clickableIcons.nth(i).boundingBox().catch(() => null);
      if (box) log(`  icon[${i}] bbox:`, JSON.stringify(box));
    }
  } catch (e) {
    log('Помилка пошуку іконок:', e.message);
  }

  await page.screenshot({ path: 'output/debug/fill-step3-before-tab-click.png', fullPage: false }).catch(() => {});
  const html = await page.content();
  fs.writeFileSync('output/debug/fill-step3-new-buyer-modal.html', html, 'utf-8');

  log('\nЗалишаю браузер відкритим 15с для ручного огляду (можна вручну клікнути вкладку адреси)...');
  await page.waitForTimeout(15000);

  await page.screenshot({ path: 'output/debug/fill-step3-after-wait.png', fullPage: false }).catch(() => {});
  log('\n=== Усі перехоплені API-виклики ===');
  log(JSON.stringify(apiCalls, null, 2));
  fs.writeFileSync('output/debug/fill-step3-api-calls.json', JSON.stringify(apiCalls, null, 2), 'utf-8');

  await browser.close();
})().catch((e) => { log('FATAL ERROR:', e.message, e.stack); process.exit(1); });
