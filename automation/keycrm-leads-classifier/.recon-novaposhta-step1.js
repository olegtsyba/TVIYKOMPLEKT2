require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { chromium } = require('playwright');
const config = require('./config');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: config.HEADLESS });
  const context = await browser.newContext({ storageState: config.STORAGE_STATE_PATH });
  const page = await context.newPage();

  console.log('Переходжу на дошку лідів...');
  await page.goto(config.LEADS_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('.column-title__text').first().waitFor({ state: 'visible', timeout: 30000 });

  const columnTitle = page.locator('.column-title__text', { hasText: 'Формуємо замовлення/допродаж' }).first();
  await columnTitle.waitFor({ state: 'visible', timeout: 30000 });
  const column = columnTitle.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " lead-column ")][1]');
  const cards = column.locator('.lead-card.clickable');
  const count = await cards.count();
  console.log('Карток у колонці "Замовлення сформовано":', count);

  if (count === 0) {
    console.log('Немає карток у цьому статусі — recon зупинено.');
    await browser.close();
    return;
  }

  const card = cards.first();
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await card.dblclick({ force: true, timeout: 10000 });

  const modal = page.locator('.el-dialog.lead-full-card:visible');
  await modal.waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForTimeout(1500);

  await page.screenshot({ path: 'output/debug/novaposhta-step1-modal.png', fullPage: true });
  const html = await modal.evaluate((el) => el.outerHTML);
  fs.writeFileSync('output/debug/novaposhta-step1-modal.html', html, 'utf-8');
  console.log('Скріншот і HTML модалки збережено в output/debug/');

  // List tab names to find the delivery info tab
  const tabs = await modal.locator('.el-tabs__item').allTextContents();
  console.log('Вкладки в картці:', tabs);

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
