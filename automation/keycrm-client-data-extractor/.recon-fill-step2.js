require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { chromium } = require('playwright');
const config = require('./config');
const fs = require('fs');

// Recon крок 2: у модалці "Створення замовлення" — вводимо ім'я в поле
// "Покупець" і дивимось, чи це пошук існуючих клієнтів, чи є опція
// створити нового. Нічого не зберігаємо (кнопку "Створити замовлення" НЕ
// натискаємо на цьому кроці).
(async () => {
  const browser = await chromium.launch({ headless: config.HEADLESS });
  const context = await browser.newContext({ storageState: config.STORAGE_STATE_PATH });
  const page = await context.newPage();

  await page.goto(config.LEADS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.locator('.icon-menu-orders').first().click();
  await page.waitForTimeout(2000);

  const addBtn = page.locator('button, .el-button, [role="button"]', { hasText: /Додати замовлення/i });
  await addBtn.first().click();
  await page.waitForTimeout(2000);

  fs.mkdirSync('output/debug', { recursive: true });

  const buyerInput = page.locator('input[placeholder*="Пошук за іменем"]').first();
  await buyerInput.click();
  await buyerInput.fill('ТЕСТ Олег recon');
  await page.waitForTimeout(1500);

  await page.screenshot({ path: 'output/debug/fill-step2-buyer-search.png', fullPage: true }).catch(() => {});
  const html = await page.content();
  fs.writeFileSync('output/debug/fill-step2-buyer-search.html', html, 'utf-8');

  const dropdownItems = await page.locator('.el-select-dropdown__item, .el-autocomplete-suggestion li, li[role="option"]').allTextContents();
  console.log('Пункти дропдауна після пошуку покупця:', JSON.stringify(dropdownItems.map((d) => d.trim()).filter(Boolean), null, 2));

  // Шукаємо будь-що зі словом "Створити" / "новий" в дропдауні
  const createOption = page.locator('.el-select-dropdown__item, .el-autocomplete-suggestion li, li[role="option"]', { hasText: /Створити|новий|додати/i });
  const createCount = await createOption.count();
  console.log('Кандидатів на "створити нового покупця":', createCount);

  const addNewBuyer = page.locator('text=/Додати нового покупця/i').first();
  if (await addNewBuyer.count()) {
    await addNewBuyer.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'output/debug/fill-step2b-new-buyer-form.png', fullPage: true }).catch(() => {});
    const html2 = await page.content();
    fs.writeFileSync('output/debug/fill-step2b-new-buyer-form.html', html2, 'utf-8');
    console.log('Форма нового покупця: скріншот і HTML збережено.');
  } else {
    console.log('Опцію "Додати нового покупця" не знайдено кліком (text=).');
  }

  console.log('\nЗалишаю браузер відкритим 10с для візуального огляду...');
  await page.waitForTimeout(10000);

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
