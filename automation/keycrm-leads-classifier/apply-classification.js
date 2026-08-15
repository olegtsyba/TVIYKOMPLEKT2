require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const { chromium } = require('playwright');
const config = require('./config');
const { notify } = require('../notify');

// ---------------------------------------------------------------------------
// ПРАПОРЦІ ЗАПУСКУ
// ---------------------------------------------------------------------------
// За замовчуванням — DRY-RUN (нічого не клікає, тільки показує намір).
// Реальні зміни в KeyCRM — тільки з explicit прапором --live або APPLY_LIVE=true.
const LIVE_MODE = process.argv.includes('--live') || process.env.APPLY_LIVE === 'true';

// --limit=N — обмежити ЗАГАЛЬНУ кількість карток для обробки за цей запуск
// (для контрольованого тестового прогону перед повною пачкою). За
// замовчуванням обробляються всі high-confidence картки.
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const PROCESS_LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

// --batch-size=N — розмір однієї партії в LIVE-режимі. Картки обробляються
// послідовними партіями з паузою BATCH_PAUSE_MS між ними, щоб уникнути
// одного суцільного проходу без контрольних точок: якщо колись зафіксується
// аномально велика пачка або щось піде не так з підрахунком, збиток
// обмежується однією партією, а не всім прогоном одразу.
const batchSizeArg = process.argv.find((a) => a.startsWith('--batch-size='));
const BATCH_SIZE = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) : 30;
const BATCH_PAUSE_MS = 12000;

// ---------------------------------------------------------------------------
// СЕЛЕКТОРИ. Базові — ідентичні collect-leads.js. Додаткові (rejectButton,
// reasonMenu, reasonItem) — підтверджені живою інспекцією DOM модалки
// (кнопка "Відхилити лід" відкриває el-dropdown з 15 причинами; клік по
// пункту одразу шле PUT /leads/{id} {status_id} — жодного окремого
// підтвердження в UI немає).
// ---------------------------------------------------------------------------
const SELECTORS = {
  columnTitle: '.column-title__text',
  columnAncestor: '.lead-column',
  boardCard: '.lead-card.clickable',
  columnScrollContainer: '.column-content.scrollable',
  modal: '.el-dialog.lead-full-card',
  modalTitle: '.lead-title',
  closeButton: '.dialog-close',
  rejectButton: 'button',
  reasonMenu: 'ul.el-dropdown-menu',
  reasonItem: 'li.el-dropdown-menu__item',
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripChatPrefix(text) {
  return text ? text.replace(/^\s*Чат\s*з\s*/i, '').trim() : null;
}

function ensureDirs() {
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(config.DEBUG_DIR, { recursive: true });
}

function appendLog(entry) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  fs.appendFileSync(config.APPLY_LOG_PATH, line + '\n', 'utf-8');
}

async function saveDebugArtifacts(page, label) {
  try {
    await page.screenshot({ path: require('path').join(config.DEBUG_DIR, `${label}.png`), fullPage: true });
  } catch (err) {
    console.warn(`  [debug] не вдалося зберегти скріншот: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Завантаження даних і фільтрація за впевненістю
// ---------------------------------------------------------------------------
function loadItems() {
  if (!fs.existsSync(config.OUTPUT_PATH) || !fs.existsSync(config.CLASSIFICATION_OUTPUT_PATH)) {
    console.error(
      'Не знайдено output/leads_dialogs.json або output/classification_results.json.\n' +
      'Спочатку виконай: npm run collect, потім npm run classify.'
    );
    process.exit(1);
  }
  const dialogs = JSON.parse(fs.readFileSync(config.OUTPUT_PATH, 'utf-8'));
  const classifications = JSON.parse(fs.readFileSync(config.CLASSIFICATION_OUTPUT_PATH, 'utf-8'));
  const dialogByIndex = new Map(dialogs.map((d) => [d.cardIndex, d]));

  const failed = classifications.filter((c) => !c.reason);
  if (failed.length) {
    console.warn(
      `Попередження: ${failed.length} карток мають невдалу класифікацію (reason: null) — вони пропущені з обробки:\n` +
      failed.map((c) => `  #${c.cardIndex} ${c.customerName || '(без імені)'}`).join('\n')
    );
  }

  const withReason = classifications.filter((c) => c.reason);
  const missingLeadId = withReason.filter((c) => !c.leadId);
  if (missingLeadId.length) {
    console.warn(
      `Попередження: ${missingLeadId.length} карток без leadId (старий формат класифікації, до фіксу кешування) — ` +
      `вони пропущені з обробки, щоб не шукати картку за іменем (ненадійно при однакових іменах):\n` +
      missingLeadId.map((c) => `  #${c.cardIndex} ${c.customerName || '(без імені)'}`).join('\n')
    );
  }

  return withReason
    .filter((c) => c.leadId)
    .map((c) => ({
      cardIndex: c.cardIndex,
      leadId: c.leadId,
      customerName: c.customerName || (dialogByIndex.get(c.cardIndex) || {}).customerName,
      reason: c.reason,
      confidence: c.confidence,
    }));
}

// ЗАПОБІЖНИК ЗА ВПЕВНЕНІСТЮ: тільки confidence === 'high' іде в обробку.
function partitionByConfidence(items) {
  const toProcess = items.filter((i) => i.confidence === 'high');
  const skipped = items.filter((i) => i.confidence !== 'high');
  return { toProcess, skipped };
}

// ---------------------------------------------------------------------------
// Навігація дошкою (перевикористовує підхід з collect-leads.js)
// ---------------------------------------------------------------------------
async function getRejectedColumn(page) {
  const columnTitle = page.locator(SELECTORS.columnTitle, { hasText: config.REJECTED_COLUMN_TITLE }).first();
  await columnTitle.waitFor({ state: 'visible', timeout: 30000 });
  return columnTitle.locator(`xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " lead-column ")][1]`);
}

async function scrollColumnToLoadAllCards(page, column, targetCount) {
  const scrollContainer = column.locator(SELECTORS.columnScrollContainer).first();
  const scrollHandle = await scrollContainer.elementHandle();
  const cards = column.locator(SELECTORS.boardCard);

  let count = await cards.count();
  let stableRounds = 0;
  for (let i = 0; i < 40 && count < targetCount && stableRounds < 3; i++) {
    await scrollHandle.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.waitForTimeout(700);
    const newCount = await cards.count();
    stableRounds = newCount === count ? stableRounds + 1 : 0;
    count = newCount;
  }
  return count;
}

// Довантажує всі картки колонки один раз на старті (лінивий скрол), щоб
// пошук за leadId (findCardIndexById) бачив картки, що лежать нижче
// початково відрендерених ~15.
async function ensureAllCardsLoaded(page, column) {
  const totalBadgeText = await column.locator('.leads-total').first().innerText().catch(() => null);
  const totalBadge = totalBadgeText ? parseInt(totalBadgeText.trim(), 10) : null;
  const cards = column.locator(SELECTORS.boardCard);
  let count = await cards.count();
  console.log(`Карток у колонці "${config.REJECTED_COLUMN_TITLE}": ${count}${totalBadge ? ` (за бейджем: ${totalBadge})` : ''}`);
  if (totalBadge && count < totalBadge) {
    console.log(`Докручую колонку, щоб підвантажити решту карток (${count} -> ${totalBadge})...`);
    count = await scrollColumnToLoadAllCards(page, column, totalBadge);
    console.log(`Після скролу карток у DOM: ${count}`);
  }
  return count;
}

// ЗАХИСТ ВІД ПОВТОРНОЇ ОБРОБКИ: картка ідентифікується заново, за поточним
// станом DOM, безпосередньо перед відкриттям — за стабільним leadId
// (data-id картки в KeyCRM), а НЕ за збереженим позиційним індексом і НЕ за
// іменем клієнта. Позиція зсувається щоразу, коли LIVE-прогін реально
// видаляє картки з колонки; ім'я клієнта може повторюватись (кілька карток
// з однаковим "Nina") — обидва варіанти ненадійні як ідентифікатор. Якщо
// картки з таким leadId більше немає в колонці "Відхилити лід" — її вже
// кудись перемістили (вручну чи іншим запуском).
// Повертає:
//   index >= 0  — знайдено рівно одну картку з таким leadId
//   index === -1 — не знайдено (ймовірно вже оброблено)
async function findCardIndexById(column, leadId) {
  const cards = column.locator(SELECTORS.boardCard);
  const ids = await cards.evaluateAll((els) => els.map((el) => el.getAttribute('data-id')));
  const index = ids.indexOf(String(leadId));
  return { index, cards };
}

async function openCardByIndex(cards, index) {
  const card = cards.nth(index);
  await card.scrollIntoViewIfNeeded();
  await card.dblclick();
}

async function getVisibleModal(page) {
  const modal = page.locator(`${SELECTORS.modal}:visible`);
  await modal.waitFor({ state: 'visible', timeout: 30000 });
  return modal;
}

async function readModalCustomerName(modal) {
  const titleEl = modal.locator(SELECTORS.modalTitle).first();
  const text = await titleEl.textContent().catch(() => null);
  return stripChatPrefix(text);
}

async function closeCard(page) {
  const closeBtn = page.locator(`${SELECTORS.modal}:visible ${SELECTORS.closeButton}`).first();
  if (await closeBtn.count()) {
    await closeBtn.click();
  } else {
    await page.keyboard.press('Escape');
  }
  await page.locator(`${SELECTORS.modal}:visible`).waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Дії з причиною відхилення
// ---------------------------------------------------------------------------
function findRejectButton(modal) {
  // Скоуп на модалку + точний текст "Відхилити лід" — на картці є ще й
  // бейдж-статус з таким самим текстом угорі, але це <span>, не <button>,
  // тож 'button' вже його виключає.
  return modal.locator(SELECTORS.rejectButton, { hasText: 'Відхилити лід' }).first();
}

async function openReasonDropdown(page, modal) {
  const btn = findRejectButton(modal);
  await btn.waitFor({ state: 'visible', timeout: 15000 });
  await btn.click();
  const menu = page.locator(`${SELECTORS.reasonMenu}:visible`).first();
  await menu.waitFor({ state: 'visible', timeout: 10000 });
  return menu;
}

function findReasonItem(menu, reasonText) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(reasonText)}\\s*$`);
  return menu.locator(SELECTORS.reasonItem, { hasText: pattern }).first();
}

// КРИТИЧНО: у dry-run (live === false) ця функція НІКОЛИ не викликає
// .click() на пункті причини — лише .count() для перевірки, що потрібний
// li існує в меню. Реальний клік (який одразу шле PUT /leads/{id} і
// фіналізує статус — підтверджено recon'ом, окремого підтвердження в
// UI немає) відбувається ТІЛЬКИ якщо live === true.
async function selectReason(page, menu, reasonText, live) {
  const item = findReasonItem(menu, reasonText);
  const found = (await item.count()) > 0;
  if (!found) return { found: false, clicked: false };
  if (!live) return { found: true, clicked: false };

  await item.click();
  await page.waitForTimeout(1500);
  return { found: true, clicked: true };
}

async function closeDropdownWithoutSelecting(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
}

// ---------------------------------------------------------------------------
// Обробка однієї картки
// ---------------------------------------------------------------------------
async function processCard(page, column, item, live) {
  const base = {
    cardIndex: item.cardIndex,
    leadId: item.leadId,
    customerName: item.customerName,
    confidence: item.confidence,
    reason: item.reason,
    mode: live ? 'live' : 'dry-run',
  };

  // Колонка — лінивий/віртуальний список: коли попередні картки в циклі
  // видаляються зі статусом, Vue може "згорнути" DOM назад до перших
  // ~15 елементів. Тому довантажуємо картки заново перед КОЖНИМ пошуком
  // за leadId, а не лише один раз на старті всього прогону — інакше
  // картки нижче видимого вікна хибно позначаються як "not-found".
  await ensureAllCardsLoaded(page, column);
  const { index, cards } = await findCardIndexById(column, item.leadId);

  if (index === -1) {
    appendLog({ ...base, previousStatus: null, newStatus: null, result: 'skipped', note: 'not-found-in-column: картки більше немає в колонці "Відхилити лід" (ймовірно вже оброблено вручну або іншим запуском)' });
    console.log(`  ПРОПУЩЕНО — картки більше немає в колонці "${config.REJECTED_COLUMN_TITLE}"`);
    return;
  }

  try {
    await openCardByIndex(cards, index);
    const modal = await getVisibleModal(page);
    await page.waitForTimeout(800);

    const modalName = await readModalCustomerName(modal);
    if (modalName !== item.customerName) {
      appendLog({ ...base, previousStatus: config.REJECTED_COLUMN_TITLE, newStatus: null, result: 'error', note: `title-mismatch: очікували "${item.customerName}", відкрилось "${modalName}"` });
      console.log(`  ПОМИЛКА — відкрилась не та картка ("${modalName}")`);
      await closeCard(page).catch(() => {});
      return;
    }

    const menu = await openReasonDropdown(page, modal);
    const { found, clicked } = await selectReason(page, menu, item.reason, live);

    if (!found) {
      appendLog({ ...base, previousStatus: config.REJECTED_COLUMN_TITLE, newStatus: null, result: 'error', note: `reason-not-found-in-menu: "${item.reason}"` });
      console.log(`  ПОМИЛКА — причину "${item.reason}" не знайдено в меню`);
      await closeDropdownWithoutSelecting(page);
      await closeCard(page).catch(() => {});
      return;
    }

    if (!live) {
      appendLog({ ...base, previousStatus: config.REJECTED_COLUMN_TITLE, newStatus: item.reason, result: 'would-apply', note: 'dry-run: причину знайдено в меню, клік НЕ виконано' });
      console.log(`  DRY-RUN — картку буде переведено в причину "${item.reason}" (клік не виконано)`);
      await closeDropdownWithoutSelecting(page);
      await closeCard(page).catch(() => {});
      return;
    }

    // live: клік уже виконано всередині selectReason(). Закриваємо картку
    // (якщо модалка сама не закрилась після зміни статусу) і перевіряємо
    // результат — картка мала зникнути з колонки "Відхилити лід".
    await closeCard(page).catch(() => {});
    await page.waitForTimeout(500);
    await ensureAllCardsLoaded(page, column);
    const verify = await findCardIndexById(column, item.leadId);
    if (verify.index === -1) {
      appendLog({ ...base, previousStatus: config.REJECTED_COLUMN_TITLE, newStatus: item.reason, result: 'applied', note: 'підтверджено: картка зникла з колонки "Відхилити лід" після зміни статусу' });
      console.log(`  ЗАСТОСОВАНО — "${item.reason}"`);
    } else {
      appendLog({ ...base, previousStatus: config.REJECTED_COLUMN_TITLE, newStatus: item.reason, result: 'applied-unverified', note: 'клік виконано, але картка досі в колонці — перевір вручну' });
      console.log(`  КЛІК ВИКОНАНО, але не вдалось підтвердити зміну статусу — перевір вручну`);
    }
  } catch (err) {
    appendLog({ ...base, previousStatus: config.REJECTED_COLUMN_TITLE, newStatus: null, result: 'error', note: err.message });
    console.error(`  ВИНЯТОК: ${err.message}`);
    await saveDebugArtifacts(page, `apply-error-card-${item.cardIndex}`);
    await closeCard(page).catch(() => {});
  }
}

// Сповіщення показує перелік пропущених карток (не тільки цифру), щоб
// власник міг переслати список менеджерам без заходу в KeyCRM. При великій
// кількості — перші MAX_SKIPPED_IN_NOTIFY + примітка про повний список у
// classification_results.json, щоб повідомлення в Telegram не роздувалось.
const MAX_SKIPPED_IN_NOTIFY = 15;

function formatSkippedForNotify(skipped) {
  if (!skipped.length) return '';
  const shown = skipped.slice(0, MAX_SKIPPED_IN_NOTIFY);
  const lines = shown.map((s) => `  ${s.customerName} — ${s.reason} (${s.confidence})`);
  let text = `\nПропущено (потребують розгляду): ${skipped.length}\n${lines.join('\n')}`;
  if (skipped.length > MAX_SKIPPED_IN_NOTIFY) {
    text += `\n  ...і ще ${skipped.length - MAX_SKIPPED_IN_NOTIFY} карток, повний список у ${config.CLASSIFICATION_OUTPUT_PATH}`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  ensureDirs();

  if (!fs.existsSync(config.STORAGE_STATE_PATH)) {
    console.error(
      `Файл сесії не знайдено: ${config.STORAGE_STATE_PATH}\n` +
      `Спочатку виконай: npm run login`
    );
    process.exit(1);
  }

  const items = loadItems();
  const { toProcess, skipped } = partitionByConfidence(items);
  const limited = Number.isFinite(PROCESS_LIMIT) ? toProcess.slice(0, PROCESS_LIMIT) : toProcess;

  const batches = [];
  for (let i = 0; i < limited.length; i += BATCH_SIZE) {
    batches.push(limited.slice(i, i + BATCH_SIZE));
  }

  console.log(`Завантажено карток з класифікацією: ${items.length}`);
  console.log(`Confidence "high" (кандидати на обробку): ${toProcess.length}`);
  console.log(`Пропущено через confidence medium/low: ${skipped.length}`);
  if (Number.isFinite(PROCESS_LIMIT) && PROCESS_LIMIT < toProcess.length) {
    console.log(`Обмеження --limit=${PROCESS_LIMIT} — цей запуск обробить лише перші ${limited.length} з ${toProcess.length} карток high confidence.`);
  }
  console.log(`Розбито на ${batches.length} парті${batches.length === 1 ? 'ю' : 'й'} по ≤${BATCH_SIZE} карток, пауза між партіями: ${BATCH_PAUSE_MS / 1000}с.`);

  if (LIVE_MODE) {
    console.log('\n' + '='.repeat(70));
    console.log('УВАГА: LIVE-РЕЖИМ УВІМКНЕНО.');
    console.log('Цей запуск РЕАЛЬНО змінить статуси лідів у KeyCRM (клік по причині');
    console.log('одразу відправляє запит на сервер, без окремого підтвердження в UI).');
    console.log('Зупинись зараз (Ctrl+C), якщо не впевнений(-а) в результатах dry-run.');
    console.log('='.repeat(70));
    await new Promise((resolve) => setTimeout(resolve, 5000));
    console.log('Продовжую...\n');
  } else {
    console.log('\nDRY-RUN режим (за замовчуванням) — жодних реальних змін у KeyCRM не буде.');
    console.log('Для реального запуску: npm run apply -- --live\n');
  }

  let processedCount = 0;

  console.log('Запускаю браузер зі збереженою сесією...');
  const browser = await chromium.launch({ headless: config.HEADLESS });
  const context = await browser.newContext({ storageState: config.STORAGE_STATE_PATH });
  const page = await context.newPage();

  try {
    console.log(`Переходжу на ${config.LEADS_URL}`);
    await page.goto(config.LEADS_URL, { waitUntil: 'domcontentloaded' });
    await page.locator(SELECTORS.columnTitle).first().waitFor({ state: 'visible', timeout: 30000 });

    const column = await getRejectedColumn(page);
    await ensureAllCardsLoaded(page, column);

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      console.log(`\n=== Партія ${b + 1}/${batches.length} (карток: ${batch.length}) ===`);
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        console.log(`\n[Партія ${b + 1}, ${i + 1}/${batch.length}] Картка #${item.cardIndex} — ${item.customerName} (${item.confidence}) → "${item.reason}"`);
        await processCard(page, column, item, LIVE_MODE);
        processedCount++;
        await page.waitForTimeout(500);
      }
      if (b < batches.length - 1) {
        console.log(`\nПауза ${BATCH_PAUSE_MS / 1000}с перед наступною партією (контрольна точка)...`);
        await page.waitForTimeout(BATCH_PAUSE_MS);
      }
    }
  } finally {
    await browser.close();
  }

  console.log('\n=== Підсумок ===');
  console.log(`Режим: ${LIVE_MODE ? 'LIVE (реальні зміни застосовано)' : 'DRY-RUN (нічого не змінено)'}`);
  console.log(`Оброблено спроб: ${processedCount} з ${toProcess.length} карток high confidence, за ${batches.length} парті${batches.length === 1 ? 'ю' : 'й'}`);

  if (skipped.length) {
    console.log(`\nПропущено через confidence (${skipped.length}) — потребують ручного розгляду:`);
    skipped.forEach((s) => console.log(`  #${s.cardIndex} ${s.customerName} — confidence: ${s.confidence}`));
  }

  console.log(`\nПовний лог дій: ${config.APPLY_LOG_PATH}`);
  const modeLabel = LIVE_MODE ? 'LIVE' : 'DRY-RUN';
  const batchWord = batches.length === 1 ? 'партію' : 'партій';
  const limitNote = Number.isFinite(PROCESS_LIMIT) && PROCESS_LIMIT < toProcess.length
    ? ` (обмежено --limit=${PROCESS_LIMIT})`
    : '';
  await notify(
    `${modeLabel} — оброблено ${processedCount} карток загалом за ${batches.length} ${batchWord}.\n` +
    `${LIVE_MODE ? 'Реальні зміни застосовано в KeyCRM.' : 'Жодних реальних змін не внесено.'}\n` +
    `High confidence кандидатів: ${toProcess.length}${limitNote}` +
    formatSkippedForNotify(skipped)
  );
}

main().catch(async (err) => {
  await notify(`КРИТИЧНА ПОМИЛКА в apply-classification.js: ${err.message}`);
  console.error(err);
  process.exit(1);
});
