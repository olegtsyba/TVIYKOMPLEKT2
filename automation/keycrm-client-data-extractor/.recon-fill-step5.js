require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { chromium } = require('playwright');
const config = require('./config');
const fs = require('fs');

// Recon крок 5: контрольований тест моменту сабміту форми "Новий покупець".
// Той самий безпечний прийом, що й у keycrm-leads-classifier/.recon-apply-step2.js
// (recon кнопки "Відхилити лід"): route.abort() вмикаємо ЛИШЕ безпосередньо
// перед кліком на фінальну кнопку збереження drawer'а покупця, щоб побачити
// URL/метод/payload наміру, не даючи запиту реально піти на бекенд і
// створити тестового покупця в бойовій базі.
fs.mkdirSync('output/debug', { recursive: true });
const logPath = 'output/debug/fill-step5-console.log';
fs.writeFileSync(logPath, '', 'utf-8');
const log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 2))).join(' ');
  console.log(...args);
  fs.appendFileSync(logPath, line + '\n', 'utf-8');
};

(async () => {
  const browser = await chromium.launch({ headless: config.HEADLESS });
  const context = await browser.newContext({ storageState: config.STORAGE_STATE_PATH });
  const page = await context.newPage();

  const capturedRequests = [];
  // Перехоплення вмикаємо тільки пізніше (безпосередньо перед кліком на
  // фінальну кнопку) — сторінка сама активно ходить на бекенд під час
  // завантаження дошки/форм, і блокування з самого початку ламає рендер.

  await page.goto(config.LEADS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.locator('.icon-menu-orders').first().click();
  await page.waitForTimeout(2000);
  // Клік по іконці відкриває hover-флайаут підменю бічної панелі — відводимо
  // курсор у центр сторінки, щоб він закрився і не перекривав контент.
  await page.mouse.move(700, 400);
  await page.waitForTimeout(1000);
  await page.locator('.vld-background').first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  await page.locator('.key-page__aside-overlay').first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'output/debug/fill-step5-orders-page-before-add.png', fullPage: false }).catch(() => {});

  const addBtn = page.locator('button, .el-button, [role="button"]', { hasText: /Додати замовлення/i });
  await addBtn.first().click({ timeout: 15000 });
  await page.waitForTimeout(2000);

  const buyerInput = page.locator('input[placeholder*="Пошук за іменем"]').first();
  await buyerInput.click();
  await buyerInput.fill('ТЕСТ Олег recon5');
  await page.waitForTimeout(1500);

  const addNewBuyer = page.locator('text=/Додати нового покупця/i').first();
  await addNewBuyer.click();
  await page.waitForTimeout(1500);

  const drawer = page.locator('.el-drawer.rtl:visible, .el-drawer:visible', { hasText: /Новий покупець/i }).last();
  await drawer.waitFor({ state: 'visible', timeout: 10000 });
  log('Drawer "Новий покупець" видимий.');

  log('\n--- Заповнюю поле "Повне ім\'я" в drawer\'і покупця ---');
  const nameInput = drawer.locator('input').first();
  await nameInput.click();
  await nameInput.fill('ТЕСТ Олег recon5');
  await page.waitForTimeout(300);

  // Поле телефону — маскований інпут, другий за порядком у drawer (перший — ПІБ).
  const phoneInput = drawer.locator('input').nth(1);
  const phoneCount = await phoneInput.count();
  if (phoneCount > 0) {
    await phoneInput.click();
    await phoneInput.fill('991234567');
    await page.waitForTimeout(300);
  }
  log('Поля ПІБ/телефон заповнені (телефон-інпутів знайдено:', phoneCount, ').');

  log('\n--- Перелік кнопок у drawer\'і покупця (щоб знайти фінальну кнопку збереження) ---');
  const allButtons = drawer.locator('button');
  const buttonCount = await allButtons.count();
  const buttonTexts = [];
  for (let i = 0; i < buttonCount; i++) {
    const t = (await allButtons.nth(i).textContent().catch(() => '')).trim();
    const visible = await allButtons.nth(i).isVisible().catch(() => false);
    buttonTexts.push({ i, text: t, visible });
  }
  log('Кнопки в drawer:', JSON.stringify(buttonTexts));

  await page.screenshot({ path: 'output/debug/fill-step5-before-save-click.png', fullPage: false }).catch(() => {});
  const htmlBefore = await page.content();
  fs.writeFileSync('output/debug/fill-step5-before-save-click.html', htmlBefore, 'utf-8');

  // Фінальна кнопка збереження drawer'а покупця — видима кнопка з ТОЧНИМ
  // текстом "Додати" (не "Додати адресу" з вкладки, і не "Додати" біля
  // дропдауна "Додатково" — та йде першою, ця, внизу форми, останньою).
  // hasText-регекс з ^$ не спрацьовує через пробіли навколо тексту в DOM,
  // тому фільтруємо вручну по вже зібраному buttonTexts (trim + visible).
  const exactMatches = buttonTexts.filter((b) => b.text.trim() === 'Додати' && b.visible);
  log('\nКандидатів на фінальну кнопку збереження покупця:', exactMatches.length);

  if (exactMatches.length === 0) {
    log('ПОМИЛКА: фінальну кнопку збереження не знайдено. Дивись fill-step5-before-save-click.png/html для ручного аналізу.');
    await browser.close();
    return;
  }

  const targetIndex = exactMatches[exactMatches.length - 1].i;
  const saveBtn = drawer.locator('button').nth(targetIndex);
  const saveBtnText = (await saveBtn.textContent()).trim();
  log('Індекс кнопки, яку клікаємо:', targetIndex, '| текст:', JSON.stringify(saveBtnText));

  // Перехоплення вмикаємо ЛИШЕ зараз, безпосередньо перед кліком.
  await page.route('**/*', async (route) => {
    const req = route.request();
    const method = req.method();
    if (method !== 'GET') {
      const entry = { method, url: req.url(), postData: req.postData() };
      capturedRequests.push(entry);
      log(`[BLOCKED ${method}]`, req.url(), '| body:', req.postData());
      await route.abort('failed');
    } else {
      await route.continue();
    }
  });

  log('\n--- Клікаю фінальну кнопку збереження покупця (запит буде заблоковано) ---');
  await saveBtn.click();
  await page.waitForTimeout(2500);

  await page.screenshot({ path: 'output/debug/fill-step5-after-save-click-blocked.png', fullPage: false }).catch(() => {});

  log('\n=== Підсумок заблокованих не-GET запитів при кліку збереження покупця ===');
  log(JSON.stringify(capturedRequests, null, 2));
  fs.writeFileSync('output/debug/fill-step5-captured-requests.json', JSON.stringify(capturedRequests, null, 2), 'utf-8');

  await browser.close();
})().catch((e) => { log('FATAL ERROR:', e.message, e.stack); process.exit(1); });
