require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const { notify } = require('../notify');
const { ensureFreshSession } = require('../refresh-session');

// ---------------------------------------------------------------------------
// ПРИЗНАЧЕННЯ — сценарій (b) задачі Крістіни (уточнення 2026-09-09)
// ---------------------------------------------------------------------------
// На відміну від classify-repeat-leads.js (сценарій a — клієнт БЕЗ активної
// картки, рекомендація "додати нову картку"), цей скрипт відповідає за
// клієнтів, які ВЖЕ МАЮТЬ картку в одній з "неактивних" воронок —
// pipeline_id=16 ("ВІдгуки") або pipeline_id=27 ("Фідбек відмова") — і
// повертаються з genuine наміром купити. Для таких карток дія — НЕ
// створення нової картки, а ПЕРЕНЕСЕННЯ вже існуючого ліда у воронку
// "Продажі" (pipeline_id=1), статус "Новий лід" (status_id=1).
//
// Крістіна підтвердила (2026-09-09) широке трактування: правило стосується
// БУДЬ-ЯКОЇ картки, що зараз лежить у pipeline_id=16 або pipeline_id=27,
// незалежно від конкретного статусу всередині (не обмежується статусом
// "Відхилити лід") — тому нижче немає column-based pre-filter, як
// ACTIVE_REMINDER_STATUS_IDS у classify-repeat-leads.js.
//
// Recon-висновки, на яких побудований цей скрипт (див. пам'ять
// keycrm_cross_pipeline_move_recon.md):
//   - Існує лише 3 воронки: pipeline_id=1 "Продажі", pipeline_id=16
//     "ВІдгуки" (статуси: "ВІдгук"/170, "Система лояльності"/366,
//     "Відхилити лід"/369), pipeline_id=27 "Фідбек відмова" (статуси:
//     "Фідбек відмова"/302, "Відхилити лід"/367). "Система лояльності" —
//     НЕ окрема воронка, а статус усередині pipeline_id=16.
//   - Перехід МІЖ воронками для ВЖЕ ІСНУЮЧОГО ліда — це ОДИН PUT-запит,
//     той самий ендпоінт, що вже використовує move-to-reminder.js, просто
//     з доданим полем pipeline_id у тілі:
//       PUT {LEADS_API_BASE}/leads/{leadId}
//       {"id": <leadId>, "status_id": 1, "pipeline_id": 1}
//     Підтверджено live-тестом через page.route(...).abort() (запит
//     сформовано й перехоплено, на сервер не відправлено, картку
//     перевірено незміненою через повторний GET).
//   - Службовий акаунт tviykomplekt_auto має повний READ-доступ до
//     pipeline_id=16 і pipeline_id=27 (GET /leads/pipelines/desk/{16,27}
//     -> 200, підтверджено 2026-09-09) — жодних додаткових прав не
//     потрібно. WRITE (сам PUT) підтверджено лише формуванням запиту
//     (route.abort()), а НЕ реальним 200 від сервера для цього акаунта —
//     тому перед масовим --live запуском варто спершу прогнати
//     `--live --lead-ids=<один_id>` на одній картці й підтвердити вручну
//     в KeyCRM, що вона справді перенеслась.
//
// Класифікація наміру купити (той самий підхід, що й у
// classify-repeat-leads.js — судження за ОСТАННІМ повідомленням клієнтки,
// без "постійних" винятків за старими бот-повідомленнями) НАВМИСНО
// продубльована тут, а не імпортована — classify-repeat-leads.js не
// експортує нічого (лише main()), а дублювання невеликих
// PROMPT_TEMPLATE/SELECTORS-блоків між скриптами вже є усталеною
// практикою цього репо (див. коментарі "ідентично X" у
// move-to-reminder.js, apply-classification.js).
//
// За замовчуванням — DRY-RUN (лог того, що БУЛО Б відправлено, без
// реального PUT). Live-режим — окремий прапор, НЕ успадковує
// APPLY_LIVE/MOVE_TO_REMINDER_LIVE з .env (той самий принцип ізоляції
// прапорів, що й move-to-reminder.js).
// ---------------------------------------------------------------------------

const MODEL = 'claude-sonnet-5';
const LEADS_API_BASE = 'https://tviykomplekt.api.keycrm.app';

const SALES_PIPELINE_ID = 1;
const SALES_NEW_LEAD_STATUS_ID = 1; // "Новий лід", pipeline_id=1 (GET /leads/pipelines?leads=false)

const SOURCE_PIPELINES = [
  { id: 16, name: 'ВІдгуки' },
  { id: 27, name: 'Фідбек відмова' },
];

const LIVE_MODE = process.argv.includes('--live') || process.env.MOVE_TO_SALES_LIVE === 'true';

const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 30;

const leadIdsArg = process.argv.find((a) => a.startsWith('--lead-ids='));
const LEAD_IDS_FILTER = leadIdsArg ? new Set(leadIdsArg.split('=')[1].split(',').map((s) => s.trim())) : null;

const OUTPUT_PATH = path.join(config.OUTPUT_DIR, 'move-to-sales-classification.json');
const MOVE_LOG_PATH = path.join(config.OUTPUT_DIR, 'move-to-sales-log.jsonl');
const MAX_LISTED_IN_NOTIFY = 15;

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

function appendLog(entry) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  fs.appendFileSync(MOVE_LOG_PATH, line + '\n', 'utf-8');
}

async function saveDebugArtifacts(page, label) {
  try {
    await page.screenshot({ path: path.join(config.DEBUG_DIR, `${label}.png`), fullPage: true });
    fs.writeFileSync(path.join(config.DEBUG_DIR, `${label}.html`), await page.content(), 'utf-8');
  } catch (err) {
    console.warn(`  [debug] не вдалося зберегти debug-артефакти: ${err.message}`);
  }
}

function stripChatPrefix(text) {
  return text ? text.replace(/^\s*Чат\s*з\s*/i, '').trim() : null;
}

function isCreditExhaustedError(err) {
  if (err instanceof Anthropic.APIError && err.status === 402) return true;
  if (err?.error?.error?.type === 'billing_error') return true;
  if (typeof err?.message === 'string' && err.message.includes('credit balance is too low')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Discovery — весь борд ОДНІЄЇ воронки, усі колонки, з пагінацією кожної.
// Ідентично fetchAllOpenLeads у classify-repeat-leads.js, узагальнено на
// довільний pipelineId (там — жорстко pipeline 1).
// ---------------------------------------------------------------------------
async function fetchDeskPage(page, authToken, pipelineId, pageNum) {
  const url = `${config.API_BASE_URL}/leads/pipelines/desk/${pipelineId}?page=${pageNum}`;
  const res = await page.request.get(url, { headers: { authorization: `Bearer ${authToken}` } });
  if (!res.ok()) {
    throw new Error(`GET /leads/pipelines/desk/${pipelineId} (сторінка ${pageNum}) повернув ${res.status()}`);
  }
  return res.json();
}

async function fetchAllOpenLeadsForPipeline(page, authToken, pipelineId) {
  const first = await fetchDeskPage(page, authToken, pipelineId, 1);
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
    body = await fetchDeskPage(page, authToken, pipelineId, pageNum);
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
// Перемикання борду на іншу воронку в UI — dropdown "Продажі ▾" вгорі
// сторінки /app/leads. Підтверджено recon'ом 2026-09-09
// (keycrm_cross_pipeline_move_recon.md): це звичайний el-dropdown зі
// списком усіх 3 воронок, клік по пункту перезавантажує борд без повної
// навігації сторінки.
// ---------------------------------------------------------------------------
async function switchToPipeline(page, pipelineName) {
  const dropdownBtn = page.locator('button, .el-dropdown', { hasText: /^(Продажі|ВІдгуки|Фідбек відмова)$/ }).first();
  await dropdownBtn.click();
  await page.waitForTimeout(400);
  const item = page.locator('.el-dropdown-menu__item', { hasText: pipelineName }).first();
  await item.waitFor({ state: 'visible', timeout: 10000 });
  await item.click();
  await page.waitForTimeout(1200);
  await page.locator(SELECTORS.columnTitle).first().waitFor({ state: 'visible', timeout: 30000 });
}

// ---------------------------------------------------------------------------
// Навігація дошкою / читання діалогу — ідентично classify-repeat-leads.js.
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
// Claude-класифікація — намір купити за ОСТАННІМ повідомленням клієнтки.
// Продубльовано з classify-repeat-leads.js (той самий виправлений 2026-09-09
// підхід: жоден виняток не є "постійним", рішення завжди за останнім
// повідомленням). Тримати синхронізовано вручну при подальших правках
// промпту в обох файлах.
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
// PUT-запит на перенесення ліда в "Продажі" — той самий ендпоінт/паттерн,
// що putLeadStatus у move-to-reminder.js, лише з доданим pipeline_id.
// ---------------------------------------------------------------------------
async function putLeadToSales(page, leadId) {
  return page.evaluate(
    async ({ base, leadId, statusId, pipelineId }) => {
      const token = localStorage.getItem('authToken');
      const res = await fetch(`${base}/leads/${leadId}`, {
        method: 'PUT',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ id: Number(leadId), status_id: Number(statusId), pipeline_id: Number(pipelineId) }),
      });
      const text = await res.text().catch(() => '');
      return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
    },
    { base: LEADS_API_BASE, leadId, statusId: SALES_NEW_LEAD_STATUS_ID, pipelineId: SALES_PIPELINE_ID }
  );
}

async function verifyMovedToSales(page, authToken, leadId) {
  const res = await page.request.get(`${LEADS_API_BASE}/leads/${leadId}`, {
    headers: { authorization: `Bearer ${authToken}` },
  });
  if (!res.ok()) return { verified: false, note: `GET /leads/${leadId} повернув ${res.status()}` };
  const body = await res.json();
  const ok = body.pipeline_id === SALES_PIPELINE_ID && body.status_id === SALES_NEW_LEAD_STATUS_ID;
  return { verified: ok, note: ok ? 'підтверджено GET-ом' : `все ще pipeline_id=${body.pipeline_id} status_id=${body.status_id}` };
}

function formatMovedForNotify(items) {
  if (!items.length) return '';
  const shown = items.slice(0, MAX_LISTED_IN_NOTIFY);
  const lines = shown.map((i) => `  ${i.customerName} (з "${i.pipelineName}") — ${i.rationale} (${i.confidence})`);
  let text = `\n${lines.join('\n')}`;
  if (items.length > MAX_LISTED_IN_NOTIFY) {
    text += `\n  ...і ще ${items.length - MAX_LISTED_IN_NOTIFY} карток, повний список у ${MOVE_LOG_PATH}`;
  }
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
    console.log('Цей запуск РЕАЛЬНО перенесе картки у воронку "Продажі" в KeyCRM.');
    console.log('Крос-воронковий PUT ще НІКОЛИ не підтверджувався реальним 200 від');
    console.log('сервера (лише через route.abort() recon) — якщо це перший LIVE');
    console.log('запуск, спершу протестуй на одній картці: --live --lead-ids=<id>.');
    console.log('Зупинись зараз (Ctrl+C), якщо не впевнений(-а).');
    console.log('='.repeat(70));
    await new Promise((resolve) => setTimeout(resolve, 5000));
    console.log('Продовжую...\n');
  } else {
    console.log('DRY-RUN режим (за замовчуванням) — жодних реальних змін у KeyCRM не буде.');
    console.log('Для реального запуску: node move-to-sales.js --live\n');
  }

  const browser = await chromium.launch({
    headless: config.HEADLESS,
    args: ['--disable-gpu', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ storageState: config.STORAGE_STATE_PATH, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  const results = [];

  try {
    console.log('Переходжу на дошку лідів та читаю authToken...');
    await page.goto(config.LEADS_URL, { waitUntil: 'domcontentloaded' });
    await page.locator(SELECTORS.columnTitle).first().waitFor({ state: 'visible', timeout: 30000 });
    const authToken = await page.evaluate(() => localStorage.getItem('authToken'));
    if (!authToken) throw new Error('authToken не знайдено в localStorage — сесія недійсна?');

    console.log('Завантажую борди воронок "ВІдгуки" (16) і "Фідбек відмова" (27) через API...');
    const allCandidates = [];
    for (const pipeline of SOURCE_PIPELINES) {
      const { allLeads, columnTitleByStatus } = await fetchAllOpenLeadsForPipeline(page, authToken, pipeline.id);
      console.log(`  pipeline_id=${pipeline.id} "${pipeline.name}": ${allLeads.length} карток`);
      for (const l of allLeads) {
        allCandidates.push({
          leadId: String(l.id),
          customerName: extractLeadName(l),
          pipelineId: pipeline.id,
          pipelineName: pipeline.name,
          statusId: l.status_id,
          statusTitle: columnTitleByStatus.get(l.status_id) || null,
          clientId: l.contact?.client_id || null,
          updatedAt: l.updated_at,
        });
      }
    }
    console.log(`Усього карток у "неактивних" воронках: ${allCandidates.length}`);

    let candidates;
    if (LEAD_IDS_FILTER) {
      candidates = allCandidates.filter((l) => LEAD_IDS_FILTER.has(l.leadId));
      console.log(`--lead-ids вказано: обробляю ${candidates.length} з ${LEAD_IDS_FILTER.size} запитаних.`);
    } else {
      candidates = [...allCandidates].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, LIMIT);
      console.log(`Беру ТОП-${LIMIT} найновіше оновлених карток (з ${allCandidates.length}).`);
    }

    // Групую за воронкою, щоб перемикати борд в UI якомога рідше.
    const byPipeline = new Map();
    for (const c of candidates) {
      if (!byPipeline.has(c.pipelineId)) byPipeline.set(c.pipelineId, []);
      byPipeline.get(c.pipelineId).push(c);
    }

    const client = new Anthropic();
    const counts = { moved: 0, 'moved-unverified': 0, 'would-move': 0, skip: 0, error: 0 };
    const movedItems = [];
    let processedCount = 0;

    for (const pipeline of SOURCE_PIPELINES) {
      const group = byPipeline.get(pipeline.id);
      if (!group || !group.length) continue;

      console.log(`\n=== Перемикаюсь на воронку "${pipeline.name}" (${group.length} карток) ===`);
      await switchToPipeline(page, pipeline.name);

      for (const item of group) {
        processedCount++;
        console.log(`\n[${processedCount}/${candidates.length}] leadId=${item.leadId} "${item.customerName || '(без імені)'}" (${pipeline.name} → ${item.statusTitle})...`);

        try {
          const column = await getColumnByExactTitle(page, item.statusTitle);
          await ensureAllCardsLoaded(page, column);
          const { index, cards } = await findCardIndexById(column, item.leadId);
          if (index === -1) {
            results.push({ ...item, result: 'skip', exception: 'error', rationale: 'Картку не знайдено в DOM колонки (могла змінити статус між discovery і обробкою).' });
            appendLog({ ...item, result: 'skip', note: 'not-found-in-column' });
            counts.skip++;
            continue;
          }
          await cards.nth(index).scrollIntoViewIfNeeded();
          await cards.nth(index).dblclick();
          await openCommunicationTab(page);
          await page.waitForTimeout(1200);

          const dialog = await extractDialog(page);
          await closeCard(page);

          if (!dialog || !dialog.messages.length || !dialog.messages.some((m) => m.direction === 'incoming')) {
            results.push({ ...item, result: 'skip', exception: 'no_client_message', rationale: 'Порожня переписка або немає жодного повідомлення від клієнтки.' });
            appendLog({ ...item, result: 'skip', note: 'no_client_message' });
            counts.skip++;
            continue;
          }

          const classification = await classifyDialog(client, dialog);
          console.log(`  verdict=${classification.verdict} exception=${classification.exception} (${classification.confidence})`);

          const entry = {
            ...item,
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
            counts.skip++;
            continue;
          }

          if (!LIVE_MODE) {
            results.push({ ...entry, result: 'would-move', note: `dry-run: буде відправлено PUT ${LEADS_API_BASE}/leads/${item.leadId} {"id":${item.leadId},"status_id":${SALES_NEW_LEAD_STATUS_ID},"pipeline_id":${SALES_PIPELINE_ID}} — запит НЕ відправлено` });
            appendLog({ ...entry, result: 'would-move' });
            counts['would-move']++;
            movedItems.push(entry);
            console.log(`  DRY-RUN — буде перенесено в "Продажі" (Новий лід)`);
            continue;
          }

          const putResponse = await putLeadToSales(page, item.leadId);
          if (!putResponse.ok) {
            results.push({ ...entry, result: 'error', note: `PUT failed: status=${putResponse.status} body=${putResponse.body}` });
            appendLog({ ...entry, result: 'error', note: `PUT failed: status=${putResponse.status} body=${putResponse.body}` });
            counts.error++;
            console.log(`  ПОМИЛКА — PUT повернув ${putResponse.status}: ${putResponse.body}`);
            continue;
          }

          const verify = await verifyMovedToSales(page, authToken, item.leadId);
          if (verify.verified) {
            results.push({ ...entry, result: 'moved', note: verify.note });
            appendLog({ ...entry, result: 'moved', note: verify.note });
            counts.moved++;
            movedItems.push(entry);
            console.log('  ЗАСТОСОВАНО — перенесено в "Продажі" (Новий лід), підтверджено GET-ом');
          } else {
            results.push({ ...entry, result: 'moved-unverified', note: verify.note });
            appendLog({ ...entry, result: 'moved-unverified', note: verify.note });
            counts['moved-unverified']++;
            movedItems.push(entry);
            console.log(`  PUT ВИКОНАНО, але не вдалось підтвердити — ${verify.note}`);
          }
        } catch (err) {
          console.error(`  Помилка обробки картки: ${err.message}`);
          await saveDebugArtifacts(page, `move-to-sales-${item.leadId}-error`);
          await closeCard(page).catch(() => {});
          results.push({ ...item, result: 'error', note: err.message });
          appendLog({ ...item, result: 'error', note: err.message });
          counts.error++;
        }
      }
    }

    console.log('\n\n=== Результати (' + (LIVE_MODE ? 'LIVE' : 'DRY-RUN') + ') ===\n');
    console.table(
      results.map((r) => ({
        leadId: r.leadId,
        'Клієнт': r.customerName || '(без імені)',
        'Воронка': r.pipelineName,
        'Колонка': r.statusTitle,
        'Результат': r.result,
        'Виняток': r.exception || '-',
      }))
    );

    console.log(`\nОброблено: ${results.length}. ${LIVE_MODE ? 'Перенесено' : 'Буде перенесено (dry-run)'}: ${LIVE_MODE ? counts.moved + counts['moved-unverified'] : counts['would-move']}. Пропущено: ${counts.skip}. Помилок: ${counts.error}.`);

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`Збережено у: ${OUTPUT_PATH}`);

    const modeLabel = LIVE_MODE ? 'LIVE' : 'DRY-RUN';
    const appliedTotal = counts.moved + counts['moved-unverified'];
    await notify(
      `${LIVE_MODE ? '🔴' : '⚪'} move-to-sales.js — ${modeLabel}\n` +
      `Оброблено карток (з воронок "ВІдгуки"/"Фідбек відмова"): ${results.length}\n` +
      `${LIVE_MODE ? 'Перенесено в "Продажі"' : 'Буде перенесено (dry-run)'}: ${LIVE_MODE ? appliedTotal : counts['would-move']}` +
      `${counts['moved-unverified'] ? ` (з них ${counts['moved-unverified']} без підтвердження — перевір вручну)` : ''}` +
      formatMovedForNotify(movedItems) +
      `\nПропущено: ${counts.skip}` +
      `${counts.error ? `\nПомилок: ${counts.error} — перевір лог ${MOVE_LOG_PATH}` : ''}`
    );
  } catch (err) {
    console.error('Критична помилка:', err.message);
    await saveDebugArtifacts(page, 'move-to-sales-fatal-error');
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2), 'utf-8');
    const prefix = isCreditExhaustedError(err)
      ? '🔴 ЗАКІНЧИЛИСЬ КРЕДИТИ ANTHROPIC, поповни баланс на https://platform.claude.com/settings/billing\n'
      : `🔴 КРИТИЧНА ПОМИЛКА в move-to-sales.js (${LIVE_MODE ? 'LIVE' : 'DRY-RUN'}): `;
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
