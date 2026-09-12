require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const { notify } = require('../notify');
const { ensureFreshSession } = require('../refresh-session');

// ---------------------------------------------------------------------------
// ПРИЗНАЧЕННЯ — виправлена discovery-логіка (уточнення Крістіни 2026-09-12)
// ---------------------------------------------------------------------------
// Попередні скрипти (classify-repeat-leads.js, move-to-sales.js) шукали
// кандидатів СЕРЕД КАРТОК, що вже лежать у воронках. Три повні скани
// (176 -> 252 -> 264 картки) дали нуль кандидатів — бо шукали не там.
//
// Правильне джерело — розділ "Чати" (/app/conversations), а цільовий лід —
// це чат, у якого НЕМАЄ активної картки в ЖОДНІЙ воронці, і в якому
// клієнтка писала раніше, замовкла, а потім повернулась.
//
// Чому 94.6% відкритих чатів взагалі не мають картки (і це нормально):
// коли лід відхиляють — картку прибирають з воронки; коли покупка
// завершується — чат іде у "Відгуки" й теж зрештою відхиляється; відмова
// на пошті — "Фідбек відмова" і теж відхилення. Тобто вся повністю
// оброблена історія природно лишається "без картки". Тому discovery
// ОБОВ'ЯЗКОВО обмежена часовим вікном (--window), а не всією історією:
// вікно 2 доби дає ~438 чатів (~119 без картки) замість 9656 (~9132).
//
// Recon-висновки, на яких побудований скрипт (2026-09-12, read-only):
//   - Список чатів: GET /conversations?filters[type]=opened&per_page=200&page=N
//     Відсортований за updated_at СПАДАННЯМ (перевірено на 400 записах
//     поспіль) -> часове вікно реалізується ранньою зупинкою пагінації:
//     2 доби = 3 запити, 2 години = 1 запит (замість 49 на весь список).
//     Серверного фільтра за датою немає (filters[updated_at][from] тощо -> 500).
//   - Фільтр "тільки без відповіді" прибирати не треба: API за
//     замовчуванням його не застосовує (filters[unanswered]=1 -> 0 чатів).
//   - updated_at == last_message.created_at у 396 з 400 чатів (решта
//     розходиться на 10-27 секунд), і існує завжди -> беремо updated_at.
//   - "Чи є активна картка" — UI-лічильник "Активні картки у воронках"
//     наповнює GET /leads/by-contact/{contact_id}. Але для масової
//     перевірки дешевше прочитати дошки всіх воронок і скласти множину
//     contact_id: 21 запит замість одного на кожен чат. Збіг двох способів
//     перевірено — 65 із 65.
//   - Повідомлення: GET /conversations/{id}/messages?cursor=true віддає
//     лише 20 найновіших. У чатах, де боти накидали розсилок, останнє
//     повідомлення клієнтки в це вікно НЕ потрапляє (бачив на conv=9552,
//     23462) -> обов'язкова пагінація вглиб через next_page_url (?after=).
//   - Створення картки: POST /leads, тіло перехоплено з кнопки
//     "Додати картку у воронку" в панелі чату (.chat-active-leads__add на
//     /app/conversations/{id}), заблоковано route.abort(), картку не
//     створено (перевірено повторним GET). Саме цей варіант, а не кнопка
//     на сторінці клієнта — та надсилає contact_id: null, тобто картка не
//     була б прив'язана до контакту чату.
//
// За замовчуванням — DRY-RUN. Live-режим — окремий прапор, НЕ успадковує
// APPLY_LIVE/MOVE_TO_REMINDER_LIVE/MOVE_TO_SALES_LIVE (той самий принцип
// ізоляції прапорів, що й у решті скриптів репо).
// ---------------------------------------------------------------------------

const MODEL = 'claude-sonnet-5';
const LEADS_API_BASE = 'https://tviykomplekt.api.keycrm.app';

const SALES_PIPELINE_ID = 1;
const SALES_NEW_LEAD_STATUS_ID = 1; // "Новий лід" у воронці "Продажі"
const DEFAULT_SOURCE_ID = 1; // те, що підставляє сама KeyCRM у формі швидкого додавання
const SOURCE_PIPELINES_FOR_CARD_CHECK = [1, 16, 27]; // усі наявні воронки

const CONVERSATIONS_PER_PAGE = 200;
const MESSAGES_MAX_PAGES = 5; // 5 x 20 = 100 повідомлень углиб у пошуках вхідного

const LIVE_MODE = process.argv.includes('--live') || process.env.ADD_CARDS_FROM_CHATS_LIVE === 'true';

function argValue(name) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : null;
}

// --window=2d / 2h / 90m — скільки останньої активності брати
function parseWindow(raw) {
  const value = raw || '2d';
  const m = /^(\d+)([dhm])$/.exec(value.trim());
  if (!m) throw new Error(`Незрозумілий --window="${value}". Приклади: 2d, 2h, 90m.`);
  const n = parseInt(m[1], 10);
  const ms = m[2] === 'd' ? 86400000 : m[2] === 'h' ? 3600000 : 60000;
  return { label: value, ms: n * ms };
}

const WINDOW = parseWindow(argValue('window'));
const GAP_DAYS = parseFloat(argValue('gap-days') || '7');
const LIMIT = parseInt(argValue('limit') || '50', 10);
const convIdsArg = argValue('conversation-ids');
const CONV_IDS_FILTER = convIdsArg ? new Set(convIdsArg.split(',').map((s) => s.trim())) : null;

const OUTPUT_PATH = path.join(config.OUTPUT_DIR, 'chat-leads-classification.json');
const LOG_PATH = path.join(config.OUTPUT_DIR, 'chat-leads-log.jsonl');
const PROCESSED_PATH = path.join(config.OUTPUT_DIR, 'chat-leads-processed.jsonl');
const MAX_LISTED_IN_NOTIFY = 15;

function ensureDirs() {
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(config.DEBUG_DIR, { recursive: true });
}

function appendLog(entry) {
  fs.appendFileSync(LOG_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n', 'utf-8');
}

// Журнал опрацьованих: ключ = conversationId, значення = id останнього
// вхідного повідомлення на момент обробки. Чат живе у дводенному вікні дві
// доби, тобто двогодинний крон побачить його ~24 рази — без цього журналу
// ті самі чати щоразу йшли б у Claude. Той самий підхід, що вже працює в
// check-lead-notifications.js.
// Зберігаємо ДВА ключі: updated_at чату (дозволяє відсіяти його ще ДО
// читання історії — а це найдорожча частина, 1-5 запитів на чат) і id
// останнього вхідного повідомлення (страхує випадок, коли updated_at
// зрушив через бот-розсилку, а нового повідомлення від клієнтки немає).
function readProcessed() {
  const map = new Map();
  if (!fs.existsSync(PROCESSED_PATH)) return map;
  for (const line of fs.readFileSync(PROCESSED_PATH, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      map.set(String(e.conversationId), {
        lastIncomingMessageId: e.lastIncomingMessageId ?? null,
        updatedAt: e.updatedAt ?? null,
      });
    } catch (_) { /* пошкоджений рядок — ігноруємо */ }
  }
  return map;
}

function markProcessed(conversationId, lastIncomingMessageId, result, updatedAt) {
  fs.appendFileSync(
    PROCESSED_PATH,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      conversationId: String(conversationId),
      lastIncomingMessageId,
      updatedAt: updatedAt ?? null,
      result,
    }) + '\n',
    'utf-8'
  );
}

function isCreditExhaustedError(err) {
  if (err instanceof Anthropic.APIError && err.status === 402) return true;
  if (err?.error?.error?.type === 'billing_error') return true;
  if (typeof err?.message === 'string' && err.message.includes('credit balance is too low')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// API-хелпери (усі читання — через page.request з authToken зі сторінки)
// ---------------------------------------------------------------------------
async function apiGet(page, authToken, urlPath) {
  const url = urlPath.startsWith('http') ? urlPath : `${config.API_BASE_URL}${urlPath}`;
  const res = await page.request.get(url, { headers: { authorization: `Bearer ${authToken}` } });
  if (!res.ok()) throw new Error(`GET ${urlPath} повернув ${res.status()}`);
  return res.json();
}

// Крок 1: відкриті чати в межах часового вікна (рання зупинка по сортуванню)
async function fetchConversationsInWindow(page, authToken, cutoffMs) {
  const collected = [];
  let pageNum = 1;
  let requests = 0;
  for (;;) {
    const body = await apiGet(
      page, authToken,
      `/conversations?filters[type]=opened&per_page=${CONVERSATIONS_PER_PAGE}&page=${pageNum}`
    );
    requests++;
    const rows = body.data || [];
    let reachedOlder = false;
    for (const c of rows) {
      if (new Date(c.updated_at).getTime() >= cutoffMs) collected.push(c);
      else { reachedOlder = true; break; }
    }
    if (reachedOlder || !rows.length || pageNum >= (body.last_page || 1)) {
      return { conversations: collected, requests, totalOpened: body.total };
    }
    pageNum++;
  }
}

// Крок 2: множина contact_id, які вже мають активну картку в будь-якій воронці
async function fetchContactsWithActiveCard(page, authToken) {
  const contacts = new Set();
  let cards = 0;
  for (const pipelineId of SOURCE_PIPELINES_FOR_CARD_CHECK) {
    let pageNum = 1;
    for (;;) {
      const board = await apiGet(page, authToken, `/leads/pipelines/desk/${pipelineId}?page=${pageNum}`);
      let keepGoing = false;
      for (const col of board) {
        const leadsBlock = col.leads;
        if (!leadsBlock) continue;
        const lastPage = leadsBlock.last_page || 1;
        if (pageNum <= lastPage) {
          for (const lead of (leadsBlock.data || [])) {
            const contactId = lead.contact?.id ?? lead.contact_id ?? null;
            if (contactId) contacts.add(contactId);
            cards++;
          }
        }
        if (pageNum < lastPage) keepGoing = true;
      }
      if (!keepGoing) break;
      pageNum++;
    }
  }
  return { contacts, cards };
}

// Крок 3: історія повідомлень із пагінацією вглиб, доки не знайдемо вхідне
async function fetchMessagesUntilIncoming(page, authToken, conversationId) {
  let url = `/conversations/${conversationId}/messages?cursor=true`;
  const all = [];
  for (let i = 0; i < MESSAGES_MAX_PAGES; i++) {
    const body = await apiGet(page, authToken, url);
    const rows = body.data || [];
    all.push(...rows);
    if (rows.some((m) => m.type === 'incoming')) break;
    if (!body.has_next || !body.next_page_url) break;
    url = body.next_page_url;
  }
  // від найстарішого до найновішого — так зручніше і для аналізу, і для промпту
  return all.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

// Евристики без Claude: чи це взагалі повернення після паузи
function analyseHistory(messages) {
  const incomingIdx = messages.map((m) => m.type).lastIndexOf('incoming');
  if (incomingIdx === -1) {
    return { kind: 'never_wrote', lastIncoming: null, gapDays: null, sinceDays: null };
  }
  const lastIncoming = messages[incomingIdx];
  const prev = messages[incomingIdx - 1] || null;
  const gapDays = prev
    ? (new Date(lastIncoming.created_at) - new Date(prev.created_at)) / 86400000
    : null;
  const sinceDays = (Date.now() - new Date(lastIncoming.created_at).getTime()) / 86400000;
  const earlierIncoming = messages.slice(0, incomingIdx).some((m) => m.type === 'incoming');
  return { kind: 'has_incoming', lastIncoming, prev, gapDays, sinceDays, earlierIncoming };
}

function messageText(m) {
  if (m.message_body && m.message_body.trim()) return m.message_body.replace(/\s+/g, ' ').trim();
  if (m.attachments && m.attachments.length) return '(вкладення)';
  return `(${m.message_type || 'без тексту'})`;
}

function buildDialogText(messages) {
  return messages
    .map((m) => `[${m.type === 'incoming' ? 'incoming' : 'outgoing'}] (${m.created_at.slice(0, 10)}): ${messageText(m)}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Claude-класифікація.
//
// ЗВУЖЕНИЙ КРИТЕРІЙ (уточнення Крістіни 2026-09-12, після першого dry-run).
// Спершу правило було ширшим — "повернулась після паузи й не відмовилась"
// вважалось достатнім. Перший прогін показав, що так проходять і випадки,
// які картки не потребують: питання про відправку вже існуючого замовлення
// (conv=24599) і голе вкладення без тексту, схоже на відмітку в сторіс
// (conv=16842). Тому тепер потрібен КОНКРЕТНИЙ сигнал інтересу до ТОВАРУ —
// критерій близький до того, що вже працює в move-to-sales.js.
//
// Гілка "клієнтка ніколи раніше не писала -> звичайний новий лід, не наша
// задача" лишається на евристиці, без Claude.
// ---------------------------------------------------------------------------
const EXCEPTION_VALUES = [
  'none',
  'explicit_decline',
  'existing_order_question',
  'no_purchase_intent',
  'not_client_initiated',
  'irrelevant_message',
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

const PROMPT_TEMPLATE = `Ти аналізуєш переписку менеджера інтернет-магазину жіночого спортивного одягу з клієнткою в Instagram Direct (через KeyCRM). Кожне повідомлення позначене напрямком [incoming] (від клієнтки) або [outgoing] (від менеджера/бота) та датою.

Поточна дата й час (Київ): {now_kyiv}

КОНТЕКСТ: цей чат НЕ МАЄ картки в жодній воронці CRM, а клієнтка писала раніше, потім була пауза ({gap_days} днів), і вона знову написала.

ЗАВДАННЯ: вирішити, чи створювати картку у воронці "Продажі".

ГОЛОВНЕ ПРАВИЛО: самого факту "повернулась після паузи і не відмовилась" НЕ ДОСТАТНЬО. Картку створюємо ТІЛЬКИ якщо в ОСТАННЬОМУ повідомленні клієнтки є КОНКРЕТНИЙ, ЯВНИЙ інтерес саме до ТОВАРУ.

verdict="add_card", exception="none" — якщо клієнтка в останньому повідомленні:
- просить розмірну сітку або питає про розмір;
- питає про кольори або просить надіслати доступні кольори;
- просить надіслати більше фото ТОВАРУ (додаткові фото моделі, яку розглядає);
- питає ціну ("Ціна?", "Скільки коштує?", "Вартість?");
- питає про наявність конкретної моделі чи розміру;
- прямо каже про намір замовити ("хочу замовити", "як оформити", "де замовити", "беру").

verdict="skip" в усіх інших випадках:

1. exception="existing_order_question" — питання стосується ВЖЕ ІСНУЮЧОГО замовлення: коли відправите, де посилка, ТТН, статус доставки, коли прийде, чому затримка, питання про повернення чи обмін уже купленого. Це не намір купити ЗНОВУ, а супровід наявного замовлення.

2. exception="explicit_decline" — клієнтка ЯВНО відмовилась: "не актуально", "дякую, не треба", "вже не потрібно", "передумала", "купила в іншому місці".

3. exception="not_client_initiated" — останнє [incoming] повідомлення не є змістовним зверненням: голе вкладення чи фото без тексту (типово — скрін відмітки в сторіс заради знижки), сам лише емодзі чи реакція, переслане службове повідомлення, технічний артефакт. Розрізняй: фото клієнтки В одязі або скрін відмітки — це НЕ інтерес (skip); прохання надіслати фото ТОВАРУ — це навпаки інтерес (add_card).

4. exception="no_purchase_intent" — клієнтка написала змістовно, але конкретного інтересу до товару немає: привітання, подяка, відгук про куплене, загальна балачка, "ще актуально?" без згадки товару, питання не про асортимент.

5. exception="irrelevant_message" — не стосується магазину взагалі: спам, реклама, пропозиція співпраці, помилкове звернення.

ВАЖЛИВО:
- Оцінюй саме ОСТАННЄ повідомлення клієнтки ([incoming]) — не проміжні.
- "gap_summary" — коротко українською опиши паузу (наприклад: "Останнє спілкування 14.03.2026, наступне повідомлення клієнтки 20.08.2026, пауза ~5 місяців").
- "last_client_message_quote" — дослівна цитата останнього повідомлення клієнтки.

Ось переписка:
{dialog_text}

Дай відповідь СУВОРО у форматі JSON, без жодного іншого тексту, за схемою: {"verdict": "add_card/skip", "exception": "...", "confidence": "high/medium/low", "gap_summary": "...", "last_client_message_quote": "...", "rationale": "1-3 речення обґрунтування українською"}`;

function nowKyiv() {
  return new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', dateStyle: 'full', timeStyle: 'short' }).format(new Date());
}

async function classifyDialog(client, dialogText, gapDays) {
  const prompt = PROMPT_TEMPLATE
    .replace('{now_kyiv}', nowKyiv())
    .replace('{gap_days}', gapDays === null ? 'невідомо' : gapDays.toFixed(0))
    .replace('{dialog_text}', dialogText || '(порожня переписка)');

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
// Створення картки — тіло перехоплене з форми "Швидке додавання картки"
// (кнопка .chat-active-leads__add у панелі чату), recon 2026-09-12.
// ---------------------------------------------------------------------------
function buildLeadPayload(conv, managerId) {
  const contact = conv.contact || {};
  const fullName = contact.full_name || conv.contact_username || `Чат ${conv.id}`;
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const communicateAt = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  return {
    title: `Чат з ${fullName}`,
    pipeline_id: SALES_PIPELINE_ID,
    status_id: SALES_NEW_LEAD_STATUS_ID,
    source_id: DEFAULT_SOURCE_ID,
    manager_id: managerId,
    communicate_at: communicateAt,
    manager_comment: null,
    currency_code: 'UAH',
    custom_field_values: [],
    contact_id: conv.contact_id,
    contact: {
      full_name: contact.full_name || null,
      phone: contact.phone || null,
      email: contact.email || null,
      client_id: contact.client_id || null,
    },
  };
}

async function postLead(page, payload) {
  return page.evaluate(
    async ({ base, body }) => {
      const token = localStorage.getItem('authToken');
      const res = await fetch(`${base}/leads`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const text = await res.text().catch(() => '');
      return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
    },
    { base: LEADS_API_BASE, body: payload }
  );
}

async function verifyCardCreated(page, authToken, contactId) {
  try {
    const body = await apiGet(page, authToken, `/leads/by-contact/${contactId}?per_page=100&page=1&id=${contactId}`);
    const cards = body.data || [];
    const inSales = cards.filter((l) => l.pipeline_id === SALES_PIPELINE_ID);
    return inSales.length
      ? { verified: true, note: `підтверджено: ${inSales.length} картка(ок) у "Продажі" (lead ${inSales.map((l) => l.id).join(', ')})` }
      : { verified: false, note: `картку не видно: by-contact повернув ${cards.length} карток, жодної у воронці 1` };
  } catch (err) {
    return { verified: false, note: `перевірка не вдалась: ${err.message}` };
  }
}

function formatForNotify(items) {
  if (!items.length) return '';
  const shown = items.slice(0, MAX_LISTED_IN_NOTIFY);
  const lines = shown.map((i) => `  ${i.customerName || i.username || i.conversationId} — пауза ${i.gapDays != null ? `${Math.round(i.gapDays)}д` : '?'}: "${(i.lastClientMessageQuote || '').slice(0, 60)}"`);
  let text = `\n${lines.join('\n')}`;
  if (items.length > MAX_LISTED_IN_NOTIFY) text += `\n  ...і ще ${items.length - MAX_LISTED_IN_NOTIFY}, повний список у ${LOG_PATH}`;
  return text;
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

  if (LIVE_MODE) {
    console.log('\n' + '='.repeat(70));
    console.log('УВАГА: LIVE-РЕЖИМ УВІМКНЕНО.');
    console.log('Цей запуск РЕАЛЬНО створить нові картки у воронці "Продажі".');
    console.log('POST /leads ще ніколи не виконувався по-справжньому з цього коду');
    console.log('(тіло підтверджене лише перехопленням через route.abort()).');
    console.log('Перший LIVE-запуск роби на одному чаті:');
    console.log('  node add-cards-from-chats.js --live --conversation-ids=<id>');
    console.log('Зупинись зараз (Ctrl+C), якщо не впевнений(-а).');
    console.log('='.repeat(70));
    await new Promise((resolve) => setTimeout(resolve, 5000));
    console.log('Продовжую...\n');
  } else {
    console.log('DRY-RUN режим (за замовчуванням) — жодних змін у KeyCRM не буде.');
    console.log('Для реального запуску: node add-cards-from-chats.js --live\n');
  }

  console.log(`Параметри: вікно=${WINDOW.label}, мін. пауза=${GAP_DAYS}д, ліміт класифікацій=${LIMIT}`);

  const browser = await chromium.launch({ headless: config.HEADLESS, args: ['--disable-gpu', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ storageState: config.STORAGE_STATE_PATH, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  const results = [];
  const counts = { created: 0, 'created-unverified': 0, 'would-create': 0, skip: 0, error: 0 };
  const createdItems = [];

  try {
    console.log('\nВідкриваю розділ "Чати" та читаю authToken...');
    await page.goto(`${config.BASE_URL}/app/conversations`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    const authToken = await page.evaluate(() => localStorage.getItem('authToken'));
    if (!authToken) throw new Error('authToken не знайдено в localStorage — сесія недійсна?');

    const profile = await apiGet(page, authToken, '/auth/profile');
    const managerId = profile.id;
    console.log(`Акаунт: ${profile.username} (id=${managerId}, role_id=${profile.role_id})`);

    // --- Крок 1: чати у вікні
    const cutoffMs = Date.now() - WINDOW.ms;
    console.log(`\nКрок 1 — читаю відкриті чати з активністю за останні ${WINDOW.label}...`);
    const { conversations, requests, totalOpened } = await fetchConversationsInWindow(page, authToken, cutoffMs);
    console.log(`  у вікні: ${conversations.length} чатів (усього відкритих: ${totalOpened}), запитів: ${requests}`);

    // --- Крок 2: відсів тих, хто вже має картку
    console.log('\nКрок 2 — читаю дошки воронок 1/16/27 і відсіюю чати, що вже мають картку...');
    const { contacts: contactsWithCard, cards } = await fetchContactsWithActiveCard(page, authToken);
    console.log(`  активних карток: ${cards}, унікальних контактів з карткою: ${contactsWithCard.size}`);

    let candidates = conversations.filter((c) => c.contact_id && !contactsWithCard.has(c.contact_id));
    console.log(`  чатів БЕЗ активної картки: ${candidates.length}`);

    const spam = candidates.filter((c) => c.is_spam);
    if (spam.length) {
      candidates = candidates.filter((c) => !c.is_spam);
      console.log(`  відкинуто як спам: ${spam.length}`);
    }

    if (CONV_IDS_FILTER) {
      candidates = conversations.filter((c) => CONV_IDS_FILTER.has(String(c.id)));
      console.log(`  --conversation-ids вказано: беру ${candidates.length} чат(ів) незалежно від інших фільтрів`);
    }

    // --- Крок 3: журнал опрацьованих + евристики
    const processed = readProcessed();
    console.log(`\nКрок 3 — читаю історію й застосовую евристики (журнал опрацьованих: ${processed.size} записів)...`);

    const toClassify = [];
    let heuristicSkips = { alreadyProcessed: 0, neverWrote: 0, noGap: 0, readError: 0 };

    for (const conv of candidates) {
      const convId = String(conv.id);

      // Найдешевший відсів — ДО читання історії: чат не змінювався з
      // моменту, коли ми його вже опрацювали. Явно названий у
      // --conversation-ids чат журнал НЕ відсіює: точковий запуск завжди
      // означає "обробити саме його, незалежно від історії запусків".
      const seen = CONV_IDS_FILTER ? null : processed.get(convId);
      if (seen && seen.updatedAt && seen.updatedAt === conv.updated_at) {
        heuristicSkips.alreadyProcessed++;
        continue;
      }

      let messages;
      try {
        messages = await fetchMessagesUntilIncoming(page, authToken, conv.id);
      } catch (err) {
        heuristicSkips.readError++;
        appendLog({ conversationId: convId, result: 'error', note: `читання повідомлень: ${err.message}` });
        counts.error++;
        continue;
      }

      const analysis = analyseHistory(messages);

      if (analysis.kind === 'never_wrote') {
        heuristicSkips.neverWrote++;
        appendLog({ conversationId: convId, contactId: conv.contact_id, result: 'skip', exception: 'never_wrote_before',
          note: 'жодного вхідного повідомлення — звичайний новий лід, не наша задача' });
        markProcessed(convId, null, 'skip:never_wrote_before', conv.updated_at);
        counts.skip++;
        continue;
      }

      const lastIncomingId = analysis.lastIncoming.id;
      if (seen && seen.lastIncomingMessageId === lastIncomingId) {
        heuristicSkips.alreadyProcessed++;
        // updated_at зрушив (бот написав), але нового повідомлення від
        // клієнтки немає — оновлюємо мітку, щоб наступний запуск відсіяв
        // цей чат ще до читання історії.
        markProcessed(convId, lastIncomingId, 'skip:no_new_client_message', conv.updated_at);
        continue;
      }

      if (analysis.gapDays === null || analysis.gapDays < GAP_DAYS) {
        heuristicSkips.noGap++;
        appendLog({ conversationId: convId, contactId: conv.contact_id, result: 'skip', exception: 'no_gap',
          gapDays: analysis.gapDays, note: `пауза ${analysis.gapDays === null ? 'невизначена' : analysis.gapDays.toFixed(1) + 'д'} < ${GAP_DAYS}д` });
        markProcessed(convId, lastIncomingId, 'skip:no_gap', conv.updated_at);
        counts.skip++;
        continue;
      }

      toClassify.push({ conv, messages, analysis });
    }

    console.log(`  відсіяно евристиками: вже опрацьовані=${heuristicSkips.alreadyProcessed}, ніколи не писали=${heuristicSkips.neverWrote}, без паузи=${heuristicSkips.noGap}, помилок читання=${heuristicSkips.readError}`);
    console.log(`  лишилось на класифікацію: ${toClassify.length}`);

    const batch = toClassify.slice(0, LIMIT);
    if (toClassify.length > LIMIT) {
      console.log(`  УВАГА: обмежую до ${LIMIT} (--limit), решта ${toClassify.length - LIMIT} лишиться на наступний запуск`);
    }

    // --- Крок 4-5: класифікація і дія
    const client = new Anthropic();
    let i = 0;
    for (const { conv, messages, analysis } of batch) {
      i++;
      const name = conv.contact?.full_name || conv.contact_username || '(без імені)';
      console.log(`\n[${i}/${batch.length}] conv=${conv.id} "${name}" пауза=${analysis.gapDays.toFixed(0)}д, написала ${analysis.sinceDays.toFixed(0)}д тому`);

      const base = {
        conversationId: String(conv.id),
        contactId: conv.contact_id,
        clientId: conv.contact?.client_id ?? null,
        customerName: conv.contact?.full_name ?? null,
        username: conv.contact_username ?? null,
        gapDays: analysis.gapDays,
        sinceDays: analysis.sinceDays,
        lastIncomingMessageId: analysis.lastIncoming.id,
        lastIncomingAt: analysis.lastIncoming.created_at,
        updatedAt: conv.updated_at,
      };

      try {
        const classification = await classifyDialog(client, buildDialogText(messages), analysis.gapDays);
        console.log(`  verdict=${classification.verdict} exception=${classification.exception} (${classification.confidence})`);

        const entry = {
          ...base,
          verdict: classification.verdict,
          exception: classification.exception,
          confidence: classification.confidence,
          gapSummary: classification.gap_summary,
          lastClientMessageQuote: classification.last_client_message_quote,
          rationale: classification.rationale,
        };

        if (classification.verdict !== 'add_card') {
          results.push({ ...entry, result: 'skip' });
          appendLog({ ...entry, result: 'skip' });
          markProcessed(conv.id, base.lastIncomingMessageId, `skip:${classification.exception}`, conv.updated_at);
          counts.skip++;
          continue;
        }

        const payload = buildLeadPayload(conv, managerId);

        if (!LIVE_MODE) {
          results.push({ ...entry, result: 'would-create', note: `dry-run: буде відправлено POST ${LEADS_API_BASE}/leads ${JSON.stringify(payload)} — запит НЕ відправлено` });
          appendLog({ ...entry, result: 'would-create', payload });
          markProcessed(conv.id, base.lastIncomingMessageId, 'would-create', conv.updated_at);
          counts['would-create']++;
          createdItems.push(entry);
          console.log(`  DRY-RUN — буде створено картку "${payload.title}" у "Продажі"/"Новий лід"`);
          continue;
        }

        const response = await postLead(page, payload);
        if (!response.ok) {
          results.push({ ...entry, result: 'error', note: `POST failed: status=${response.status} body=${response.body}` });
          appendLog({ ...entry, result: 'error', note: `POST failed: status=${response.status} body=${response.body}` });
          counts.error++;
          console.log(`  ПОМИЛКА — POST повернув ${response.status}: ${response.body}`);
          continue;
        }

        const verify = await verifyCardCreated(page, authToken, conv.contact_id);
        const result = verify.verified ? 'created' : 'created-unverified';
        results.push({ ...entry, result, note: verify.note });
        appendLog({ ...entry, result, note: verify.note });
        markProcessed(conv.id, base.lastIncomingMessageId, result, conv.updated_at);
        counts[result]++;
        createdItems.push(entry);
        console.log(verify.verified ? `  СТВОРЕНО — ${verify.note}` : `  POST ВИКОНАНО, але не підтверджено — ${verify.note}`);
      } catch (err) {
        console.error(`  Помилка обробки чату: ${err.message}`);
        results.push({ ...base, result: 'error', note: err.message });
        appendLog({ ...base, result: 'error', note: err.message });
        counts.error++;
        if (isCreditExhaustedError(err)) throw err;
      }
    }

    // --- Підсумок
    console.log('\n\n=== Результати (' + (LIVE_MODE ? 'LIVE' : 'DRY-RUN') + ') ===\n');
    if (results.length) {
      console.table(results.map((r) => ({
        conv: r.conversationId,
        'Клієнт': r.customerName || r.username || '(без імені)',
        'Пауза, д': r.gapDays != null ? Math.round(r.gapDays) : '-',
        'Результат': r.result,
        'Виняток': r.exception || '-',
      })));
    } else {
      console.log('(жодного чату не дійшло до класифікації)');
    }

    const appliedTotal = counts.created + counts['created-unverified'];
    console.log(`\nКласифіковано: ${batch.length}. ${LIVE_MODE ? 'Створено карток' : 'Буде створено (dry-run)'}: ${LIVE_MODE ? appliedTotal : counts['would-create']}. Пропущено: ${counts.skip}. Помилок: ${counts.error}.`);

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`Збережено у: ${OUTPUT_PATH}`);

    await notify(
      `${LIVE_MODE ? '🔴' : '⚪'} add-cards-from-chats.js — ${LIVE_MODE ? 'LIVE' : 'DRY-RUN'} (вікно ${WINDOW.label})\n` +
      `Чатів у вікні: ${conversations.length}, без картки: ${candidates.length}, класифіковано: ${batch.length}\n` +
      `${LIVE_MODE ? 'Створено карток' : 'Буде створено (dry-run)'}: ${LIVE_MODE ? appliedTotal : counts['would-create']}` +
      `${counts['created-unverified'] ? ` (з них ${counts['created-unverified']} без підтвердження — перевір вручну)` : ''}` +
      formatForNotify(createdItems) +
      `\nПропущено: ${counts.skip}` +
      `${counts.error ? `\nПомилок: ${counts.error} — перевір лог ${LOG_PATH}` : ''}`
    );
  } catch (err) {
    console.error('Критична помилка:', err.message);
    try {
      await page.screenshot({ path: path.join(config.DEBUG_DIR, 'add-cards-from-chats-fatal.png'), fullPage: true });
    } catch (_) { /* скріншот не критичний */ }
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2), 'utf-8');
    const prefix = isCreditExhaustedError(err)
      ? '🔴 ЗАКІНЧИЛИСЬ КРЕДИТИ ANTHROPIC, поповни баланс на https://platform.claude.com/settings/billing\n'
      : `🔴 КРИТИЧНА ПОМИЛКА в add-cards-from-chats.js (${LIVE_MODE ? 'LIVE' : 'DRY-RUN'}): `;
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
