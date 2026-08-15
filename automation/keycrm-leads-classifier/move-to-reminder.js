require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');
const { notify } = require('../notify');

// ---------------------------------------------------------------------------
// ПРАПОРЦІ ЗАПУСКУ
// ---------------------------------------------------------------------------
// За замовчуванням — DRY-RUN. НАВМИСНО НЕ читає APPLY_LIVE (яку run-cycle.sh
// уже вмикає для apply-classification.js) — це окремий, ще не перевірений
// власником сценарій, і випадкове успадкування LIVE-прапора з .env
// суперечило б вимозі "не вмикай live, поки я не перевірю dry-run".
const LIVE_MODE = process.argv.includes('--live') || process.env.MOVE_TO_REMINDER_LIVE === 'true';

const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const PROCESS_LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

const MOVE_LOG_PATH = path.join(config.OUTPUT_DIR, 'move-to-reminder-log.jsonl');

const SOURCE_COLUMN_TITLE = 'Відхилити лід';
const TARGET_COLUMN_TITLE = 'Нагадати';
const LEADS_API_BASE = 'https://tviykomplekt.api.keycrm.app';

// ---------------------------------------------------------------------------
// КРИТЕРІЙ ВІДБОРУ: rationale має містити один із МАРКЕРІВ, які правила 3
// і 10 промпту явно вставляють за інструкцією (не вільна інтерпретація
// "звучить схоже", а буквальна фраза-шаблон). Підтверджено на реальних 14
// картках 2026-08-15: під критерій підпадають рівно 5 — #4, #7, #8, #11, #14
// (ті, де клієнт погодився на покупку й зник — правило 3, або виявив
// інтерес після знижки -10% і знову зник — правило 10). Картки на кшталт
// #13 (PRO MAKEUP), де модель перефразувала сенс, але НЕ вжила жодного з
// цих маркерів дослівно, свідомо НЕ підпадають — лишаються для ручного
// розгляду, як і "мовчання після авто-знижки" без прямого маркера.
const MARKERS = ['потребує нагадування', "воронку 'Нагадати'", 'не остаточної відмови'];

function findMatchedMarker(rationale) {
  if (!rationale) return null;
  return MARKERS.find((m) => rationale.includes(m)) || null;
}

// ---------------------------------------------------------------------------
// Селектори — ідентичні apply-classification.js там, де йдеться про той
// самий DOM (дошка, картка, модалка).
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
function loadCandidates() {
  if (!fs.existsSync(config.CLASSIFICATION_OUTPUT_PATH)) {
    console.error('Не знайдено output/classification_results.json. Спочатку виконай: npm run classify.');
    process.exit(1);
  }
  const classifications = JSON.parse(fs.readFileSync(config.CLASSIFICATION_OUTPUT_PATH, 'utf-8'));

  const nonHigh = classifications.filter((c) => c.reason && c.confidence && c.confidence !== 'high');
  const withMarker = nonHigh
    .map((c) => ({ ...c, matchedMarker: findMatchedMarker(c.rationale) }))
    .filter((c) => c.matchedMarker);

  const missingLeadId = withMarker.filter((c) => !c.leadId);
  if (missingLeadId.length) {
    console.warn(
      `Попередження: ${missingLeadId.length} карток-кандидатів без leadId — пропущено:\n` +
      missingLeadId.map((c) => `  #${c.cardIndex} ${c.customerName || '(без імені)'}`).join('\n')
    );
  }

  return withMarker.filter((c) => c.leadId);
}

// ---------------------------------------------------------------------------
// Навігація дошкою — ТІЛЬКИ точний (exact) збіг заголовка колонки, НЕ
// substring/hasText. Причина: "Нагадати" substring-матчиться також на
// "SOS НАГАДАТИ" (data-id 373) і "Нагадати 2" (data-id 342) — recon
// 2026-08-15 підтвердив, що substring-пошук із .first() підхоплював
// "SOS НАГАДАТИ" замість потрібної колонки "Нагадати" (data-id 334).
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
// Виклик PUT /leads/{id} напряму з контексту сторінки (той самий запит, що
// й UI шле при drag-and-drop картки між колонками — підтверджено recon'ом
// 2026-08-15 через route.abort(): PUT {LEADS_API_BASE}/leads/{id}
// {"id": <leadId>, "status_id": <targetStatusId>}, authorization —
// Bearer-токен з localStorage.authToken, який read-only читаємо з поточної
// автентифікованої сесії браузера (той самий storage-state.json, що вже
// використовує весь пайплайн — жодних нових credential).
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
    matchedMarker: item.matchedMarker,
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
    // картка зникла з "Відхилити лід" (той самий підхід, що й
    // apply-classification.js — verify через зникнення з вихідної колонки).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator(SELECTORS.columnTitle).first().waitFor({ state: 'visible', timeout: 30000 });
    const sourceColumnAfter = await getColumnByExactTitle(page, SOURCE_COLUMN_TITLE);
    await ensureAllCardsLoaded(page, sourceColumnAfter);
    const verify = await findCardIndexById(sourceColumnAfter, item.leadId);

    // sourceColumn-локатор, з яким працює цикл у main(), посилається на
    // "стару" сторінку до reload — після reload потрібен новий локатор для
    // наступної ітерації, повертаємо його викликачу через result.column.
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

  const candidates = loadCandidates();
  const limited = Number.isFinite(PROCESS_LIMIT) ? candidates.slice(0, PROCESS_LIMIT) : candidates;

  console.log(`Кандидатів на перенесення в "${TARGET_COLUMN_TITLE}" (маркер rule 3/10 у rationale): ${candidates.length}`);
  candidates.forEach((c) =>
    console.log(`  #${c.cardIndex} ${c.leadId} ${c.customerName} — "${c.reason}" (${c.confidence}) — маркер: "${c.matchedMarker}"`)
  );
  if (candidates.length === 0) {
    console.log('Немає карток, що відповідають критерію. Завершую.');
    await notify(`${LIVE_MODE ? '🔴' : '⚪'} move-to-reminder.js — ${LIVE_MODE ? 'LIVE' : 'DRY-RUN'}\nКандидатів (маркер rule 3/10 у rationale): 0. Нічого переносити.`);
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
    console.log('Для реального запуску: node move-to-reminder.js --live\n');
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
    console.log(`Колонка "${TARGET_COLUMN_TITLE}" — status_id=${targetStatusId} (прочитано з data-id атрибута, exact-match заголовка)`);

    await ensureAllCardsLoaded(page, sourceColumn);

    const counts = { applied: 0, 'applied-unverified': 0, 'would-move': 0, skipped: 0, error: 0 };
    for (let i = 0; i < limited.length; i++) {
      const item = limited[i];
      console.log(`\n[${i + 1}/${limited.length}] Картка #${item.cardIndex} — ${item.customerName} (${item.confidence})`);
      const outcome = await processCard(page, sourceColumn, targetStatusId, item, LIVE_MODE);
      counts[outcome.result] = (counts[outcome.result] || 0) + 1;
      if (outcome.column) sourceColumn = outcome.column; // після live-переносу сторінка була перезавантажена
      await page.waitForTimeout(500);
    }

    console.log('\n=== Підсумок ===');
    console.log(`Режим: ${LIVE_MODE ? 'LIVE (реальні зміни застосовано)' : 'DRY-RUN (нічого не змінено)'}`);
    console.log(`Оброблено спроб: ${limited.length} з ${candidates.length} кандидатів`);
    console.log(`Повний лог дій: ${MOVE_LOG_PATH}`);

    const modeLabel = LIVE_MODE ? 'LIVE' : 'DRY-RUN';
    const appliedTotal = counts.applied + counts['applied-unverified'];
    await notify(
      `${LIVE_MODE ? '🔴' : '⚪'} move-to-reminder.js — ${modeLabel}\n` +
      `Кандидатів (маркер rule 3/10 у rationale): ${candidates.length}\n` +
      `${LIVE_MODE ? 'Перенесено в "Нагадати"' : 'Буде перенесено (dry-run)'}: ${LIVE_MODE ? appliedTotal : counts['would-move']}` +
      `${counts['applied-unverified'] ? ` (з них ${counts['applied-unverified']} без підтвердження — перевір вручну)` : ''}\n` +
      `Пропущено (вже оброблено): ${counts.skipped}` +
      `${counts.error ? `\nПомилок: ${counts.error} — перевір лог ${MOVE_LOG_PATH}` : ''}`
    );
  } catch (err) {
    await notify(`🔴 КРИТИЧНА ПОМИЛКА в move-to-reminder.js (${LIVE_MODE ? 'LIVE' : 'DRY-RUN'}): ${err.message}`);
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('КРИТИЧНА ПОМИЛКА в move-to-reminder.js:', err);
  process.exit(1);
});
