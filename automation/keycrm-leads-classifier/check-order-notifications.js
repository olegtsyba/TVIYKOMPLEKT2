require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');
const { notify } = require('../notify');
const { ensureFreshSession } = require('../refresh-session');

// ---------------------------------------------------------------------------
// ПРИЗНАЧЕННЯ
// ---------------------------------------------------------------------------
// KeyCRM Bot автоматично шле клієнту повідомлення в Instagram Direct при
// кожній зміні статусу замовлення у воронці "Доставка". Якщо клієнт не
// писав понад 24 години, Meta блокує бота (помилка #10 — червоний значок
// біля повідомлення в чаті). Цей скрипт перевіряє останнє автоповідомлення
// бота для кожного замовлення в цільових статусах, і якщо доставка
// провалилась і ще ніхто вручну не продублював текст — дублює його сам.
//
// Recon 2026-08-24 (headless Playwright, route.abort() для UI-дій зі
// статусом — жодна реальна зміна не відправлялась на сервер під час
// дослідження): "Замовлення" — ОКРЕМИЙ модуль KeyCRM (/app/orders/,
// таблиця з фільтром статусів), не той kanban, що в keycrm-leads-classifier
// для лідів (/app/leads). Чат клієнта відкривається через
// рядок замовлення -> кнопка "Написати" -> попап "Існуючі діалоги" ->
// посилання на /app/conversations/{id} (окремий модуль повідомлень,
// бібліотека vue-advanced-chat, класи "vac-*"). Зміна статусу замовлення —
// не drag-and-drop і не PUT з відомим числовим status_id (як у лідів), а
// клік по статус-пігулці в розгорнутому рядку -> el-select дропдаун з
// повним списком статусів по точній назві -> кнопка "Зберегти" (підтверджено
// captured-запитом POST /orders/{id}/status/{numericId}, але сам скрипт
// навмисно керує UI за текстом, а не числовим id, щоб не залежати від
// внутрішніх id, які ми не перевіряли для кожного статусу).
//
// ВАЖЛИВО (виправлено власницею 2026-08-24, ПІСЛЯ початкового recon):
// назви статусів у KeyCRM містили одруківки на момент recon ("Прибув у
// відділенння" з трьома "н", "нагадування 7 днів" з малої літери, "Фікбек
// відмова"). Власниця виправила їх вручну в інтерфейсі. Тому весь matching
// статусів і повідомлень тут — case-insensitive і з нормалізацією пробілів
// (див. normalize()/normalizeCI()), а НЕ жорсткий symbol-in-symbol збіг,
// щоб майбутні дрібні правки тексту в KeyCRM не ламали скрипт.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ПРАПОРЦІ ЗАПУСКУ — той самий принцип, що й move-to-reminder.js /
// move-to-manual-review.js: dry-run за замовчуванням, окремий LIVE-прапор
// (CHECK_NOTIFICATIONS_LIVE), що НЕ успадковує LIVE інших скриптів.
// ---------------------------------------------------------------------------
const LIVE_MODE = process.argv.includes('--live') || process.env.CHECK_NOTIFICATIONS_LIVE === 'true';

const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const PROCESS_LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

const LOG_PATH = path.join(config.OUTPUT_DIR, 'check-order-notifications-log.jsonl');

const MAX_LISTED_IN_NOTIFY = 15;

// ---------------------------------------------------------------------------
// Статуси воронки "Доставка", які треба перевіряти, і скільки ОСТАННІХ
// повідомлень бота дивитись для кожного. "Виконано" — особливий випадок:
// може бути ДВА окремих автоповідомлення (фідбек/промокод і, якщо була
// післяплата, окремий фіскальний чек Checkbox) — обидва потребують
// перевірки. ПРИПУЩЕННЯ, не підтверджене живим прикладом на 2026-08-24
// (у recon не трапилось замовлення саме в статусі "Виконано" з двома
// повідомленнями бота) — якщо на практиці повідомлення тільки одне,
// скрипт просто перевірить наявні (botMessagesToCheck — верхня межа,
// не точна вимога).
// "Фідбек відмова" — єдиний статус, де після УСПІШНОГО дублювання
// (нашого автоматичного, не ручного) скрипт додатково переводить
// замовлення на статус "Скасовано" (afterDuplicateStatus).
//
// statusId — числовий status_id зі статусів воронки "Доставка", отриманий
// recon'ом 2026-08-25 через GET {API_BASE_URL}/orders/statuses?with_disabled=1
// (той самий ендпоінт, яким сама сторінка /app/orders/ будує фільтр-панель).
// Три "нагадування" (5/6/7 днів) НЕ показувались як чекбокси у фільтр-панелі
// на момент recon — не тому, що їх немає, а тому що KeyCRM рендерить у
// фільтрі лише статуси з orders_count > 0 (на 2026-08-25 усі три мали 0
// замовлень). Тому discoverCandidates() фільтрує напряму за цими числовими
// id через API, а не через клікабельні чекбокси — інакше ці три статуси
// назавжди лишались би недосяжними для цього скрипта, щойно в них
// з'явиться перше замовлення. Якщо власниця колись перейменує/видалить
// статус у KeyCRM, id зміниться і потребуватиме повторного recon.
// ---------------------------------------------------------------------------
const TARGET_STATUSES = [
  { label: 'Відправлено', statusId: 22, botMessagesToCheck: 1 },
  { label: 'Прибув у відділення', statusId: 33, botMessagesToCheck: 1 },
  { label: 'Нагадування 3 дні', statusId: 48, botMessagesToCheck: 1 },
  { label: 'Нагадування 5 днів', statusId: 66, botMessagesToCheck: 1 },
  { label: 'Нагадування 6 днів', statusId: 67, botMessagesToCheck: 1 },
  { label: 'Нагадування 7 днів', statusId: 68, botMessagesToCheck: 1 },
  { label: 'Виконано', statusId: 12, botMessagesToCheck: 2 },
  { label: 'Фідбек відмова', statusId: 56, botMessagesToCheck: 1, afterDuplicateStatus: 'Скасовано' },
];

// "Виконано" самотужки має тисячі замовлень (8750 на момент recon) — без
// обмеження discovery захлинався б, витягуючи роками старі завершені
// замовлення замість свіжих. Запит на кожен статус іде ОКРЕМО і
// відсортований за status_changed_at (найновіші зміни статусу першими),
// тому цей ліміт застосовується per-status: для статусів з малою кількістю
// замовлень (усі, крім "Виконано") він узагалі ніколи не спрацьовує —
// це верхня межа "про всяк випадок", не точна вимога (той самий принцип,
// що й CARDS_TO_COLLECT у config.js).
const DISCOVERY_MAX_PER_STATUS = 200;

// Результати, які означають "тут більше нічого робити не треба" — тільки
// вони потрапляють у Map при завантаженні журналу і блокують повторну
// обробку тієї самої пари (замовлення, статус, слот повідомлення) в
// майбутніх прогонах. 'would-duplicate' (dry-run) і 'error' НЕ термінальні
// навмисно — dry-run не повинен назавжди "з'їдати" кандидата, який ще не
// оброблено в LIVE, а помилки треба повторювати.
const TERMINAL_RESULTS = new Set([
  'delivered',
  'already-duplicated-manually',
  'duplicated',
  'duplicated-unverified',
  'cancelled-after-duplicate',
]);

// Окрема, НЕ термінальна позначка (не входить у TERMINAL_RESULTS) — лише
// щоб не слати повторне сповіщення про того самого кандидата щоразу.
// Навмисно не блокує звичайну обробку кандидата (recordResult не додає її
// в journalMap, бо вона не в TERMINAL_RESULTS) — це суто для дедуплікації
// самого сповіщення, читається окремо через loadFeedbackReviewAlertSet().
const FEEDBACK_REVIEW_ALERT_RESULT = 'feedback-review-alert-sent';

const SELECTORS = {
  quickSearchInput: 'input[placeholder="Швидкий пошук"]',
  orderRowExpandIcon: '.la-angle-right',
  orderNumberCell: 'td[data-title="№ замовлення"]',
  buyerCell: 'td[data-title="Покупець"]',
  statusPill: '[class*="status status--"]',
  chatInputPlaceholder: 'Введіть повідомлення...',
};

// ---------------------------------------------------------------------------
// Нормалізація тексту — і для порівняння назв статусів, і для порівняння
// тексту повідомлень (дублікат-перевірка). Навмисно НЕ жорсткий збіг
// символ-в-символ — власниця вже раз виправляла одруківки в KeyCRM
// вручну, тож майбутні дрібні правки не повинні ламати скрипт.
// ---------------------------------------------------------------------------
function normalize(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}
function normalizeCI(s) {
  return normalize(s).toLowerCase();
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
// Журнал (append-only JSONL) — і аудит-лог, і джерело істини для "чи вже
// перевірялось" (ключ: номер замовлення + статус + який за рахунком з кінця
// bot-повідомлення). Тільки TERMINAL_RESULTS потрапляють у Map, яка
// блокує повторну обробку — так dry-run прогони лишаються повторюваними
// (не "з'їдають" кандидатів), а помилки автоматично повторюються наступного
// разу.
// ---------------------------------------------------------------------------
function journalKey(orderNumber, status, slot) {
  return `${orderNumber}::${normalizeCI(status)}::${slot}`;
}

function loadJournal() {
  const map = new Map();
  if (!fs.existsSync(LOG_PATH)) return map;
  const lines = fs.readFileSync(LOG_PATH, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.botMessageSlot && TERMINAL_RESULTS.has(entry.result)) {
        map.set(journalKey(entry.orderNumber, entry.status, entry.botMessageSlot), entry);
      }
    } catch {
      // пошкоджений рядок логу — ігноруємо, не валимо весь скрипт
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Окремий прохід по тому самому журналу — які кандидати "статус з
// afterDuplicateStatus" (зараз тільки "Фідбек відмова") вже отримали
// попереджувальне Telegram-сповіщення раніше. Навмисно окремо від
// loadJournal()/journalMap, бо FEEDBACK_REVIEW_ALERT_RESULT не термінальний
// і не повинен впливати на звичайну логіку "чи вже перевірено це
// повідомлення".
// ---------------------------------------------------------------------------
function loadFeedbackReviewAlertSet() {
  const set = new Set();
  if (!fs.existsSync(LOG_PATH)) return set;
  const lines = fs.readFileSync(LOG_PATH, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.result === FEEDBACK_REVIEW_ALERT_RESULT) {
        set.add(journalKey(entry.orderNumber, entry.status, 'feedback-review-alert'));
      }
    } catch {
      // пошкоджений рядок логу — ігноруємо, не валимо весь скрипт
    }
  }
  return set;
}

function recordResult(journalMap, entry) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  fs.appendFileSync(LOG_PATH, line + '\n', 'utf-8');
  if (entry.botMessageSlot && TERMINAL_RESULTS.has(entry.result)) {
    journalMap.set(journalKey(entry.orderNumber, entry.status, entry.botMessageSlot), entry);
  }
}

function formatDuplicatedForNotify(items) {
  if (!items.length) return '';
  const shown = items.slice(0, MAX_LISTED_IN_NOTIFY);
  const lines = shown.map((i) => `  #${i.orderNumber} ${i.customerName || '(?)'} — ${i.status}`);
  let text = `\n${lines.join('\n')}`;
  if (items.length > MAX_LISTED_IN_NOTIFY) {
    text += `\n  ...і ще ${items.length - MAX_LISTED_IN_NOTIFY}, повний список у ${LOG_PATH}`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Витяг повідомлень чату. Виконується в контексті сторінки. Клас
// "vac-message-wrapper" — один запис (vue-advanced-chat). Автора беремо з
// ".vac-text-username" ("KeyCRM Bot" для бота, реальне ім'я менеджера для
// ручних повідомлень; системні записи на кшталт "X закрив(-ла) діалог" не
// мають ні username, ні тексту повідомлення — відсіюються фільтром).
// Помилку доставки (#10) видає іконка ".el-icon-error" всередині
// ".vac-message-date" замість звичайного ".el-icon-check" — підтверджено
// живим прикладом на замовленні #10189 recon'ом 2026-08-24 (скріншот +
// сирий HTML переглянуто вручну).
// ---------------------------------------------------------------------------
function extractMessages() {
  return [...document.querySelectorAll('.vac-message-wrapper')]
    .map((el) => {
      const usernameEl = el.querySelector('.vac-text-username');
      const sender = usernameEl ? usernameEl.textContent.trim() : null;
      const textWrapper = el.querySelector('.vac-format-message-wrapper');
      const text = textWrapper ? textWrapper.textContent.replace(/\s+/g, ' ').trim() : '';
      const hasError = !!el.querySelector('.vac-message-date .el-icon-error');
      const dataId = el.getAttribute('data-id');
      return { dataId, sender, text, hasError };
    })
    .filter((m) => m.sender && m.text);
}

// ---------------------------------------------------------------------------
// Пошук кандидатів: замовлення в кожному з TARGET_STATUSES.
//
// Recon 2026-08-25 показав, що клікабельні чекбокси у фільтр-панелі
// /app/orders/ НЕ надійні для цього: KeyCRM рендерить у фільтрі лише
// статуси з orders_count > 0, тож три "нагадування" (5/6/7 днів) на момент
// recon не мали чекбоксів узагалі (0 замовлень) — і навіть коли з'явиться
// перше замовлення в такому статусі, чекбокс з'явиться тільки ПІСЛЯ
// перезавантаження фільтра. Замість цього ходимо напряму на JSON API
// ({API_BASE_URL}/orders?filters[status_id]=...), яким сама сторінка
// користується під капотом — за наперед відомим числовим TARGET_STATUSES[].statusId
// (взятим з {API_BASE_URL}/orders/statuses?with_disabled=1). Це також
// вирішує другу проблему старого підходу: "Виконано" має 8750+ замовлень,
// і без обмеження на запит discovery захлинався б, гортаючи сторінки
// UI-таблиці (ліміт був ~500 карток) переважно старими "Виконано" —
// DISCOVERY_MAX_PER_STATUS разом із сортуванням за status_changed_at
// (найновіші зміни статусу першими) гарантує, що для КОЖНОГО статусу
// окремо перевіряються найсвіжіші зміни, а не перші-ліпші 500 підряд.
//
// Авторизація — Bearer-токен з localStorage (той самий authToken, яким
// керує ensureFreshSession/refresh-session.js), а не cookies: KeyCRM API
// на api.keycrm.app читає його з заголовка Authorization, тому досить
// одного разу зайти на ORDERS_URL (щоб Playwright відновив localStorage
// зі storageState) і зчитати токен — без жодного кліку по UI.
// ---------------------------------------------------------------------------
async function fetchAuthToken(page) {
  const token = await page.evaluate(() => localStorage.getItem('authToken'));
  if (!token) throw new Error('authToken не знайдено в localStorage сторінки — сесія недійсна?');
  return token;
}

async function discoverCandidates(page) {
  await page.goto(config.ORDERS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(500);
  const authToken = await fetchAuthToken(page);

  const candidates = [];
  for (const cfg of TARGET_STATUSES) {
    let pageNum = 1;
    let fetchedForStatus = 0;
    while (fetchedForStatus < DISCOVERY_MAX_PER_STATUS) {
      const params = new URLSearchParams({
        'filters[status_id]': String(cfg.statusId),
        orderBy: 'status_changed_at|desc',
        page: String(pageNum),
        per_page: '50', // API мовчки обрізає per_page до 50, як би ти не просив більше
      });
      const url = `${config.API_BASE_URL}/orders?${params.toString()}`;
      const res = await page.request.get(url, { headers: { authorization: `Bearer ${authToken}` } });
      if (!res.ok()) {
        console.warn(`ПОПЕРЕДЖЕННЯ: /orders повернув ${res.status()} для статусу "${cfg.label}" (сторінка ${pageNum}) — пропускаю решту цього статусу.`);
        break;
      }
      const body = await res.json();
      const rows = body.data || [];
      if (!rows.length) break;

      for (const o of rows) {
        candidates.push({ orderNumber: String(o.id), status: cfg.label, customerName: o.client?.full_name || null });
      }
      fetchedForStatus += rows.length;

      const lastPage = body.meta?.last_page || pageNum;
      if (pageNum >= lastPage) break;
      pageNum++;
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Зміна статусу замовлення через UI (клік по пігулці -> el-select дропдаун
// за точною назвою -> "Зберегти"). Використовується лише для особливого
// випадку "Фідбек відмова" -> "Скасовано" (крок 8 в задачі). Навігує на
// сторінку замовлень заново — самодостатня, не залежить від того, де зараз
// перебуває сторінка (може викликатись і одразу після дублювання
// повідомлення, і окремим ретраєм наступного прогону, якщо перша спроба
// не вдалась).
// ---------------------------------------------------------------------------
async function changeOrderStatus(page, orderNumber, targetLabel) {
  try {
    await page.goto(config.ORDERS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator(SELECTORS.quickSearchInput).waitFor({ state: 'visible', timeout: 30000 });
    await page.locator(SELECTORS.quickSearchInput).fill(orderNumber);
    await page.keyboard.press('Enter');
    await page.locator(SELECTORS.orderNumberCell).first().waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForTimeout(1000);

    const row = page.locator('tr', { hasText: orderNumber }).first();
    await row.locator(SELECTORS.orderRowExpandIcon).first().click();
    await page.waitForTimeout(800);

    const pillHandle = await page.evaluateHandle(
      (sel) => [...document.querySelectorAll(sel)].find((el) => el.children.length === 0 && el.offsetParent),
      SELECTORS.statusPill
    );
    const pill = pillHandle.asElement();
    if (!pill) return { ok: false, note: 'status-pill-not-found' };
    await pill.click();
    await page.waitForTimeout(800);

    const option = page
      .locator('.el-select-dropdown:visible li')
      .filter({ hasText: new RegExp(`^\\s*${escapeRegex(targetLabel)}\\s*$`, 'i') })
      .first();
    if (!(await option.count())) return { ok: false, note: `option-not-found: "${targetLabel}"` };
    await option.click();
    await page.waitForTimeout(400);

    const saveBtnAll = page.getByText('Зберегти', { exact: true });
    const saveCount = await saveBtnAll.count();
    let saveBtn = null;
    for (let i = 0; i < saveCount; i++) {
      const cand = saveBtnAll.nth(i);
      if (await cand.isVisible()) { saveBtn = cand; break; }
    }
    if (!saveBtn) return { ok: false, note: 'save-button-not-found' };
    await saveBtn.click();
    await page.waitForTimeout(1500);
    return { ok: true, note: `статус змінено на "${targetLabel}"` };
  } catch (err) {
    return { ok: false, note: err.message };
  }
}

// ---------------------------------------------------------------------------
// Обробка одного кандидата (замовлення + цільовий статус). Повертає
// 'RATE_LIMIT_HIT', якщо ліміт дублювань на цей прогін вичерпано —
// викликач має негайно зупинити цикл.
// ---------------------------------------------------------------------------
async function processCandidate(page, candidate, journalMap, live, sendCounter, maxSends, counts, notifyItems) {
  const cfg = TARGET_STATUSES.find((s) => s.label === candidate.status);

  // Перевірка leadId/orderId і імені клієнта ДО відкриття картки — той самий
  // принцип безпеки, що й у move-to-reminder.js.
  await page.goto(config.ORDERS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator(SELECTORS.quickSearchInput).waitFor({ state: 'visible', timeout: 30000 });
  await page.locator(SELECTORS.quickSearchInput).fill(candidate.orderNumber);
  await page.keyboard.press('Enter');
  await page.locator(SELECTORS.orderNumberCell).first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1000);

  const row = page.locator('tr', { hasText: candidate.orderNumber }).first();
  if (!(await row.count())) {
    recordResult(journalMap, { orderNumber: candidate.orderNumber, status: candidate.status, botMessageSlot: 'last-1', result: 'error', note: 'order-not-found-in-search' });
    counts.error++;
    return null;
  }
  await row.locator(SELECTORS.orderRowExpandIcon).first().click();
  await page.waitForTimeout(800);

  const rowInfo = await page.evaluate((sel) => {
    const cell = document.querySelector(sel.orderNumberCell);
    const tr = cell ? cell.closest('tr') : null;
    const statusEl = tr ? [...tr.querySelectorAll(sel.statusPill)].find((el) => el.children.length === 0) : null;
    const buyerEl = tr ? tr.querySelector(sel.buyerCell) : null;
    // buyerEl.textContent саме по собі includes прихований (display:none)
    // <sup class="el-badge__content">N</sup> — бейдж лічильника замовлень
    // покупця, а не частину імені (textContent читає й приховані вузли).
    // Беремо текст лише з посилання-імені, інакше "Ім'я"+"1" ніколи не
    // збіжиться з чистим client.full_name з API.
    const buyerNameEl = buyerEl ? buyerEl.querySelector('a[title="Перегляд покупця"]') : null;
    return {
      orderNumber: cell ? cell.textContent.trim() : null,
      status: statusEl ? statusEl.textContent.trim() : null,
      customerName: buyerNameEl ? buyerNameEl.textContent.trim() : (buyerEl ? buyerEl.textContent.trim() : null),
    };
  }, SELECTORS);

  if (rowInfo.orderNumber !== candidate.orderNumber || normalizeCI(rowInfo.customerName) !== normalizeCI(candidate.customerName)) {
    recordResult(journalMap, {
      orderNumber: candidate.orderNumber, status: candidate.status, botMessageSlot: 'last-1', result: 'error',
      note: `mismatch: очікували #${candidate.orderNumber} "${candidate.customerName}", знайшли #${rowInfo.orderNumber} "${rowInfo.customerName}"`,
    });
    counts.error++;
    return null;
  }
  if (normalizeCI(rowInfo.status) !== normalizeCI(candidate.status)) {
    // Статус змінився між виявленням кандидатів і обробкою (менеджер уже
    // просунув замовлення далі) — не помилка, просто застаріла черга.
    recordResult(journalMap, { orderNumber: candidate.orderNumber, status: candidate.status, botMessageSlot: 'last-1', result: 'skipped-status-changed', note: `тепер статус "${rowInfo.status}"` });
    counts['status-changed'] = (counts['status-changed'] || 0) + 1;
    return null;
  }

  const writeBtn = page.getByText('Написати', { exact: true }).first();
  if (!(await writeBtn.count())) {
    recordResult(journalMap, { orderNumber: candidate.orderNumber, status: candidate.status, botMessageSlot: 'last-1', result: 'error', note: 'write-button-not-found' });
    counts.error++;
    return null;
  }
  await writeBtn.click();
  await page.waitForTimeout(700);

  const href = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a.message__link')].find((a) => a.getAttribute('href')?.includes('/app/conversations/'));
    return a ? a.getAttribute('href') : null;
  });
  if (!href) {
    recordResult(journalMap, { orderNumber: candidate.orderNumber, status: candidate.status, botMessageSlot: 'last-1', result: 'error', note: 'no-conversation-link (немає існуючого діалогу?)' });
    counts.error++;
    return null;
  }

  await page.goto(`${config.BASE_URL}${href}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('.vac-message-wrapper').first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const messages = await page.evaluate(extractMessages);
  const botMessages = messages.filter((m) => normalizeCI(m.sender) === 'keycrm bot');
  if (!botMessages.length) {
    recordResult(journalMap, { orderNumber: candidate.orderNumber, status: candidate.status, botMessageSlot: 'last-1', result: 'error', note: 'no-bot-message-found-in-chat' });
    counts.error++;
    await saveDebugArtifacts(page, `order-${candidate.orderNumber}-no-bot-message`);
    return null;
  }

  const n = Math.min(cfg.botMessagesToCheck, botMessages.length);
  let rateLimitHit = false;

  for (let fromEnd = 1; fromEnd <= n; fromEnd++) {
    const botMsg = botMessages[botMessages.length - fromEnd];
    const slot = `last-${fromEnd}`;
    const key = journalKey(candidate.orderNumber, candidate.status, slot);

    if (journalMap.has(key)) continue; // вже перевірено в минулому прогоні

    const base = { orderNumber: candidate.orderNumber, status: candidate.status, customerName: candidate.customerName, botMessageSlot: slot, mode: live ? 'live' : 'dry-run' };

    if (!botMsg.hasError) {
      recordResult(journalMap, { ...base, result: 'delivered', note: botMsg.text.slice(0, 150) });
      counts.delivered++;
      continue;
    }

    // Помилка є — шукаємо, чи вже продубльовано вручну ПІЗНІШЕ в чаті
    // (той самий botMsg.dataId визначає позицію; порівнюємо з повним
    // масивом messages, який іде в хронологічному порядку DOM).
    const botIndexInAll = messages.findIndex((m) => m.dataId === botMsg.dataId);
    const laterMessages = messages.slice(botIndexInAll + 1);
    const manualDuplicate = laterMessages.find((m) => normalizeCI(m.sender) !== 'keycrm bot' && normalize(m.text) === normalize(botMsg.text));

    if (manualDuplicate) {
      recordResult(journalMap, { ...base, result: 'already-duplicated-manually', note: botMsg.text.slice(0, 150) });
      counts['already-duplicated-manually']++;
      continue;
    }

    if (!live) {
      recordResult(journalMap, { ...base, result: 'would-duplicate', note: `dry-run: буде відправлено копію тексту бота: ${botMsg.text.slice(0, 150)}` });
      counts['would-duplicate']++;
      notifyItems.push({ orderNumber: candidate.orderNumber, customerName: candidate.customerName, status: candidate.status });
      continue;
    }

    if (sendCounter.count >= maxSends) {
      recordResult(journalMap, { ...base, result: 'error', note: `rate-limit: ліміт ${maxSends} дублювань на прогін вичерпано, спробуємо наступного разу` });
      rateLimitHit = true;
      break;
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

      recordResult(journalMap, { ...base, result: verified ? 'duplicated' : 'duplicated-unverified', note: botMsg.text.slice(0, 150) });
      counts[verified ? 'duplicated' : 'duplicated-unverified']++;
      sendCounter.count++;
      notifyItems.push({ orderNumber: candidate.orderNumber, customerName: candidate.customerName, status: candidate.status });
      if (!verified) await saveDebugArtifacts(page, `order-${candidate.orderNumber}-${slot}-unverified-send`);
    } catch (err) {
      recordResult(journalMap, { ...base, result: 'error', note: `send-failed: ${err.message}` });
      counts.error++;
      await saveDebugArtifacts(page, `order-${candidate.orderNumber}-${slot}-send-error`);
    }
  }

  // Фідбек відмова: після УСПІШНОГО автоматичного дублювання (нашого,
  // не ручного) — додатково перевести замовлення на "Скасовано". Перевірка
  // йде по журналу (а не по локальній змінній цього виклику), щоб і
  // ретраїти невдалий cancel наступного прогону, і не зачіпати випадок
  // "already-duplicated-manually" (не наша дія, поза скоупом кроку 8).
  if (live && cfg.afterDuplicateStatus) {
    const anyDuplicatedByUs = [...journalMap.values()].some(
      (e) => e.orderNumber === candidate.orderNumber && normalizeCI(e.status) === normalizeCI(candidate.status) &&
        (e.result === 'duplicated' || e.result === 'duplicated-unverified')
    );
    const cancelKey = journalKey(candidate.orderNumber, candidate.status, 'cancel');
    if (anyDuplicatedByUs && !journalMap.has(cancelKey)) {
      const cancelResult = await changeOrderStatus(page, candidate.orderNumber, cfg.afterDuplicateStatus);
      recordResult(journalMap, {
        orderNumber: candidate.orderNumber, status: candidate.status, customerName: candidate.customerName,
        botMessageSlot: 'cancel', mode: 'live',
        result: cancelResult.ok ? 'cancelled-after-duplicate' : 'error',
        note: cancelResult.note,
      });
      if (!cancelResult.ok) counts.error++;
    }
  }

  return rateLimitHit ? 'RATE_LIMIT_HIT' : null;
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
  const counts = { delivered: 0, 'already-duplicated-manually': 0, duplicated: 0, 'duplicated-unverified': 0, 'would-duplicate': 0, error: 0, 'status-changed': 0 };
  const sendCounter = { count: 0 };
  // Випадковий ліміт 15-20 (не фіксований) — той самий дух захисту від
  // тригерів Meta, що й у випадкових затримках і перемішаній черзі.
  const MAX_SENDS_PER_RUN = randomInt(15, 20);

  try {
    console.log('Шукаю замовлення в цільових статусах воронки "Доставка"...');
    const candidates = await discoverCandidates(page);
    console.log(`Знайдено кандидатів (замовлення×статус): ${candidates.length}`);

    const stillRelevant = candidates.filter((c) => {
      const cfg = TARGET_STATUSES.find((s) => s.label === c.status);
      for (let slot = 1; slot <= cfg.botMessagesToCheck; slot++) {
        if (!journalMap.has(journalKey(c.orderNumber, c.status, `last-${slot}`))) return true;
      }
      if (cfg.afterDuplicateStatus) {
        const anyDup = [...journalMap.values()].some(
          (e) => e.orderNumber === c.orderNumber && normalizeCI(e.status) === normalizeCI(c.status) &&
            (e.result === 'duplicated' || e.result === 'duplicated-unverified')
        );
        if (anyDup && !journalMap.has(journalKey(c.orderNumber, c.status, 'cancel'))) return true;
      }
      return false;
    });
    console.log(`Після виключення вже перевірених (журнал): ${stillRelevant.length}`);

    // ---------------------------------------------------------------------
    // Окреме, помітне сповіщення для статусів з afterDuplicateStatus (зараз
    // лише "Фідбек відмова") — щоб власниця одразу помітила ПЕРШИЙ живий
    // приклад цього статусу серед звичайних cron-прогонів і встигла
    // перевірити changeOrderStatus()/логіку "Скасовано" до першого --live.
    // Спрацьовує і в dry-run (сам факт "кандидат існує" не залежить від
    // LIVE_MODE — автоматичний перехід на afterDuplicateStatus все одно
    // ніколи не станеться в dry-run, гейт на це в processCandidate()).
    // Дедуплікація — по журналу, щоб той самий кандидат не спамив
    // сповіщення щопрогону, поки лишається необробленим.
    // ---------------------------------------------------------------------
    const feedbackReviewCandidates = stillRelevant.filter((c) => {
      const cfg = TARGET_STATUSES.find((s) => s.label === c.status);
      return !!cfg?.afterDuplicateStatus;
    });
    if (feedbackReviewCandidates.length) {
      const alertedAlready = loadFeedbackReviewAlertSet();
      const freshOnes = feedbackReviewCandidates.filter(
        (c) => !alertedAlready.has(journalKey(c.orderNumber, c.status, 'feedback-review-alert'))
      );
      if (freshOnes.length) {
        const cfg = TARGET_STATUSES.find((s) => s.label === freshOnes[0].status);
        const shown = freshOnes.slice(0, MAX_LISTED_IN_NOTIFY);
        const lines = shown.map((c) => `  #${c.orderNumber} ${c.customerName || '(?)'}`);
        const extra = freshOnes.length > MAX_LISTED_IN_NOTIFY ? `\n  ...і ще ${freshOnes.length - MAX_LISTED_IN_NOTIFY}` : '';
        await notify(
          `🔔⚠️ ЗНАЙДЕНО КАНДИДАТА У СТАТУСІ "${cfg.label.toUpperCase()}" — потребує рев'ю перед --live\n` +
          lines.join('\n') + extra +
          `\nАвтоматичний перехід на "${cfg.afterDuplicateStatus}" відбувається ЛИШЕ після LIVE-дублювання повідомлення ` +
          `(цей прогін — ${LIVE_MODE ? 'LIVE' : 'DRY-RUN'}, тож жодних дій ще не виконано) — перевір changeOrderStatus() у check-order-notifications.js.`
        );
        for (const c of freshOnes) {
          recordResult(journalMap, {
            orderNumber: c.orderNumber, status: c.status, customerName: c.customerName,
            botMessageSlot: 'feedback-review-alert', result: FEEDBACK_REVIEW_ALERT_RESULT,
            note: 'Окреме сповіщення про кандидата надіслано в Telegram',
          });
        }
      }
    }

    if (stillRelevant.length === 0) {
      console.log('Немає кандидатів для перевірки. Завершую.');
      await notify(`${LIVE_MODE ? '🔴' : '⚪'} check-order-notifications.js — ${LIVE_MODE ? 'LIVE' : 'DRY-RUN'}\nКандидатів: 0. Нічого перевіряти.`);
      return;
    }

    // Черга — перемішана випадково, не строго по порядку (захист від Meta).
    shuffle(stillRelevant);
    const limited = Number.isFinite(PROCESS_LIMIT) ? stillRelevant.slice(0, PROCESS_LIMIT) : stillRelevant;
    if (Number.isFinite(PROCESS_LIMIT) && PROCESS_LIMIT < stillRelevant.length) {
      console.log(`Обмеження --limit=${PROCESS_LIMIT} — обробляю перші ${limited.length} з ${stillRelevant.length}.`);
    }
    console.log(`Ліміт дублювань на цей прогін: ${MAX_SENDS_PER_RUN} (випадково в діапазоні 15-20)`);

    if (LIVE_MODE) {
      console.log('\n' + '='.repeat(70));
      console.log('УВАГА: LIVE-РЕЖИМ УВІМКНЕНО.');
      console.log('Цей запуск РЕАЛЬНО надсилатиме повідомлення клієнтам в Instagram Direct.');
      console.log('Зупинись зараз (Ctrl+C), якщо не впевнений(-а) в результатах dry-run.');
      console.log('='.repeat(70));
      await new Promise((resolve) => setTimeout(resolve, 5000));
      console.log('Продовжую...\n');
    } else {
      console.log('\nDRY-RUN режим (за замовчуванням) — жодних повідомлень не буде надіслано.');
      console.log('Для реального запуску: node check-order-notifications.js --live\n');
    }

    for (let i = 0; i < limited.length; i++) {
      const c = limited[i];
      console.log(`\n[${i + 1}/${limited.length}] Замовлення #${c.orderNumber} — ${c.customerName || '(?)'} — статус "${c.status}"`);
      if (i > 0) await randomProtectiveDelay(page);
      const outcome = await processCandidate(page, c, journalMap, LIVE_MODE, sendCounter, MAX_SENDS_PER_RUN, counts, notifyItems).catch((err) => {
        console.error(`  ВИНЯТОК: ${err.message}`);
        recordResult(journalMap, { orderNumber: c.orderNumber, status: c.status, botMessageSlot: 'last-1', result: 'error', note: err.message });
        counts.error++;
        return null;
      });
      if (outcome === 'RATE_LIMIT_HIT') {
        console.log(`Досягнуто ліміту дублювань (${MAX_SENDS_PER_RUN}) на цей прогін — зупиняюсь, решту обробить наступний запуск.`);
        break;
      }
    }

    console.log('\n=== Підсумок ===');
    console.log(`Режим: ${LIVE_MODE ? 'LIVE (реальні дії виконано)' : 'DRY-RUN (нічого не відправлено)'}`);
    console.log(`Доставлено без помилок: ${counts.delivered}`);
    console.log(`Вже продубльовано вручну: ${counts['already-duplicated-manually']}`);
    console.log(`${LIVE_MODE ? 'Продубльовано' : 'Буде продубльовано (dry-run)'}: ${LIVE_MODE ? counts.duplicated + counts['duplicated-unverified'] : counts['would-duplicate']}`);
    console.log(`Змінили статус до обробки (пропущено): ${counts['status-changed']}`);
    console.log(`Помилок: ${counts.error}`);
    console.log(`Повний лог: ${LOG_PATH}`);

    const modeLabel = LIVE_MODE ? 'LIVE' : 'DRY-RUN';
    const duplicatedTotal = LIVE_MODE ? counts.duplicated + counts['duplicated-unverified'] : counts['would-duplicate'];
    await notify(
      `${LIVE_MODE ? '🔴' : '⚪'} check-order-notifications.js — ${modeLabel}\n` +
      `Кандидатів перевірено: ${limited.length}\n` +
      `Доставлено без помилок: ${counts.delivered}\n` +
      `Вже продубльовано вручну: ${counts['already-duplicated-manually']}\n` +
      `${LIVE_MODE ? 'Продубльовано автоматично' : 'Буде продубльовано (dry-run)'}: ${duplicatedTotal}` +
      formatDuplicatedForNotify(notifyItems) +
      `${counts['status-changed'] ? `\nЗамовлення змінили статус до обробки: ${counts['status-changed']}` : ''}` +
      `${counts.error ? `\nПомилок: ${counts.error} — перевір лог ${LOG_PATH}` : ''}`
    );
  } catch (err) {
    await notify(`🔴 КРИТИЧНА ПОМИЛКА в check-order-notifications.js (${LIVE_MODE ? 'LIVE' : 'DRY-RUN'}): ${err.message}`);
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('КРИТИЧНА ПОМИЛКА в check-order-notifications.js:', err);
  process.exit(1);
});
