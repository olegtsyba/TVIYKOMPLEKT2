require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');
const { notify } = require('../notify');

// ---------------------------------------------------------------------------
// ПРАПОРЦІ ЗАПУСКУ
// ---------------------------------------------------------------------------
// За замовчуванням — DRY-RUN, за тим самим принципом, що й
// move-to-reminder.js: власний прапор (не APPLY_LIVE із run-cycle.sh),
// щоб цей ще не перевірений власником сценарій ніколи не вмикався
// випадково через LIVE-налаштування іншого скрипта.
const LIVE_MODE = process.argv.includes('--live') || process.env.MOVE_TO_MANUAL_REVIEW_LIVE === 'true';

const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const PROCESS_LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

const MOVE_LOG_PATH = path.join(config.OUTPUT_DIR, 'move-to-manual-review-log.jsonl');

const SOURCE_COLUMN_TITLE = 'Відхилити лід';
// Повний DOM-заголовок нової колонки — з подвійним пробілом (нормальна
// конкатенація KeyCRM "Відхилити лід" + "ручний розгляд", не помилка).
// data-id=374 підтверджено власником особисто зі скріншотом 2026-08-24 —
// нижче лише звіряємо, що DOM досі відповідає цьому значенню (без
// звернення до /pipelines/statuses чи будь-якого іншого API — цей
// ендпоінт у репо взагалі не використовується).
const TARGET_COLUMN_TITLE = 'Відхилити лід  ручний розгляд';
const EXPECTED_TARGET_STATUS_ID = '374';
const LEADS_API_BASE = 'https://tviykomplekt.api.keycrm.app';

// Той самий поріг і формат, що й у apply-classification.js /
// move-to-reminder.js — для узгодженості всіх сповіщень.
const MAX_LISTED_IN_NOTIFY = 15;

function formatMovedForNotify(items) {
  if (!items.length) return '';
  const shown = items.slice(0, MAX_LISTED_IN_NOTIFY);
  const lines = shown.map((i) => `  ${i.customerName} — ${i.reason} (${i.confidence})`);
  let text = `\n${lines.join('\n')}`;
  if (items.length > MAX_LISTED_IN_NOTIFY) {
    text += `\n  ...і ще ${items.length - MAX_LISTED_IN_NOTIFY} карток, повний список у ${MOVE_LOG_PATH}`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// КРИТЕРІЙ ВІДБОРУ: medium/low confidence, ЩО НЕ підпадають під критерій
// move-to-reminder.js (rule 3/10 маркер у rationale) — ті вже йдуть в
// "Нагадати" окремим скриптом, тут їх дублювати не можна.
// MARKERS — ідентична копія константи з move-to-reminder.js. Тримати
// синхронізовано вручну, якщо там зміниться список маркерів.
// ---------------------------------------------------------------------------
const MARKERS = ['потребує нагадування', "воронку 'Нагадати'", 'не остаточної відмови'];

function findMatchedMarker(rationale) {
  if (!rationale) return null;
  return MARKERS.find((m) => rationale.includes(m)) || null;
}

// ---------------------------------------------------------------------------
// Селектори — ідентичні move-to-reminder.js / apply-classification.js.
// ---------------------------------------------------------------------------
const SELECTORS = {
  columnTitle: '.column-title__text',
  columnAncestor: '.lead-column',
  boardCard: '.lead-card.clickable',
  columnScrollContainer: '.column-content.scrollable',
  modal: '.el-dialog.lead-full-card',
  modalTitle: '.lead-title',
  closeButton: '.dialog-close',
};

function stripChatPrefix(text) {
  return text ? text.replace(/^\s*Чат\s*з\s*/i, '').trim() : null;
}

function ensureDirs() {
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(config.DEBUG_DIR, { recursive: true });
}

function appendLog(entry) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  fs.appendFileSync(MOVE_LOG_PATH, line + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Завантаження й фільтрація кандидатів
// ---------------------------------------------------------------------------
function loadClassifications() {
  if (!fs.existsSync(config.CLASSIFICATION_OUTPUT_PATH)) {
    console.error('Не знайдено output/classification_results.json. Спочатку виконай: npm run classify.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(config.CLASSIFICATION_OUTPUT_PATH, 'utf-8'));
}

// Ті самі кандидати, яких би обрав move-to-reminder.js — потрібні лише для
// перевірки перетину (крок 5), самі вони тут нікуди не переносяться.
function findReminderCandidates(classifications) {
  const nonHigh = classifications.filter((c) => c.reason && c.confidence && c.confidence !== 'high');
  return nonHigh
    .map((c) => ({ ...c, matchedMarker: findMatchedMarker(c.rationale) }))
    .filter((c) => c.matchedMarker);
}

function loadCandidates(classifications) {
  const mediumLow = classifications.filter((c) => c.confidence === 'medium' || c.confidence === 'low');
  const withoutReminderMarker = mediumLow
    .map((c) => ({ ...c, matchedMarker: findMatchedMarker(c.rationale) }))
    .filter((c) => !c.matchedMarker);

  const missingLeadId = withoutReminderMarker.filter((c) => !c.leadId);
  if (missingLeadId.length) {
    console.warn(
      `Попередження: ${missingLeadId.length} карток-кандидатів без leadId — пропущено:\n` +
      missingLeadId.map((c) => `  #${c.cardIndex} ${c.customerName || '(без імені)'}`).join('\n')
    );
  }

  return withoutReminderMarker.filter((c) => c.leadId);
}

// ---------------------------------------------------------------------------
// Крок 5: явна перевірка, що жодна картка не є кандидатом одночасно і для
// move-to-reminder.js, і для move-to-manual-review.js. За побудовою критеріїв
// (тут відбираємо тільки картки БЕЗ rule 3/10 маркера, move-to-reminder.js —
// тільки картки З ним) перетину бути не може, але перевіряємо й логуємо це
// явно, а не покладаємось лише на логіку відбору.
// ---------------------------------------------------------------------------
function checkNoOverlapWithReminder(manualReviewCandidates, reminderCandidates) {
  const reminderIds = new Set(reminderCandidates.map((c) => c.leadId));
  const overlap = manualReviewCandidates.filter((c) => reminderIds.has(c.leadId));
  if (overlap.length) {
    console.warn(
      `УВАГА: ${overlap.length} карток одночасно підпадають під критерії move-to-reminder.js ` +
      `І move-to-manual-review.js — це не мало б траплятись, перевір критерії відбору обох скриптів:`
    );
    overlap.forEach((c) => console.warn(`  #${c.cardIndex} ${c.leadId} ${c.customerName}`));
  } else {
    console.log(
      `Перевірка перетину з move-to-reminder.js (${reminderCandidates.length} його кандидатів): ` +
      `перетину немає — OK.`
    );
  }
  return overlap;
}

// ---------------------------------------------------------------------------
// Навігація дошкою — ТІЛЬКИ точний (exact) збіг заголовка колонки, НЕ
// substring/hasText, ідентично move-to-reminder.js.
// ---------------------------------------------------------------------------
async function getColumnByExactTitle(page, exactTitle) {
  const columnTitle = page
    .locator(SELECTORS.columnTitle)
    .filter({ hasText: new RegExp(`^\\s*${exactTitle}\\s*$`) });
  await columnTitle.first().waitFor({ state: 'visible', timeout: 30000 });
  const count = await columnTitle.count();
  if (count !== 1) {
    throw new Error(`Очікували рівно 1 колонку з точним заголовком "${exactTitle}", знайдено ${count}`);
  }
  return columnTitle.locator(
    `xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " lead-column ")][1]`
  );
}

async function getColumnStatusId(column) {
  const statusId = await column.getAttribute('data-id');
  if (!statusId) throw new Error('Не вдалось прочитати data-id колонки (status_id)');
  return statusId;
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

async function ensureAllCardsLoaded(page, column) {
  const totalBadgeText = await column.locator('.leads-total').first().innerText().catch(() => null);
  const totalBadge = totalBadgeText ? parseInt(totalBadgeText.trim(), 10) : null;
  const cards = column.locator(SELECTORS.boardCard);
  let count = await cards.count();
  if (totalBadge && count < totalBadge) {
    count = await scrollColumnToLoadAllCards(page, column, totalBadge);
  }
  return count;
}

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
// Виклик PUT /leads/{id} напряму з контексту сторінки — той самий підхід,
// що й у move-to-reminder.js (recon 2026-08-15 через route.abort()).
// ---------------------------------------------------------------------------
async function putLeadStatus(page, leadId, statusId) {
  return page.evaluate(
    async ({ base, leadId, statusId }) => {
      const token = localStorage.getItem('authToken');
      const res = await fetch(`${base}/leads/${leadId}`, {
        method: 'PUT',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ id: Number(leadId), status_id: Number(statusId) }),
      });
      const text = await res.text().catch(() => '');
      return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
    },
    { base: LEADS_API_BASE, leadId, statusId }
  );
}

// ---------------------------------------------------------------------------
// Обробка однієї картки
// ---------------------------------------------------------------------------
async function processCard(page, sourceColumn, targetStatusId, item, live) {
  const base = {
    cardIndex: item.cardIndex,
    leadId: item.leadId,
    customerName: item.customerName,
    confidence: item.confidence,
    reason: item.reason,
    targetColumn: TARGET_COLUMN_TITLE,
    targetStatusId,
    mode: live ? 'live' : 'dry-run',
  };

  await ensureAllCardsLoaded(page, sourceColumn);
  const { index, cards } = await findCardIndexById(sourceColumn, item.leadId);

  if (index === -1) {
    appendLog({ ...base, result: 'skipped', note: `not-found-in-column: картки більше немає в "${SOURCE_COLUMN_TITLE}" (ймовірно вже оброблено вручну або іншим запуском)` });
    console.log(`  ПРОПУЩЕНО — картки більше немає в колонці "${SOURCE_COLUMN_TITLE}"`);
    return { result: 'skipped' };
  }

  try {
    await openCardByIndex(cards, index);
    const modal = await getVisibleModal(page);
    await page.waitForTimeout(500);

    const modalName = await readModalCustomerName(modal);
    if (modalName !== item.customerName) {
      appendLog({ ...base, result: 'error', note: `title-mismatch: очікували "${item.customerName}", відкрилось "${modalName}"` });
      console.log(`  ПОМИЛКА — відкрилась не та картка ("${modalName}")`);
      await closeCard(page).catch(() => {});
      return { result: 'error' };
    }
    await closeCard(page);

    if (!live) {
      appendLog({
        ...base,
        result: 'would-move',
        note: `dry-run: буде відправлено PUT ${LEADS_API_BASE}/leads/${item.leadId} {"id":${item.leadId},"status_id":${targetStatusId}} — запит НЕ відправлено`,
      });
      console.log(`  DRY-RUN — картку буде перенесено в "${TARGET_COLUMN_TITLE}" (status_id=${targetStatusId}), запит не відправлено`);
      return { result: 'would-move' };
    }

    // live: реальний PUT-запит
    const response = await putLeadStatus(page, item.leadId, targetStatusId);
    if (!response.ok) {
      appendLog({ ...base, result: 'error', note: `PUT failed: status=${response.status} body=${response.body}` });
      console.log(`  ПОМИЛКА — PUT повернув ${response.status}: ${response.body}`);
      return { result: 'error' };
    }

    // Перевірка після дії: перезавантажуємо сторінку і підтверджуємо, що
    // картка зникла з "Відхилити лід" — ідентично move-to-reminder.js.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator(SELECTORS.columnTitle).first().waitFor({ state: 'visible', timeout: 30000 });
    const sourceColumnAfter = await getColumnByExactTitle(page, SOURCE_COLUMN_TITLE);
    await ensureAllCardsLoaded(page, sourceColumnAfter);
    const verify = await findCardIndexById(sourceColumnAfter, item.leadId);

    if (verify.index === -1) {
      appendLog({ ...base, result: 'applied', note: `підтверджено: картка зникла з "${SOURCE_COLUMN_TITLE}" після PUT (status=${response.status})` });
      console.log(`  ЗАСТОСОВАНО — перенесено в "${TARGET_COLUMN_TITLE}"`);
      return { result: 'applied', column: sourceColumnAfter };
    }
    appendLog({ ...base, result: 'applied-unverified', note: `PUT виконано (status=${response.status}), але картка досі в "${SOURCE_COLUMN_TITLE}" — перевір вручну` });
    console.log(`  PUT ВИКОНАНО, але не вдалось підтвердити переміщення — перевір вручну`);
    return { result: 'applied-unverified', column: sourceColumnAfter };
  } catch (err) {
    appendLog({ ...base, result: 'error', note: err.message });
    console.error(`  ВИНЯТОК: ${err.message}`);
    await closeCard(page).catch(() => {});
    return { result: 'error' };
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  ensureDirs();

  if (!fs.existsSync(config.STORAGE_STATE_PATH)) {
    console.error(`Файл сесії не знайдено: ${config.STORAGE_STATE_PATH}\nСпочатку виконай: npm run login`);
    process.exit(1);
  }

  const classifications = loadClassifications();
  const candidates = loadCandidates(classifications);
  const reminderCandidates = findReminderCandidates(classifications);
  checkNoOverlapWithReminder(candidates, reminderCandidates);

  const limited = Number.isFinite(PROCESS_LIMIT) ? candidates.slice(0, PROCESS_LIMIT) : candidates;

  console.log(`Кандидатів на перенесення в "${TARGET_COLUMN_TITLE}" (medium/low confidence, без rule 3/10 маркера): ${candidates.length}`);
  candidates.forEach((c) =>
    console.log(`  #${c.cardIndex} ${c.leadId} ${c.customerName} — "${c.reason}" (${c.confidence})`)
  );
  if (candidates.length === 0) {
    console.log('Немає карток, що відповідають критерію. Завершую.');
    await notify(`${LIVE_MODE ? '🔴' : '⚪'} move-to-manual-review.js — ${LIVE_MODE ? 'LIVE' : 'DRY-RUN'}\nКандидатів (medium/low, без rule 3/10 маркера): 0. Нічого переносити.`);
    return;
  }
  if (Number.isFinite(PROCESS_LIMIT) && PROCESS_LIMIT < candidates.length) {
    console.log(`Обмеження --limit=${PROCESS_LIMIT} — обробляю перші ${limited.length} з ${candidates.length}.`);
  }

  if (LIVE_MODE) {
    console.log('\n' + '='.repeat(70));
    console.log('УВАГА: LIVE-РЕЖИМ УВІМКНЕНО.');
    console.log(`Цей запуск РЕАЛЬНО перенесе картки в колонку "${TARGET_COLUMN_TITLE}" в KeyCRM.`);
    console.log('Зупинись зараз (Ctrl+C), якщо не впевнений(-а) в результатах dry-run.');
    console.log('='.repeat(70));
    await new Promise((resolve) => setTimeout(resolve, 5000));
    console.log('Продовжую...\n');
  } else {
    console.log(`\nDRY-RUN режим (за замовчуванням) — жодних реальних змін у KeyCRM не буде.`);
    console.log('Для реального запуску: node move-to-manual-review.js --live\n');
  }

  console.log('Запускаю браузер зі збереженою сесією...');
  const browser = await chromium.launch({ headless: config.HEADLESS });
  const context = await browser.newContext({ storageState: config.STORAGE_STATE_PATH });
  let page = await context.newPage();

  try {
    console.log(`Переходжу на ${config.LEADS_URL}`);
    await page.goto(config.LEADS_URL, { waitUntil: 'domcontentloaded' });
    await page.locator(SELECTORS.columnTitle).first().waitFor({ state: 'visible', timeout: 30000 });

    let sourceColumn = await getColumnByExactTitle(page, SOURCE_COLUMN_TITLE);
    const targetColumn = await getColumnByExactTitle(page, TARGET_COLUMN_TITLE);
    const targetStatusId = await getColumnStatusId(targetColumn);
    if (targetStatusId !== EXPECTED_TARGET_STATUS_ID) {
      throw new Error(
        `Колонка "${TARGET_COLUMN_TITLE}" має data-id=${targetStatusId}, очікували ${EXPECTED_TARGET_STATUS_ID} ` +
        `(звірено власником зі скріншотом раніше) — можливо колонку перейменували/пересоздали, зупиняюсь.`
      );
    }
    console.log(`Колонка "${TARGET_COLUMN_TITLE}" — status_id=${targetStatusId} (прочитано з data-id атрибута, exact-match заголовка, збігається з очікуваним ${EXPECTED_TARGET_STATUS_ID})`);

    await ensureAllCardsLoaded(page, sourceColumn);

    const counts = { applied: 0, 'applied-unverified': 0, 'would-move': 0, skipped: 0, error: 0 };
    const movedItems = [];
    for (let i = 0; i < limited.length; i++) {
      const item = limited[i];
      console.log(`\n[${i + 1}/${limited.length}] Картка #${item.cardIndex} — ${item.customerName} (${item.confidence})`);
      const outcome = await processCard(page, sourceColumn, targetStatusId, item, LIVE_MODE);
      counts[outcome.result] = (counts[outcome.result] || 0) + 1;
      if (['applied', 'applied-unverified', 'would-move'].includes(outcome.result)) {
        movedItems.push({ customerName: item.customerName, reason: item.reason, confidence: item.confidence });
      }
      if (outcome.column) sourceColumn = outcome.column;
      await page.waitForTimeout(500);
    }

    console.log('\n=== Підсумок ===');
    console.log(`Режим: ${LIVE_MODE ? 'LIVE (реальні зміни застосовано)' : 'DRY-RUN (нічого не змінено)'}`);
    console.log(`Оброблено спроб: ${limited.length} з ${candidates.length} кандидатів`);
    console.log(`Повний лог дій: ${MOVE_LOG_PATH}`);

    const modeLabel = LIVE_MODE ? 'LIVE' : 'DRY-RUN';
    const appliedTotal = counts.applied + counts['applied-unverified'];
    await notify(
      `${LIVE_MODE ? '🔴' : '⚪'} move-to-manual-review.js — ${modeLabel}\n` +
      `Кандидатів (medium/low, без rule 3/10 маркера): ${candidates.length}\n` +
      `${LIVE_MODE ? 'Перенесено в "Ручний розгляд"' : 'Буде перенесено (dry-run)'}: ${LIVE_MODE ? appliedTotal : counts['would-move']}` +
      `${counts['applied-unverified'] ? ` (з них ${counts['applied-unverified']} без підтвердження — перевір вручну)` : ''}` +
      formatMovedForNotify(movedItems) +
      `\nПропущено (вже оброблено): ${counts.skipped}` +
      `${counts.error ? `\nПомилок: ${counts.error} — перевір лог ${MOVE_LOG_PATH}` : ''}`
    );
  } catch (err) {
    await notify(`🔴 КРИТИЧНА ПОМИЛКА в move-to-manual-review.js (${LIVE_MODE ? 'LIVE' : 'DRY-RUN'}): ${err.message}`);
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('КРИТИЧНА ПОМИЛКА в move-to-manual-review.js:', err);
  process.exit(1);
});
