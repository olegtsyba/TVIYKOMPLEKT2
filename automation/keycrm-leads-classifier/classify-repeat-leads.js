require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const { notify } = require('../notify');
const { ensureFreshSession } = require('../refresh-session');

// ---------------------------------------------------------------------------
// ПРИЗНАЧЕННЯ (dry-run, класифікація — жодних дій у KeyCRM не виконує)
// ---------------------------------------------------------------------------
// Задача Крістіни (2026-09-08): знайти клієнтів, які ПОВТОРНО звернулись
// після паузи в спілкуванні і виявили конкретний намір купити — і для таких
// (в майбутньому LIVE-режимі) додати нову картку у воронку "Продажі"
// (pipeline_id=1, підтверджено recon'ом двома незалежними джерелами:
// dropdown "Воронка" на вже існуючій картці цього ж pipeline_id, і дефолтне
// значення того самого поля при створенні нової картки).
//
// Recon-висновки, на яких побудований цей скрипт (див. пам'ять
// keycrm_sales_pipeline_dupe_check_recon.md /
// keycrm_sales_pipeline_add_card_ui_flow.md):
//   - Немає API-фільтра "чи в контакту вже є активна картка" — GET /leads
//     ігнорує query-параметри (contact_id/client_id/pipeline_id), перевірено
//     контрольним тестом зі сміттєвим параметром.
//   - Блок "Картки у воронках" (те, що Крістіна називає "Активні картки у
//     воронках") НЕ рендериться в чат-модалці ліда — ні для неприв'язаного
//     контакту, ні для контакту з 3 попередніми картками (перевірено
//     живим кліком на обох). Він існує ТІЛЬКИ на сторінці покупця
//     /app/clients/{clientId}, вкладка з id="tab-leads".
//   - client_id для навігації беремо напряму з API-об'єкта ліда
//     (contact.client_id, GET /leads/pipelines/desk/1) — жодного
//     додаткового скрапу не потрібно.
//
// Через відсутність API-фільтра скрипт читає ВЕСЬ борд "Продажі" (усі 21
// колонку, з пагінацією кожної) і сам вирішує, які картки вартують уваги.
// Повний борд станом на 2026-09-08 — це ~223 відкриті картки; відкривати
// кожну в Playwright щоразу — дорого й повільно. Тому скрипт:
//   1. Одразу відсіює картки в 4 колонках активного циклу нагадувань
//      (див. ACTIVE_REMINDER_STATUS_IDS), без відкриття картки взагалі —
//      ЦЕ СУТО PERF-ОПТИМІЗАЦІЯ (не оцінка наміру), лишена НЕЗМІННОЮ у
//      виправленні 2026-09-09 нижче й потребує окремого рев'ю: картка
//      МОЖЕ фізично лежати в такій колонці й мати вже нове повідомлення
//      клієнтки з наміром купити, а цей пре-фільтр її все одно відсіє,
//      не заглядаючи в чат.
//   2. З решти бере ТОП-N (--limit, за замовчуванням 30) НАЙНОВІШЕ
//      оновлених карток (updated_at) — це наближення до "переглянути
//      відкриті чати" в дусі відео-інструкції: за призначенням скрипт
//      запускається кожні 1-2 години, тож нас цікавлять чати з активністю
//      ПІСЛЯ попереднього прогону, а не весь борд щоразу. Це дизайн-рішення
//      варте окремого підтвердження з Крістіною/власницею перед LIVE —
//      не гарантія, що це саме той критерій, який вона мала на увазі.
//
// LIVE-дій тут немає взагалі (на відміну від check-lead-notifications.js
// тощо) — це виключно розвідувальна класифікація. Останній крок для
// кандидатів на додавання картки — це ПЕРЕВІРКА (навігація на сторінку
// покупця, підтвердження наявності кнопки "Додати картку у воронку"), а не
// сам клік. Наступний крок (реальне додавання) — окремий скрипт зі своїм
// LIVE-прапором, за встановленою в цьому репо конвенцією.
//
// ВИПРАВЛЕННЯ 2026-09-09 (уточнення Крістіни): виняток №3 ("уже в циклі
// нагадувань") раніше був ПОСТІЙНИМ — будь-яке повідомлення "KeyCRM Bot"
// десь в історії чату (навіть старе) одразу давало verdict=skip, ще ДО
// виклику Claude. Це неправильно: наявність старого бот-повідомлення сама
// по собі не має значення, якщо клієнтка вже написала НОВЕ повідомлення з
// явним наміром купити. Тепер увесь діалог (бот-повідомлення включно)
// передається в Claude, і рішення приймається лише за ОСТАННІМ
// повідомленням клієнтки (див. exception="3_bot_reminder_no_new_intent" у
// PROMPT_TEMPLATE). Пре-фільтр за колонкою (ACTIVE_REMINDER_STATUS_IDS,
// п.1 вище) під цю зміну НЕ підпадав — лишений як є, окремим питанням.
// ---------------------------------------------------------------------------

const MODEL = 'claude-sonnet-5';

const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 30;

const leadIdsArg = process.argv.find((a) => a.startsWith('--lead-ids='));
const LEAD_IDS_FILTER = leadIdsArg ? new Set(leadIdsArg.split('=')[1].split(',').map((s) => s.trim())) : null;

const SKIP_NAV_CHECK = process.argv.includes('--no-nav-check');

// Виняток №3 за колонкою — обидва цикли нагадувань (check-lead-notifications.js).
const ACTIVE_REMINDER_STATUS_IDS = new Set([342, 144, 343, 336]);

const OUTPUT_PATH = path.join(config.OUTPUT_DIR, 'repeat-leads-classification.json');

const SELECTORS = {
  columnTitle: '.column-title__text',
  boardCard: '.lead-card.clickable',
  columnScrollContainer: '.column-content.scrollable',
  modal: '.el-dialog.lead-full-card',
  modalTitle: '.lead-title',
  closeButton: '.dialog-close',
  communicationTabItem: '.el-tabs__item',
  messagesContainer: '.entity-messages',
  messageItem: '.message',
};

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

function normalize(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}
function stripChatPrefix(text) {
  return text ? text.replace(/^\s*Чат\s*з\s*/i, '').trim() : null;
}

// ---------------------------------------------------------------------------
// Anthropic credit-exhaustion helper — ідентично classify-leads.js.
// ---------------------------------------------------------------------------
function isCreditExhaustedError(err) {
  if (err instanceof Anthropic.APIError && err.status === 402) return true;
  if (err?.error?.error?.type === 'billing_error') return true;
  if (typeof err?.message === 'string' && err.message.includes('credit balance is too low')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Discovery — весь борд pipeline 1, усі колонки, з пагінацією кожної.
// Узагальнення fetchLeadsForStatuses з check-lead-notifications.js (там —
// лише 4 обрані статуси, тут — усі колонки борду).
// ---------------------------------------------------------------------------
async function fetchDeskPage(page, authToken, pageNum) {
  const url = `${config.API_BASE_URL}/leads/pipelines/desk/1?page=${pageNum}`;
  const res = await page.request.get(url, { headers: { authorization: `Bearer ${authToken}` } });
  if (!res.ok()) {
    throw new Error(`GET /leads/pipelines/desk/1 (сторінка ${pageNum}) повернув ${res.status()}`);
  }
  return res.json();
}

async function fetchAllOpenLeads(page, authToken) {
  const first = await fetchDeskPage(page, authToken, 1);
  const columnsMeta = first.map((c) => ({ id: c.id, title: c.title }));
  const byStatus = new Map(columnsMeta.map((c) => [c.id, []]));

  let pageNum = 1;
  let body = first;
  for (;;) {
    let keepGoing = false;
    for (const col of body) {
      const leadsBlock = col.leads;
      if (!leadsBlock) continue;
      const lastPage = leadsBlock.last_page || 1;
      if (pageNum <= lastPage) byStatus.get(col.id).push(...(leadsBlock.data || []));
      if (pageNum < lastPage) keepGoing = true;
    }
    if (!keepGoing) break;
    pageNum++;
    body = await fetchDeskPage(page, authToken, pageNum);
  }

  const columnTitleByStatus = new Map(columnsMeta.map((c) => [c.id, c.title]));
  const allLeads = [];
  for (const [statusId, leads] of byStatus) {
    for (const l of leads) allLeads.push(l);
  }
  return { allLeads, columnTitleByStatus };
}

function extractLeadName(l) {
  return stripChatPrefix(l.title) || l.contact?.full_name || null;
}

// ---------------------------------------------------------------------------
// Навігація дошкою — ідентично collect-leads.js / check-lead-notifications.js.
// ---------------------------------------------------------------------------
async function getColumnByExactTitle(page, exactTitle) {
  const columnTitle = page
    .locator(SELECTORS.columnTitle)
    .filter({ hasText: new RegExp(`^\\s*${exactTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) });
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

async function openCommunicationTab(page) {
  const modal = page.locator(`${SELECTORS.modal}:visible`);
  await modal.waitFor({ state: 'visible', timeout: 30000 });
  const commTab = modal.locator(SELECTORS.communicationTabItem, { hasText: 'Спілкування' }).first();
  await commTab.click();
  await modal.locator(`${SELECTORS.messagesContainer} ${SELECTORS.messageItem}`).first()
    .waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  return modal;
}

// Ідентично collect-leads.js extractDialog — direction/sender/text/dateLabel,
// потрібні саме тут (не vac-message-wrapper з check-lead-notifications.js,
// у якого немає ні напрямку, ні дати повідомлення).
async function extractDialog(page) {
  return page.evaluate(({ modalSel, titleSel, containerSel, itemSel }) => {
    const dialog = [...document.querySelectorAll(modalSel)].find((el) => !!el.offsetParent);
    if (!dialog) return null;

    const titleEl = dialog.querySelector(titleSel);
    const titleText = titleEl ? titleEl.textContent.trim() : null;
    const customerName = titleText ? titleText.replace(/^Чат\s*з\s*/i, '').trim() : null;

    const panes = [...dialog.querySelectorAll('.el-tab-pane')];
    const activePane = panes.find((p) => p.getBoundingClientRect().width > 50);
    const container = activePane ? activePane.querySelector(containerSel) : null;
    if (!container) return { customerName, messages: [], rawText: '' };

    const msgEls = [...container.querySelectorAll(itemSel)];
    let lastIncomingName = null;
    let lastOutgoingName = null;

    const messages = msgEls
      .map((m) => {
        const textEl = m.querySelector('.message__text');
        const nameEl = m.querySelector('.message__name');
        const dateEl = m.querySelector('.message__date');
        const metaEl = m.querySelector('.message__meta');

        const direction = textEl && textEl.classList.contains('incoming')
          ? 'incoming'
          : (textEl && textEl.classList.contains('outgoing') ? 'outgoing' : null);

        let sender = nameEl ? nameEl.textContent.trim() : null;
        if (sender) {
          if (direction === 'incoming') lastIncomingName = sender;
          else if (direction === 'outgoing') lastOutgoingName = sender;
        } else if (direction === 'incoming') {
          sender = lastIncomingName;
        } else if (direction === 'outgoing') {
          sender = lastOutgoingName;
        }

        let text = '';
        if (textEl) {
          const clone = textEl.cloneNode(true);
          clone.querySelectorAll('.message__link').forEach((a) => a.remove());
          text = clone.textContent.trim();
        }

        return {
          direction,
          sender,
          text,
          dateLabel: dateEl ? dateEl.textContent.trim() : null,
          meta: metaEl ? metaEl.textContent.replace(/\s+/g, ' ').trim() : null,
        };
      })
      .filter((m) => m.text);

    const rawText = messages
      .map((m) => `[${m.direction || '?'}] ${m.sender || (m.direction === 'incoming' ? 'Клієнт' : 'Менеджер')} (${m.dateLabel || '?'}): ${m.text}`)
      .join('\n');

    return { customerName, messages, rawText };
  }, {
    modalSel: SELECTORS.modal,
    titleSel: SELECTORS.modalTitle,
    containerSel: SELECTORS.messagesContainer,
    itemSel: SELECTORS.messageItem,
  });
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
// Claude-класифікація
// ---------------------------------------------------------------------------
const EXCEPTION_VALUES = [
  'none',
  '1_feedback_not_intent',
  '2_recent_active_conversation',
  '3_bot_reminder_no_new_intent',
  '4_explicit_decline',
  'no_gap_detected',
  'no_purchase_intent',
];

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['add_card', 'skip'] },
    exception: { type: 'string', enum: EXCEPTION_VALUES },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    gap_summary: { type: 'string' },
    last_client_message_quote: { type: 'string' },
    rationale: { type: 'string' },
  },
  required: ['verdict', 'exception', 'confidence', 'gap_summary', 'last_client_message_quote', 'rationale'],
  additionalProperties: false,
};

const PROMPT_TEMPLATE = `Ти аналізуєш переписку менеджера інтернет-магазину жіночого спортивного одягу з клієнткою в Instagram Direct (через KeyCRM). Кожне повідомлення в переписці нижче позначене напрямком [incoming] (від клієнта) або [outgoing] (від менеджера/бота) та відносною датою в дужках.

Поточна дата й час (Київ): {now_kyiv}

ЗАВДАННЯ: визначити, чи це "ПОВТОРНЕ звернення після паузи в спілкуванні з явним наміром купити" — випадок, коли клієнтка написала знову (тиждень, місяць, рік тому були останні активні повідомлення — точний термін неважливий) і в її ОСТАННЬОМУ повідомленні є конкретний намір купити (питання про ціну, прохання надіслати розмірну сітку, прохання про додаткові фото товару, прямі питання "де замовити"/"як оформити" тощо).

Якщо так — verdict="add_card". В усіх інших випадках — verdict="skip", і exception має пояснювати чому.

ЧОТИРИ ВИНЯТКИ (якщо застосовується хоч один — verdict="skip"):

1. exception="1_feedback_not_intent" — останнє повторне повідомлення клієнтки це просто відгук, подяка, або фото клієнтки в вже купленому одязі (зворотний зв'язок від задоволеної покупки), БЕЗ жодного натяку на новий намір купити щось ЗАРАЗ. Розрізняй: фото клієнтки В одязі (носить те, що вже купила) — це відгук (виняток 1); прохання надіслати фото ТОВАРУ (додаткові фото моделі, яку клієнтка хоче купити) — це НАВПАКИ ознака наміру купити (не виняток).

2. exception="2_recent_active_conversation" — останнє повідomлення клієнтки написане вчора або сьогодні, БЕЗ реальної тривалої паузи перед ним (тобто це продовження поточної активної розмови, а не "нове" повторне звернення після затишшя). Якщо перед останнім повідомленням клієнтки була помітна пауза (принаймні кілька днів без жодних повідомлень з обох сторін) — це НЕ цей виняток, навіть якщо саме останнє повідомлення написане недавно.

3. exception="3_bot_reminder_no_new_intent" — НЕ постійний виняток. У переписці МОЖЕ бути автоматичне повідомлення від "KeyCRM Bot" (нагадування, знижка тощо) — саме по собі це НЕ підстава для skip. Дивись лише на ОСТАННЄ повідомлення клієнтки:
   - якщо після бот-повідомлення клієнтка НЕ писала нічого нового (останнє повідомлення в діалозі — від менеджера/бота, тобто клієнтка просто промовчала після нагадування) — це skip, exception="3_bot_reminder_no_new_intent".
   - якщо після бот-повідомлення клієнтка написала НОВЕ повідomлення з конкретним наміром купити (питає ціну, розмір, колір, фото товару, "де замовити"/"як оформити" тощо) — це verdict="add_card", exception="none", НАВІТЬ якщо десь раніше в історії є старе бот-повідomлення.
   - якщо клієнтка написала нове повідomлення, але воно НЕ показує наміру купити (привітання, щось не по темі) — це skip, exception="no_purchase_intent" (не 3-й виняток).

4. exception="4_explicit_decline" — клієнтка ЯВНО відповіла відмовою на пропозицію/нагадування менеджера чи бота ("не актуально", "дякую, не треба", "вже не потрібно" тощо) — це пряма відмова, не намір купити.

Додаткові випадки skip (без застосування до 4 винятків Крістіни, але теж НЕ додавати картку):
- exception="no_gap_detected" — немає ознак реальної паузи в спілкуванні взагалі (це просто звичайна активна розмова без розриву, старіша за "вчора", але й без чіткого розриву-паузи — рідкісний випадок, обирай тільки якщо exception 2 явно не підходить).
- exception="no_purchase_intent" — пауза є, клієнтка написала знову, але в останньому повідомленні НЕМАЄ конкретного наміру купити (просто привітання, загальне питання не по товару, спам тощо).
- exception="none" — використовуй ТІЛЬКИ разом з verdict="add_card".

ВАЖЛИВО:
- Оцінюй саме ОСТАННЄ повідомлення клієнтки (напрямок [incoming]) у переписці — не проміжні.
- "gap_summary" — коротко українською опиши паузу, яку ти визначила (наприклад: "Останній обмін повідомленнями 14.03.2026, наступне повідомлення клієнтки — 20.08.2026, пауза ~5 місяців" або "Пауза не виявлена").
- "last_client_message_quote" — процитуй дослівно останнє повідомлення клієнтки, на основі якого ти зробила висновок.

Ось переписка:
{dialog_text}

Дай відповідь СУВОРО у форматі JSON, без жодного іншого тексту, за схемою: {"verdict": "add_card/skip", "exception": "...", "confidence": "high/medium/low", "gap_summary": "...", "last_client_message_quote": "...", "rationale": "1-3 речення обґрунтування українською"}`;

function nowKyiv() {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv', dateStyle: 'full', timeStyle: 'short',
  }).format(new Date());
}

async function classifyDialog(client, dialog) {
  const prompt = PROMPT_TEMPLATE
    .replace('{now_kyiv}', nowKyiv())
    .replace('{dialog_text}', dialog.rawText || '(порожня переписка)');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Відповідь моделі не містить текстового блоку.');
  return JSON.parse(textBlock.text);
}

// ---------------------------------------------------------------------------
// Dry-run навігаційна перевірка: чи справді для цього client_id можна
// дістатись до кнопки "Додати картку у воронку" (сторінка покупця,
// вкладка #tab-leads). НІЧОГО не клікає далі — жодного створення картки.
// ---------------------------------------------------------------------------
async function verifyAddCardReachable(page, clientId, leadId) {
  try {
    await page.goto(`${config.BASE_URL}/app/clients/${clientId}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(800);

    const tabLeads = page.locator('#tab-leads').first();
    if (!(await tabLeads.count())) {
      return { reachable: false, note: 'tab-leads не знайдено на сторінці клієнта' };
    }
    await tabLeads.click();
    await page.waitForTimeout(800);

    const addBtn = page.locator('button, .el-button', { hasText: 'Додати картку у воронку' }).first();
    const addCount = await addBtn.count();
    if (!addCount) {
      await saveDebugArtifacts(page, `nav-check-${leadId}-no-add-button`);
      return { reachable: false, note: 'кнопку "Додати картку у воронку" не знайдено на вкладці' };
    }

    return { reachable: true, note: 'кнопка "Додати картку у воронку" підтверджена на сторінці клієнта' };
  } catch (err) {
    return { reachable: false, note: `помилка навігації: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  ensureDirs();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Помилка: ANTHROPIC_API_KEY не задано у файлі .env.');
    process.exit(1);
  }

  await ensureFreshSession(config.STORAGE_STATE_PATH);

  const browser = await chromium.launch({
    headless: config.HEADLESS,
    args: ['--disable-gpu', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ storageState: config.STORAGE_STATE_PATH, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  const results = [];

  try {
    console.log('Переходжу на дошку "Продажі" та читаю authToken...');
    await page.goto(config.LEADS_URL, { waitUntil: 'domcontentloaded' });
    await page.locator(SELECTORS.columnTitle).first().waitFor({ state: 'visible', timeout: 30000 });
    const authToken = await page.evaluate(() => localStorage.getItem('authToken'));
    if (!authToken) throw new Error('authToken не знайдено в localStorage — сесія недійсна?');

    console.log('Завантажую весь борд pipeline "Продажі" (API, з пагінацією кожної колонки)...');
    const { allLeads, columnTitleByStatus } = await fetchAllOpenLeads(page, authToken);
    console.log(`Усього карток на борді: ${allLeads.length}`);

    const preFiltered = [];
    let skippedByColumn = 0;
    for (const l of allLeads) {
      if (ACTIVE_REMINDER_STATUS_IDS.has(l.status_id)) {
        skippedByColumn++;
        results.push({
          leadId: String(l.id),
          customerName: extractLeadName(l),
          statusId: l.status_id,
          statusTitle: columnTitleByStatus.get(l.status_id) || null,
          verdict: 'skip',
          exception: '3_already_in_funnel_column',
          recommendedAction: 'Завершити діалог (вже в активному циклі нагадувань KeyCRM Bot)',
          confidence: 'high',
          rationale: `Картка в колонці "${columnTitleByStatus.get(l.status_id)}" — активний цикл нагадувань, виняток №3 за колонкою.`,
          source: 'column-pre-filter',
        });
        continue;
      }
      preFiltered.push(l);
    }
    console.log(`Відсіяно за колонкою (виняток №3, активний цикл нагадувань): ${skippedByColumn}`);

    let candidates;
    if (LEAD_IDS_FILTER) {
      candidates = preFiltered.filter((l) => LEAD_IDS_FILTER.has(String(l.id)));
      console.log(`--lead-ids вказано: обробляю ${candidates.length} з ${LEAD_IDS_FILTER.size} запитаних (решта, ймовірно, у відсіяних колонках).`);
    } else {
      candidates = [...preFiltered].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, LIMIT);
      console.log(`Беру ТОП-${LIMIT} найновіше оновлених карток (з ${preFiltered.length} залишку після відсіву колонки).`);
    }

    const client = new Anthropic();
    const counts = { add_card: 0, skip: 0, error: 0 };

    for (let i = 0; i < candidates.length; i++) {
      const l = candidates[i];
      const leadId = String(l.id);
      const customerName = extractLeadName(l);
      const statusTitle = columnTitleByStatus.get(l.status_id) || null;
      console.log(`\n[${i + 1}/${candidates.length}] leadId=${leadId} "${customerName || '(без імені)'}" (колонка: ${statusTitle})...`);

      try {
        const column = await getColumnByExactTitle(page, statusTitle);
        await ensureAllCardsLoaded(page, column);
        const { index, cards } = await findCardIndexById(column, leadId);
        if (index === -1) {
          results.push({ leadId, customerName, statusId: l.status_id, statusTitle, verdict: 'skip', exception: 'error', confidence: null, rationale: 'Картку не знайдено в DOM колонки (могла змінити статус між discovery і обробкою).', source: 'error' });
          counts.error++;
          continue;
        }
        await cards.nth(index).scrollIntoViewIfNeeded();
        await cards.nth(index).dblclick();
        await openCommunicationTab(page);
        await page.waitForTimeout(1200);

        const dialog = await extractDialog(page);
        await closeCard(page);

        if (!dialog || !dialog.messages.length) {
          results.push({ leadId, customerName, statusId: l.status_id, statusTitle, verdict: 'skip', exception: 'no_client_message', confidence: 'high', rationale: 'Порожня переписка або не вдалось прочитати діалог.', source: 'rule' });
          counts.skip++;
          continue;
        }

        const hasIncoming = dialog.messages.some((m) => m.direction === 'incoming');
        if (!hasIncoming) {
          results.push({ leadId, customerName, statusId: l.status_id, statusTitle, verdict: 'skip', exception: 'no_client_message', confidence: 'high', rationale: 'У переписці немає жодного повідомлення від клієнтки.', source: 'rule' });
          counts.skip++;
          continue;
        }

        const classification = await classifyDialog(client, dialog);
        console.log(`  verdict=${classification.verdict} exception=${classification.exception} (${classification.confidence})`);

        const entry = {
          leadId, customerName, statusId: l.status_id, statusTitle,
          verdict: classification.verdict,
          exception: classification.exception,
          confidence: classification.confidence,
          gapSummary: classification.gap_summary,
          lastClientMessageQuote: classification.last_client_message_quote,
          rationale: classification.rationale,
          clientId: l.contact?.client_id || null,
          source: 'claude',
        };

        if (classification.verdict === 'add_card') {
          counts.add_card++;
          if (!SKIP_NAV_CHECK && entry.clientId) {
            console.log(`  Кандидат на додавання картки — перевіряю досяжність кнопки на сторінці клієнта ${entry.clientId}...`);
            const nav = await verifyAddCardReachable(page, entry.clientId, leadId);
            entry.dryRunNavCheck = nav;
            console.log(`  nav-check: ${nav.reachable ? 'OK' : 'ПРОБЛЕМА'} — ${nav.note}`);
          } else if (!entry.clientId) {
            entry.dryRunNavCheck = { reachable: false, note: 'contact.client_id відсутній — контакт ще не прив\'язаний до покупця, спершу треба "Зберегти покупця" в самому ліді' };
          }
        } else {
          counts.skip++;
        }

        results.push(entry);
      } catch (err) {
        console.error(`  Помилка обробки картки: ${err.message}`);
        await saveDebugArtifacts(page, `repeat-lead-${leadId}-error`);
        await closeCard(page).catch(() => {});
        results.push({ leadId, customerName, statusId: l.status_id, statusTitle, verdict: 'skip', exception: 'error', confidence: null, rationale: `ПОМИЛКА: ${err.message}`, source: 'error' });
        counts.error++;
      }
    }

    console.log('\n\n=== Результати класифікації (dry-run) ===\n');
    console.table(
      results.map((r) => ({
        leadId: r.leadId,
        'Клієнт': r.customerName || '(без імені)',
        'Колонка': r.statusTitle,
        'Вердикт': r.verdict,
        'Виняток': r.exception,
        'Впевненість': r.confidence || '-',
        'Nav-check': r.dryRunNavCheck ? (r.dryRunNavCheck.reachable ? 'OK' : 'FAIL') : '-',
      }))
    );

    const addCardCandidates = results.filter((r) => r.verdict === 'add_card');
    console.log(`\nВсього оброблено: ${results.length}. Кандидатів на додавання картки: ${addCardCandidates.length}.`);
    if (addCardCandidates.length) {
      console.log('Кандидати:');
      for (const c of addCardCandidates) {
        console.log(`  #${c.leadId} ${c.customerName} — ${c.rationale} [nav-check: ${c.dryRunNavCheck?.reachable ? 'OK' : 'FAIL/' + c.dryRunNavCheck?.note}]`);
      }
    }

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`\nЗбережено у: ${OUTPUT_PATH}`);
  } catch (err) {
    console.error('Критична помилка:', err.message);
    await saveDebugArtifacts(page, 'fatal-error');
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2), 'utf-8');
    const prefix = isCreditExhaustedError(err)
      ? '🔴 ЗАКІНЧИЛИСЬ КРЕДИТИ ANTHROPIC, поповни баланс на https://platform.claude.com/settings/billing\n'
      : '🔴 КРИТИЧНА ПОМИЛКА в classify-repeat-leads.js: ';
    await notify(`${prefix}${err.message}`);
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
