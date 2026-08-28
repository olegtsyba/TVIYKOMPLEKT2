require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');
const { notify } = require('../notify');
const { ensureFreshSession } = require('../refresh-session');
const { extractMessages } = require('../extract-messages');

// ---------------------------------------------------------------------------
// ПРИЗНАЧЕННЯ
// ---------------------------------------------------------------------------
// Два цикли лідів воронки "Ліди" (pipeline 1), кожен зі своєю парою
// колонок "тригер -> день 2":
//   Цикл А: "Нагадати 2" (status_id 342)          -> "День 2 нагадування 2" (status_id 144)
//   Цикл Б: "Відправити знижку -10%" (status_id 343) -> "День 2 знижка -10%" (status_id 336)
// (назва колонки 343 виправлена власницею 2026-08-25 з одруківки — сам
// числовий id не змінився).
//
// Скрипт МАСОВО (без жодної фільтрації за rationale/класифікацією —
// на відміну від move-to-reminder.js/move-to-manual-review.js) переносить
// усі картки з колонки-тригера в колонку "день 2" — сам цей перенос статусу
// й запускає автоматичне повідомлення KeyCRM Bot клієнту в Instagram Direct
// (той самий механізм, що й для замовлень у check-order-notifications.js).
// Одразу після переносу скрипт перевіряє в чаті ліда, чи повідомлення
// доставлено, і якщо Meta заблокувала бота (помилка #10, ".el-icon-error")
// і ще ніхто не продублював текст вручну — дублює його сам (той самий рушій
// перевірки/дублювання, що й check-order-notifications.js: клас
// ".vac-message-wrapper", іконка ".vac-message-date .el-icon-error",
// копіювання тексту бота в поле вводу і "Надіслати").
//
// Discovery — GET {API_BASE_URL}/leads/pipelines/desk/1, весь борд
// pipeline 1 одним джерелом даних для ОБОХ циклів одразу, з пагінацією
// через leads.last_page (навмисно НЕ покладаємось на один запит, навіть
// якщо зараз усе влазить в одну сторінку по 50 — розмір колонок з часом
// зросте).
//
// ВІДНОВЛЕННЯ ПІСЛЯ ЗБОЮ (додано понад буквальну постановку, за духом
// ідемпотентності решти пайплайна): якщо прогін впаде/вичерпає ліміт Meta
// ПІСЛЯ того, як лід уже перенесено в "день 2", але ДО того, як чат
// перевірено — цей лід зникає з колонки-тригера і наступного разу вже не
// потрапить у discovery як кандидат на перенесення. Оскільки той самий
// запит /leads/pipelines/desk/1 і так повертає ввесь борд, ми заразом
// збираємо й лідів, що ВЖЕ сидять у цільових колонках (144/336), і
// прогнаний проти журналу (тільки термінальні результати перевірки чату)
// список "ще не перевірених" домішується в чергу цього прогону як
// "chat-check-only" завдання (needsMove: false) — це не коштує жодного
// додаткового API-виклику, бо дані вже отримані.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ПРАПОРЦІ ЗАПУСКУ — dry-run за замовчуванням, окремий LIVE-прапор, що
// НЕ успадковує LIVE інших скриптів (той самий принцип, що й
// move-to-reminder.js / check-order-notifications.js).
// ---------------------------------------------------------------------------
const LIVE_MODE = process.argv.includes('--live') || process.env.CHECK_LEAD_NOTIFICATIONS_LIVE === 'true';

const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const PROCESS_LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

// --lead-ids=38356,38233 — обмежити чергу конкретними лідами (за їхнім
// числовим id, тим самим, що в data-id картки й у /leads/{id}). Для
// контрольованих ручних тестів (перший --live прогін на 1-2 картках з
// наперед відомою особою) — без цього прапорця обирати конкретну картку
// довелось би покладаючись на випадкове перемішування черги.
const leadIdsArg = process.argv.find((a) => a.startsWith('--lead-ids='));
const LEAD_IDS_FILTER = leadIdsArg ? new Set(leadIdsArg.split('=')[1].split(',').map((s) => s.trim())) : null;

const LOG_PATH = path.join(config.OUTPUT_DIR, 'check-lead-notifications-log.jsonl');
const MAX_LISTED_IN_NOTIFY = 15;

// Ліміт дублювань на прогін — СПІЛЬНИЙ на обидва цикли разом (не по
// 15-20 на кожен окремо), щоб не подвоювати сумарне навантаження на
// Instagram API за один прогін.
const CYCLES = [
  { key: 'A', sourceStatusId: 342, sourceLabel: 'Нагадати 2', targetStatusId: 144, targetLabel: 'День 2 нагадування 2' },
  { key: 'B', sourceStatusId: 343, sourceLabel: 'Відправити знижку -10%', targetStatusId: 336, targetLabel: 'День 2 знижка -10%' },
];

const TERMINAL_RESULTS = new Set(['delivered', 'already-duplicated-manually', 'duplicated', 'duplicated-unverified']);

const SELECTORS = {
  columnTitle: '.column-title__text',
  boardCard: '.lead-card.clickable',
  columnScrollContainer: '.column-content.scrollable',
  modal: '.el-dialog.lead-full-card',
  modalTitle: '.lead-title',
  closeButton: '.dialog-close',
  chatInputPlaceholder: 'Введіть повідомлення...',
};

// ---------------------------------------------------------------------------
// Дрібні утиліти — ідентичні check-order-notifications.js.
// ---------------------------------------------------------------------------
function normalize(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}
function normalizeCI(s) {
  return normalize(s).toLowerCase();
}
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
async function randomProtectiveDelay(page) {
  const ms = randomInt(20000, 90000);
  console.log(`  ...чекаю ${(ms / 1000).toFixed(0)}с (випадкова затримка, захист від тригерів Meta)...`);
  await page.waitForTimeout(ms);
}

// Вікно реальних відправок клієнту — 9:00-23:00 за Києвом. Перевіряється
// заново перед КОЖНОЮ дією, що спричиняє повідомлення клієнту (і явний
// дубль-send, і перенос статусу, який сам тригерить автоповідомлення
// KeyCRM Bot) — не один раз на старті прогону, бо сам прогін триває
// десятки хвилин через randomProtectiveDelay.
function isOutsideSendWindow() {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: 'numeric', hourCycle: 'h23' }).format(new Date())
  );
  return hour < 9 || hour >= 23;
}

function stripChatPrefix(text) {
  return text ? text.replace(/^\s*Чат\s*з\s*/i, '').trim() : null;
}

function ensureDirs() {
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(config.DEBUG_DIR, { recursive: true });
}

async function saveDebugArtifacts(page, label) {
  try {
    await page.screenshot({ path: path.join(config.DEBUG_DIR, `${label}.png`), fullPage: true });
    fs.writeFileSync(path.join(config.DEBUG_DIR, `${label}.html`), await page.content(), 'utf-8');
  } catch (err) {
    console.warn(`  [debug] не вдалося зберегти debug-артефакти: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Журнал (append-only JSONL). Ключ — лід + цикл (slot завжди 'last-1' для
// перевірки чату, бо на відміну від "Виконано" в check-order-notifications.js
// тут перевіряється рівно ОДНЕ останнє повідомлення бота на цикл). Записи
// про сам перенос статусу (slot: 'move') пишуться в той самий файл для
// аудиту, але НЕ термінальні й не блокують нічого — ідемпотентність
// переносу забезпечує сам KeyCRM (лід просто зникає з колонки-тригера).
// ---------------------------------------------------------------------------
function journalKey(leadId, cycleKey) {
  return `${leadId}::${cycleKey}`;
}

function loadJournal() {
  const map = new Map();
  if (!fs.existsSync(LOG_PATH)) return map;
  const lines = fs.readFileSync(LOG_PATH, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.slot === 'last-1' && TERMINAL_RESULTS.has(entry.result)) {
        map.set(journalKey(entry.leadId, entry.cycleKey), entry);
      }
    } catch {
      // пошкоджений рядок логу — ігноруємо, не валимо весь скрипт
    }
  }
  return map;
}

function recordResult(journalMap, entry) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  fs.appendFileSync(LOG_PATH, line + '\n', 'utf-8');
  if (entry.slot === 'last-1' && TERMINAL_RESULTS.has(entry.result)) {
    journalMap.set(journalKey(entry.leadId, entry.cycleKey), entry);
  }
}

function formatItemsForNotify(items) {
  if (!items.length) return '';
  const shown = items.slice(0, MAX_LISTED_IN_NOTIFY);
  const lines = shown.map((i) => `  [Цикл ${i.cycleKey}] #${i.leadId} ${i.customerName || '(?)'} — ${i.action}`);
  let text = `\n${lines.join('\n')}`;
  if (items.length > MAX_LISTED_IN_NOTIFY) {
    text += `\n  ...і ще ${items.length - MAX_LISTED_IN_NOTIFY}, повний список у ${LOG_PATH}`;
  }
  return text;
}

function emptyCounts() {
  return { moved: 0, 'would-move': 0, delivered: 0, 'already-duplicated-manually': 0, duplicated: 0, 'duplicated-unverified': 0, 'would-duplicate': 0, error: 0, 'skipped-after-hours': 0 };
}

function summarizeCycle(cycle, c) {
  const movedTotal = c.moved + c['would-move'];
  const duplicatedTotal = c.duplicated + c['duplicated-unverified'] + c['would-duplicate'];
  return (
    `Цикл ${cycle.key} ("${cycle.sourceLabel}" → "${cycle.targetLabel}"): ` +
    `перенесено ${movedTotal} | доставлено без помилок ${c.delivered} | ` +
    `вже продубльовано вручну ${c['already-duplicated-manually']} | продубльовано ${duplicatedTotal}` +
    `${c.error ? ` | помилок ${c.error}` : ''}` +
    `${c['skipped-after-hours'] ? ` | пропущено (після 23:00) ${c['skipped-after-hours']}` : ''}`
  );
}

// ---------------------------------------------------------------------------
// extractMessages() — спільна з check-order-notifications.js, винесена в
// ../extract-messages.js.
// ---------------------------------------------------------------------------
// Discovery — один запит-джерело (з пагінацією) для ОБОХ циклів разом:
// і кандидатів на перенос (status_id === sourceStatusId), і кандидатів,
// що вже сидять у цільовому статусі та можуть потребувати довиконання
// перевірки чату з попереднього незавершеного прогону.
// ---------------------------------------------------------------------------
async function fetchAuthToken(page) {
  const token = await page.evaluate(() => localStorage.getItem('authToken'));
  if (!token) throw new Error('authToken не знайдено в localStorage сторінки — сесія недійсна?');
  return token;
}

// ---------------------------------------------------------------------------
// РЕАЛЬНА ФОРМА ВІДПОВІДІ (перевірено живим запитом 2026-08-25, розходиться
// з початковим припущенням "один плаский leads.data/leads.last_page"):
// GET /leads/pipelines/desk/1 повертає МАСИВ УСІХ 21 колонок воронки
// "Ліди" одразу (id колонки === status_id, а НЕ лише 4 цікаві нам), і
// КОЖНА колонка має СВІЙ ОКРЕМИЙ пагінований блок
// leads: {current_page, data, last_page, per_page, total, ...} (per_page=15).
// Параметр ?page=N зсуває сторінку ВСІХ колонок одночасно в одному й тому
// самому запиті (підтверджено: page=2 для порожньої колонки 144 повертає
// data: [] при current_page: 2, last_page лишається 1 — Laravel paginator
// за межами останньої сторінки просто віддає порожній масив, не помилку).
// Тому "пагінація через leads.last_page" означає: гортати page=1,2,3... і
// для КОЖНОЇ з 4 цікавих нам колонок окремо брати дані, поки page не
// перевищить last_page САМЕ ЦІЄЇ колонки — зупинятись, коли ВСІ 4 вже
// догорнуті до кінця (список 342 має last_page=3, 343 — 2, на момент
// перевірки).
// ---------------------------------------------------------------------------
async function fetchDeskPage(page, authToken, pageNum) {
  const url = `${config.API_BASE_URL}/leads/pipelines/desk/1?page=${pageNum}`;
  const res = await page.request.get(url, { headers: { authorization: `Bearer ${authToken}` } });
  if (!res.ok()) {
    throw new Error(`GET /leads/pipelines/desk/1 (сторінка ${pageNum}) повернув ${res.status()}`);
  }
  return res.json();
}

async function fetchLeadsForStatuses(page, authToken, statusIds) {
  const byStatus = new Map(statusIds.map((id) => [id, []]));
  let pageNum = 1;
  let keepGoing = true;
  while (keepGoing) {
    const body = await fetchDeskPage(page, authToken, pageNum);
    keepGoing = false;
    for (const statusId of statusIds) {
      const col = body.find((c) => c.id === statusId);
      const leadsBlock = col && col.leads;
      if (!leadsBlock) continue;
      const lastPage = leadsBlock.last_page || 1;
      if (pageNum <= lastPage) {
        byStatus.get(statusId).push(...(leadsBlock.data || []));
      }
      if (pageNum < lastPage) keepGoing = true;
    }
    pageNum++;
  }
  return byStatus;
}

// title завжди має форму "Чат з <ім'я або instagram-handle>" — той самий
// текст, що й заголовок модалки ліда (stripChatPrefix уже нормалізує обидва
// джерела до одного вигляду). contact.full_name буває null (контакт з
// Instagram без відомого ПІБ, лише handle) — тому title є ПЕРШОДЖЕРЕЛОМ,
// а contact.full_name лише запасний варіант.
function extractLeadName(l) {
  return stripChatPrefix(l.title) || l.contact?.full_name || null;
}

async function discoverCandidates(page) {
  await page.goto(config.LEADS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator(SELECTORS.columnTitle).first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  const authToken = await fetchAuthToken(page);

  const statusIds = CYCLES.flatMap((c) => [c.sourceStatusId, c.targetStatusId]);
  const byStatus = await fetchLeadsForStatuses(page, authToken, statusIds);

  const toMove = [];
  const toCheck = [];
  for (const cycle of CYCLES) {
    for (const l of byStatus.get(cycle.sourceStatusId) || []) {
      toMove.push({ leadId: String(l.id), customerName: extractLeadName(l), cycleKey: cycle.key });
    }
    for (const l of byStatus.get(cycle.targetStatusId) || []) {
      toCheck.push({ leadId: String(l.id), customerName: extractLeadName(l), cycleKey: cycle.key });
    }
  }
  return { toMove, toCheck };
}

// ---------------------------------------------------------------------------
// Навігація дошкою — ідентично move-to-reminder.js.
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

async function verifyInColumn(page, columnLabel, leadId) {
  await page.goto(config.LEADS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator(SELECTORS.columnTitle).first().waitFor({ state: 'visible', timeout: 30000 });
  const column = await getColumnByExactTitle(page, columnLabel);
  await ensureAllCardsLoaded(page, column);
  return findCardIndexById(column, leadId);
}

// ---------------------------------------------------------------------------
// PUT /leads/{id} напряму з контексту сторінки — той самий підхід, що й
// move-to-reminder.js. На відміну від move-to-reminder.js картку НЕ
// відкриваємо заради звірки імені перед цим викликом — кандидатів тут
// беремо напряму зі свіжого API-знімка борду (discoverCandidates), без
// проміжного кешу, тож звіряти немає з чим; ідентичність підтверджується
// ПІСЛЯ виклику через verifyInColumn(targetLabel, leadId).
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
    { base: config.API_BASE_URL, leadId, statusId }
  );
}

// ---------------------------------------------------------------------------
// Крок 2: перевірка чату / дублювання на новому статусі — той самий рушій,
// що й check-order-notifications.js (processCandidate), адаптований під
// відкриту картку ліда замість рядка таблиці замовлень. Повертає
// 'RATE_LIMIT_HIT', якщо спільний ліміт дублювань на прогін вичерпано.
// ---------------------------------------------------------------------------
async function processChatCheck(page, task, cycle, verify, journalMap, live, sendCounter, maxSends, counts, notifyItems) {
  const key = journalKey(task.leadId, task.cycleKey);
  if (journalMap.has(key)) return null; // вже перевірено в минулому прогоні

  const base = {
    leadId: task.leadId,
    cycleKey: task.cycleKey,
    sourceStatus: cycle.sourceLabel,
    targetStatus: cycle.targetLabel,
    slot: 'last-1',
    mode: live ? 'live' : 'dry-run',
  };

  await openCardByIndex(verify.cards, verify.index);
  const modal = await getVisibleModal(page);
  await page.waitForTimeout(500);
  const customerName = (await readModalCustomerName(modal)) || task.customerName;

  const writeBtn = page.getByText('Написати', { exact: true }).first();
  if (!(await writeBtn.count())) {
    recordResult(journalMap, { ...base, customerName, result: 'error', note: 'write-button-not-found' });
    counts.error++;
    await closeCard(page).catch(() => {});
    return null;
  }
  await writeBtn.click();
  await page.waitForTimeout(700);

  const href = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a.message__link')].find((a) => a.getAttribute('href')?.includes('/app/conversations/'));
    return a ? a.getAttribute('href') : null;
  });
  if (!href) {
    recordResult(journalMap, { ...base, customerName, result: 'error', note: 'no-conversation-link (немає існуючого діалогу?)' });
    counts.error++;
    await closeCard(page).catch(() => {});
    return null;
  }

  await page.goto(`${config.BASE_URL}${href}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('.vac-message-wrapper').first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const messages = await page.evaluate(extractMessages);
  const botMessages = messages.filter((m) => normalizeCI(m.sender) === 'keycrm bot');
  if (!botMessages.length) {
    recordResult(journalMap, { ...base, customerName, result: 'error', note: 'no-bot-message-found-in-chat' });
    counts.error++;
    await saveDebugArtifacts(page, `lead-${task.leadId}-${task.cycleKey}-no-bot-message`);
    return null;
  }

  const botMsg = botMessages[botMessages.length - 1];

  if (!botMsg.hasError) {
    recordResult(journalMap, { ...base, customerName, result: 'delivered', note: botMsg.text.slice(0, 150) });
    counts.delivered++;
    return null;
  }

  const botIndexInAll = messages.findIndex((m) => m.dataId === botMsg.dataId);
  const laterMessages = messages.slice(botIndexInAll + 1);
  const manualDuplicate = laterMessages.find((m) => normalizeCI(m.sender) !== 'keycrm bot' && normalize(m.text) === normalize(botMsg.text));

  if (manualDuplicate) {
    recordResult(journalMap, { ...base, customerName, result: 'already-duplicated-manually', note: botMsg.text.slice(0, 150) });
    counts['already-duplicated-manually']++;
    return null;
  }

  if (!live) {
    recordResult(journalMap, { ...base, customerName, result: 'would-duplicate', note: `dry-run: буде відправлено копію тексту бота: ${botMsg.text.slice(0, 150)}` });
    counts['would-duplicate']++;
    notifyItems.push({ leadId: task.leadId, customerName, cycleKey: task.cycleKey, action: 'would-duplicate' });
    return null;
  }

  if (sendCounter.count >= maxSends) {
    recordResult(journalMap, { ...base, customerName, result: 'error', note: `rate-limit: спільний ліміт ${maxSends} дублювань на прогін (обидва цикли разом) вичерпано, спробуємо наступного разу` });
    return 'RATE_LIMIT_HIT';
  }

  if (isOutsideSendWindow()) {
    recordResult(journalMap, { ...base, customerName, result: 'skipped-after-hours', note: `дублювання пропущено — час поза вікном 9:00-23:00, спробуємо в ранковому прогоні: ${botMsg.text.slice(0, 150)}` });
    counts['skipped-after-hours']++;
    notifyItems.push({ leadId: task.leadId, customerName, cycleKey: task.cycleKey, action: 'skipped-after-hours' });
    return null;
  }

  try {
    const input = page.getByPlaceholder(SELECTORS.chatInputPlaceholder);
    await input.click();
    await input.fill(botMsg.text);
    const sendBtn = page.getByText('Надіслати', { exact: true }).first();
    await sendBtn.click();
    await page.waitForTimeout(2000);

    const after = await page.evaluate(extractMessages);
    const newest = after[after.length - 1];
    const verified = newest && normalizeCI(newest.sender) !== 'keycrm bot' && normalize(newest.text) === normalize(botMsg.text);

    recordResult(journalMap, { ...base, customerName, result: verified ? 'duplicated' : 'duplicated-unverified', note: botMsg.text.slice(0, 150) });
    counts[verified ? 'duplicated' : 'duplicated-unverified']++;
    sendCounter.count++;
    notifyItems.push({ leadId: task.leadId, customerName, cycleKey: task.cycleKey, action: 'duplicated' });
    if (!verified) await saveDebugArtifacts(page, `lead-${task.leadId}-${task.cycleKey}-unverified-send`);
  } catch (err) {
    recordResult(journalMap, { ...base, customerName, result: 'error', note: `send-failed: ${err.message}` });
    counts.error++;
    await saveDebugArtifacts(page, `lead-${task.leadId}-${task.cycleKey}-send-error`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Крок 1 (якщо потрібно) + крок 2: обробка одного завдання черги.
// ---------------------------------------------------------------------------
async function processTask(page, task, journalMap, live, sendCounter, maxSends, counts, notifyItems) {
  const cycle = CYCLES.find((c) => c.key === task.cycleKey);
  const base = {
    leadId: task.leadId,
    cycleKey: task.cycleKey,
    sourceStatus: cycle.sourceLabel,
    targetStatus: cycle.targetLabel,
    slot: 'move',
    mode: live ? 'live' : 'dry-run',
  };

  if (!task.needsMove) {
    // Довиконання перевірки чату для ліда, що вже сидів у цільовій колонці
    // на момент discovery (незавершений минулий прогін або ручне
    // переміщення) — крок переносу не повторюємо.
    const verify = await verifyInColumn(page, cycle.targetLabel, task.leadId);
    if (verify.index === -1) {
      recordResult(journalMap, { ...base, slot: 'last-1', customerName: task.customerName, result: 'error', note: `resume: картки більше немає в колонці "${cycle.targetLabel}"` });
      counts.error++;
      return null;
    }
    return processChatCheck(page, task, cycle, verify, journalMap, live, sendCounter, maxSends, counts, notifyItems);
  }

  if (!live) {
    recordResult(journalMap, {
      ...base,
      customerName: task.customerName,
      result: 'would-move',
      note: `dry-run: буде відправлено PUT ${config.API_BASE_URL}/leads/${task.leadId} {"id":${task.leadId},"status_id":${cycle.targetStatusId}} — запит НЕ відправлено`,
    });
    counts['would-move']++;
    notifyItems.push({ leadId: task.leadId, customerName: task.customerName, cycleKey: task.cycleKey, action: 'would-move' });
    return null;
  }

  if (isOutsideSendWindow()) {
    // Перенос статусу сам тригерить автоповідомлення KeyCRM Bot клієнту —
    // тому це так само "відправка", як і явний дубль-send нижче. Лід
    // лишається в колонці-тригері (статус не міняли) — наступний ранковий
    // прогін (9:00) підхопить його як звичайного нового кандидата, без
    // окремої логіки відновлення.
    recordResult(journalMap, { ...base, customerName: task.customerName, result: 'skipped-after-hours', note: 'перенос картки (і повідомлення клієнту, яке він тригерить) пропущено — час поза вікном 9:00-23:00, картку лишено в колонці-тригері' });
    counts['skipped-after-hours']++;
    notifyItems.push({ leadId: task.leadId, customerName: task.customerName, cycleKey: task.cycleKey, action: 'skipped-after-hours' });
    return null;
  }

  const putRes = await putLeadStatus(page, task.leadId, cycle.targetStatusId);
  if (!putRes.ok) {
    recordResult(journalMap, { ...base, customerName: task.customerName, result: 'error', note: `PUT failed: status=${putRes.status} body=${putRes.body}` });
    counts.error++;
    return null;
  }

  const verify = await verifyInColumn(page, cycle.targetLabel, task.leadId);
  if (verify.index === -1) {
    recordResult(journalMap, {
      ...base,
      customerName: task.customerName,
      result: 'error',
      note: `PUT ok (status=${putRes.status}), але картку не знайдено в колонці "${cycle.targetLabel}" — перевір вручну; якщо лід досі в "${cycle.sourceLabel}", наступний прогін підхопить його знову`,
    });
    counts.error++;
    return null;
  }
  recordResult(journalMap, { ...base, customerName: task.customerName, result: 'moved', note: `підтверджено: картка в колонці "${cycle.targetLabel}" (status=${putRes.status})` });
  counts.moved++;

  return processChatCheck(page, task, cycle, verify, journalMap, live, sendCounter, maxSends, counts, notifyItems);
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
  try {
    await ensureFreshSession(config.STORAGE_STATE_PATH);
  } catch (err) {
    console.error(`Не вдалося перевірити/оновити сесію: ${err.message}`);
    process.exit(1);
  }

  const journalMap = loadJournal();
  const browser = await chromium.launch({ headless: config.HEADLESS, args: ['--disable-gpu', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ storageState: config.STORAGE_STATE_PATH });
  const page = await context.newPage();

  const notifyItems = [];
  const countsByCycle = { A: emptyCounts(), B: emptyCounts() };
  const sendCounter = { count: 0 };
  // Спільний випадковий ліміт 15-20 на ОБИДВА цикли разом — не по 15-20 на
  // кожен окремо, щоб не подвоювати навантаження на Instagram API за прогін.
  const MAX_SENDS_PER_RUN = randomInt(15, 20);

  try {
    console.log('Шукаю лідів у колонках-тригерах і колонках "день 2" обох циклів...');
    const { toMove, toCheck } = await discoverCandidates(page);

    for (const cycle of CYCLES) {
      console.log(`Цикл ${cycle.key} ("${cycle.sourceLabel}" → "${cycle.targetLabel}"): кандидатів на перенесення: ${toMove.filter((t) => t.cycleKey === cycle.key).length}`);
    }

    const resumeChecks = toCheck.filter((t) => !journalMap.has(journalKey(t.leadId, t.cycleKey)));
    console.log(`Лідів у цільових колонках без завершеної перевірки чату (у т.ч. з попередніх незавершених прогонів): ${resumeChecks.length}`);

    let tasks = [
      ...toMove.map((t) => ({ ...t, needsMove: true })),
      ...resumeChecks.map((t) => ({ ...t, needsMove: false })),
    ];

    if (LEAD_IDS_FILTER) {
      tasks = tasks.filter((t) => LEAD_IDS_FILTER.has(t.leadId));
      console.log(`Обмеження --lead-ids= — залишаю лише ${tasks.length} завдань(-я) для лідів: ${[...LEAD_IDS_FILTER].join(', ')}`);
    }

    if (tasks.length === 0) {
      console.log('Немає завдань для обробки. Завершую.');
      await notify(`${LIVE_MODE ? '🔴' : '⚪'} check-lead-notifications.js — ${LIVE_MODE ? 'LIVE' : 'DRY-RUN'}\nЗавдань: 0. Нічого робити.`);
      return;
    }

    shuffle(tasks);
    const limited = Number.isFinite(PROCESS_LIMIT) ? tasks.slice(0, PROCESS_LIMIT) : tasks;
    if (Number.isFinite(PROCESS_LIMIT) && PROCESS_LIMIT < tasks.length) {
      console.log(`Обмеження --limit=${PROCESS_LIMIT} — обробляю перші ${limited.length} з ${tasks.length}.`);
    }
    console.log(`Ліміт дублювань на цей прогін (спільний на обидва цикли): ${MAX_SENDS_PER_RUN} (випадково в діапазоні 15-20)`);

    if (LIVE_MODE) {
      console.log('\n' + '='.repeat(70));
      console.log('УВАГА: LIVE-РЕЖИМ УВІМКНЕНО.');
      console.log('Цей запуск РЕАЛЬНО перенесе картки лідів і надсилатиме повідомлення клієнтам в Instagram Direct.');
      console.log('Зупинись зараз (Ctrl+C), якщо не впевнений(-а) в результатах dry-run.');
      console.log('='.repeat(70));
      await new Promise((resolve) => setTimeout(resolve, 5000));
      console.log('Продовжую...\n');
    } else {
      console.log('\nDRY-RUN режим (за замовчуванням) — жодних реальних змін у KeyCRM не буде.');
      console.log('Для реального запуску: node check-lead-notifications.js --live\n');
    }

    for (let i = 0; i < limited.length; i++) {
      const t = limited[i];
      const cycle = CYCLES.find((c) => c.key === t.cycleKey);
      console.log(`\n[${i + 1}/${limited.length}] Цикл ${t.cycleKey} — лід #${t.leadId} ${t.customerName || '(?)'} — ${t.needsMove ? `перенос "${cycle.sourceLabel}" → "${cycle.targetLabel}"` : 'довиконання перевірки чату'}`);
      if (i > 0) await randomProtectiveDelay(page);
      const outcome = await processTask(page, t, journalMap, LIVE_MODE, sendCounter, MAX_SENDS_PER_RUN, countsByCycle[t.cycleKey], notifyItems).catch((err) => {
        console.error(`  ВИНЯТОК: ${err.message}`);
        recordResult(journalMap, { leadId: t.leadId, cycleKey: t.cycleKey, sourceStatus: cycle.sourceLabel, targetStatus: cycle.targetLabel, slot: t.needsMove ? 'move' : 'last-1', result: 'error', note: err.message });
        countsByCycle[t.cycleKey].error++;
        return null;
      });
      if (outcome === 'RATE_LIMIT_HIT') {
        console.log(`Досягнуто спільного ліміту дублювань (${MAX_SENDS_PER_RUN}) на цей прогін — зупиняюсь, решту обробить наступний запуск.`);
        break;
      }
    }

    console.log('\n=== Підсумок ===');
    console.log(`Режим: ${LIVE_MODE ? 'LIVE (реальні дії виконано)' : 'DRY-RUN (нічого не відправлено)'}`);
    console.log(summarizeCycle(CYCLES[0], countsByCycle.A));
    console.log(summarizeCycle(CYCLES[1], countsByCycle.B));
    console.log(`Повний лог: ${LOG_PATH}`);

    const modeLabel = LIVE_MODE ? 'LIVE' : 'DRY-RUN';
    await notify(
      `${LIVE_MODE ? '🔴' : '⚪'} check-lead-notifications.js — ${modeLabel}\n` +
      `${summarizeCycle(CYCLES[0], countsByCycle.A)}\n` +
      `${summarizeCycle(CYCLES[1], countsByCycle.B)}\n` +
      `Ліміт дублювань цей прогін (спільний): ${MAX_SENDS_PER_RUN}, використано: ${sendCounter.count}` +
      formatItemsForNotify(notifyItems) +
      `\nПовний лог: ${LOG_PATH}`
    );
  } catch (err) {
    await notify(`🔴 КРИТИЧНА ПОМИЛКА в check-lead-notifications.js (${LIVE_MODE ? 'LIVE' : 'DRY-RUN'}): ${err.message}`);
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('КРИТИЧНА ПОМИЛКА в check-lead-notifications.js:', err);
  process.exit(1);
});
