require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');
const { ensureFreshSession } = require('../refresh-session');
const { notify } = require('../notify');

// ===========================================================================
// fill-client-data.js
// ---------------------------------------------------------------------------
// Автозаповнення контактних даних клієнта + адреси доставки в KeyCRM на
// картках колонки "Замовлення сформовано", на основі вже зібраних і
// провалідованих даних:
//   output/extraction_results.json  — ПІБ / телефон / email (+ confidence)
//   output/validation_results.json  — місто / відділення, з Ref'ами Nova Poshta
//
// Це НАЙРИЗИКОВІШИЙ скрипт проєкту — перший, що РЕАЛЬНО пише клієнтські дані
// в CRM. Тому:
//   * dry-run за замовчуванням; реальні дії — ТІЛЬКИ з явним прапором --live
//     (env-прапора НЕМАЄ навмисно — див. рішення від 30.08.2026 після досвіду
//     з нічними відправками; додамо env-режим лише після повного циклу
//     успішних ручних тестів);
//   * кожен під-крок (з 12) пишеться в append-only JSONL-лог окремим рядком —
//     якщо падає на кроці 5/12, у лозі видно, на чому саме;
//   * leadId (data-id картки) і імʼя перевіряються до і після кожної дії;
//     кожен PUT/POST звіряється: id у URL === очікуваному leadId/clientId;
//   * телефон окремо звіряється за тілом відповіді PUT (contact.phone),
//     бо KeyCRM МОВЧКИ відкидає невалідний номер (recon 30.08: popover
//     закривається як при успіху, а contact.phone у відповіді = null);
//   * обробляються ЛИШЕ картки з confidence:"high" і validate status:"ok" —
//     решта йде в лог/Telegram списком для ручного розгляду Крістіни/менеджера;
//   * --limit=N + жорстка стеля MAX_CARDS; партії з паузою-контрольною точкою;
//   * Telegram-сповіщення на старті LIVE-прогону і підсумкове наприкінці.
//
// Послідовність на одну картку (кроки з ТЗ):
//   1  відкрити картку ліда в колонці "Замовлення сформовано"
//   2  ПІБ  через inline-popover -> зберегти -> звірити PUT contact.full_name
//   3  телефон -> зберегти -> КРИТИЧНО звірити PUT contact.phone (не popover)
//   4  email (якщо є) -> зберегти -> звірити PUT contact.email (warn, не блок)
//   5  "Зберегти покупця" (активна одразу після full_name)
//      -> POST /clients/from-contact (clientId) + PUT /leads/{id} (client_id)
//   6  перейти на повну картку покупця: goto /app/clients/{clientId}
//      (надійніша заміна "кліку по імені" — узгоджено, повністю відрекогнащено)
//   7  "Адреси доставки" -> "+ Додати" -> модалка "Інформація про доставку"
//   8  радіо "Адреса", потім "Склад" (обхід gotcha: поля не монтуються, якщо
//      "Склад" уже активний і клік = no-op)
//   9  місто: type validation.city.citySearchText у #shipment-city ->
//      GET /delivery/novaposhta/location -> вибрати item.Ref === city.ref
//  10  склад: type extraction.warehouse_number у #shipment-warehouse ->
//      GET /delivery/novaposhta/warehouse -> вибрати item.Ref === warehouse.match.ref
//  11  "Зберегти адресу" -> POST /clients/{id}/shipping-address -> перевірити GET
//  12  закрити картку. "Успішно завершити обробку" НЕ натискаємо НІКОЛИ.
// ===========================================================================

// ---------------------------------------------------------------------------
// ПРАПОРЦІ ЗАПУСКУ
// ---------------------------------------------------------------------------
const LIVE_MODE = process.argv.includes('--live');
// run-cycle-подібні обгортки редіректять stdout у файл -> isTTY === false.
// У звичайному терміналі -> true. Використовуємо як сигнал "ручний запуск".
const LIKELY_MANUAL_RUN = Boolean(process.stdout.isTTY);

const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const PROCESS_LIMIT = limitArg ? Math.max(0, parseInt(limitArg.split('=')[1], 10) || 0) : Infinity;

const batchArg = process.argv.find((a) => a.startsWith('--batch-size='));
const BATCH_SIZE = batchArg ? Math.max(1, parseInt(batchArg.split('=')[1], 10) || 1) : 10;
const BATCH_PAUSE_MS = 12000;

// Жорстка стеля: захист від аномалії в підрахунку кандидатів (напр. якщо
// файли колись підмінять великим списком). Перевищення -> аборт + notify.
const MAX_CARDS = 25;

const RESP_TIMEOUT_MS = 20000;
const CARD_PAUSE_MS = 800;

// ---------------------------------------------------------------------------
// СЕЛЕКТОРИ (усі підтверджені recon'ом 14.08 і 30.08.2026)
// ---------------------------------------------------------------------------
const S = {
  // дошка / колонка (ідентично collect-orders.js, apply-classification.js)
  columnTitle: '.column-title__text',
  boardCard: '.lead-card.clickable',
  columnScrollContainer: '.column-content.scrollable',
  // модалка картки ліда
  leadModal: '.el-dialog.lead-full-card',
  leadModalTitle: '.lead-title',
  leadModalClose: '.dialog-close',
  // inline-поповери контактних даних усередині картки ліда
  pibTrigger: '.lead-name',                 // hasText: /Вкажіть/i (порожнє ПІБ)
  addPhoneTrigger: '.order-link',           // hasText: /Додати телефон/i
  addEmailTrigger: '.order-link',           // hasText: /Додати email/i
  popover: '.el-popover',                   // :visible .last()
  pibInput: 'input[name="full_name"]',
  phoneInput: 'input[placeholder="+38 (___) ___ __ __"]',
  emailInput: 'input[name="email"]',
  popoverSave: 'button',                    // hasText: /^\s*Зберегти\s*$/i
  savePurchaserBtn: 'button',               // hasText: /Зберегти покупця/i
  // модалка адреси доставки (client card)
  addrDrawer: '.el-drawer.address-drawer',  // .filter({ has: .address-form }).last()
  addrForm: '.address-form',
  radioBtnInner: '.el-radio-button__inner',
  cityInput: '#shipment-city',
  warehouseInput: '#shipment-warehouse',
  selectDropdown: '.el-select-dropdown.el-popper',
  selectDropdownItem: '.el-select-dropdown__item',
  saveAddressBtn: 'button',                 // hasText: /Зберегти адресу/i (у addrDrawer)
};

const API = config.API_BASE_URL;

// ---------------------------------------------------------------------------
// Дрібні хелпери
// ---------------------------------------------------------------------------
function ensureDirs() {
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(config.DEBUG_DIR, { recursive: true });
}

function appendLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(config.FILL_LOG_PATH, line + '\n', 'utf-8');
}

// Дублює у консоль + у лог-файл під-крок, щоб і термінал, і JSONL були
// самодостатні для розбору "де саме впало".
function step(base, stepName, result, note, detail) {
  const rec = { ...base, step: stepName, result };
  if (note !== undefined) rec.note = note;
  if (detail !== undefined) rec.detail = detail;
  appendLog(rec);
  const tag = { ok: 'OK', skipped: 'SKIP', 'would-do': 'DRY', 'would-save': 'DRY', failed: 'FAIL', error: 'ERR' }[result] || result;
  console.log(`    [${tag}] ${stepName}${note ? ' — ' + note : ''}`);
}

function stripChatPrefix(text) {
  return text ? text.replace(/^\s*Чат\s*з\s*/i, '').trim() : null;
}

function normName(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// Останні N цифр — стійке порівняння телефонів попри різні формати
// (0XXXXXXXXX / 380XXXXXXXXX / +380XXXXXXXXX).
function digitsTail(s, n = 9) {
  const d = String(s || '').replace(/\D/g, '');
  return d.length >= n ? d.slice(-n) : d;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readAuthToken() {
  const ss = JSON.parse(fs.readFileSync(config.STORAGE_STATE_PATH, 'utf-8'));
  const origin = (ss.origins || []).find((o) => /keycrm\.app/.test(o.origin));
  const item = origin && (origin.localStorage || []).find((i) => i.name === 'authToken');
  if (!item) throw new Error('authToken не знайдено в storage-state.json');
  return item.value;
}

// Read-only перевірки стану через API (не через сторінку -> не залежить від
// dry-run route-перехоплення, яке блокує лише не-GET).
async function apiGet(pathname, authToken) {
  const res = await fetch(API + pathname, {
    headers: { Authorization: `Bearer ${authToken}`, Accept: 'application/json' },
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch (e) { /* лишаємо text */ }
  return { status: res.status, json, text };
}

async function saveShot(page, label) {
  try {
    await page.screenshot({ path: path.join(config.DEBUG_DIR, `fill-${label}.png`), fullPage: true });
  } catch (e) { /* ігноруємо */ }
}

// Готуємо очікування відповіді ПЕРЕД дією, що її ініціює.
function expectApi(page, method, urlSubstr, timeout = RESP_TIMEOUT_MS) {
  return page
    .waitForResponse(
      (r) => r.request().method() === method && r.url().includes(urlSubstr),
      { timeout },
    )
    .catch(() => null);
}

// ---------------------------------------------------------------------------
// Завантаження та фільтрація вхідних даних
// ---------------------------------------------------------------------------
function loadCandidates() {
  for (const p of [config.EXTRACTION_OUTPUT_PATH, config.VALIDATION_OUTPUT_PATH]) {
    if (!fs.existsSync(p)) {
      console.error(`Не знайдено ${p}. Спочатку: npm run collect && npm run extract && npm run validate`);
      process.exit(1);
    }
  }
  const extraction = JSON.parse(fs.readFileSync(config.EXTRACTION_OUTPUT_PATH, 'utf-8'));
  const validation = JSON.parse(fs.readFileSync(config.VALIDATION_OUTPUT_PATH, 'utf-8'));
  const valByIndex = new Map(validation.map((v) => [v.cardIndex, v]));

  const joined = extraction.map((e) => ({ extraction: e, validation: valByIndex.get(e.cardIndex) || null }));

  const eligible = [];
  const skipped = [];
  for (const row of joined) {
    const e = row.extraction;
    const v = row.validation;
    const reasons = [];
    if (!v) reasons.push('немає рядка у validation_results.json');
    if (e.confidence !== 'high') reasons.push(`confidence: ${e.confidence}`);
    if (v && v.city && v.city.status !== 'ok') reasons.push(`city.status: ${v.city.status}`);
    if (v && v.warehouse && v.warehouse.status !== 'ok') reasons.push(`warehouse.status: ${v.warehouse.status}`);
    if (v && v.warehouse && v.warehouse.needsAttention === true) reasons.push('warehouse.needsAttention');
    if (!normName(e.full_name)) reasons.push('порожнє full_name');
    if (!digitsTail(e.phone)) reasons.push('порожній phone');
    if (!String(e.warehouse_number || '').trim()) reasons.push('порожній warehouse_number');
    if (v && v.city && !v.city.ref) reasons.push('немає city.ref');
    if (v && v.warehouse && v.warehouse.match && !v.warehouse.match.ref) reasons.push('немає warehouse.match.ref');

    const item = {
      cardIndex: e.cardIndex,
      customerName: e.customerName || normName(e.full_name),
      fullName: normName(e.full_name),
      phone: String(e.phone || '').trim(),
      email: String(e.email || '').trim(),
      citySearchText: (v && v.city && (v.city.citySearchText || v.city.originalCityText)) || e.city,
      cityRef: v && v.city && v.city.ref,
      cityPresent: v && v.city && v.city.matches && v.city.matches[0] && v.city.matches[0].present,
      cityArea: v && v.city && v.city.matches && v.city.matches[0] && v.city.matches[0].area,
      warehouseNumber: String(e.warehouse_number || '').trim(),
      warehouseRef: v && v.warehouse && v.warehouse.match && v.warehouse.match.ref,
      warehouseDesc: v && v.warehouse && v.warehouse.match && v.warehouse.match.description,
      confidence: e.confidence,
    };

    if (reasons.length) skipped.push({ ...item, skipReasons: reasons });
    else eligible.push(item);
  }
  return { eligible, skipped };
}

function formatSkippedForNotify(skipped) {
  if (!skipped.length) return '';
  const lines = skipped.slice(0, 15).map((s) => `  #${s.cardIndex} ${s.customerName} — ${s.skipReasons.join('; ')}`);
  let t = `\nПропущено (ручний розгляд): ${skipped.length}\n${lines.join('\n')}`;
  if (skipped.length > 15) t += `\n  ...і ще ${skipped.length - 15}, повний перелік у ${path.basename(config.FILL_LOG_PATH)}`;
  return t;
}

// ---------------------------------------------------------------------------
// Навігація дошкою (порт з apply-classification.js)
// ---------------------------------------------------------------------------
async function getOrderFormedColumn(page) {
  const title = page.locator(S.columnTitle, { hasText: config.ORDER_FORMED_COLUMN_TITLE }).first();
  await title.waitFor({ state: 'visible', timeout: 30000 });
  return title.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " lead-column ")][1]');
}

async function scrollColumnToLoadAllCards(page, column, targetCount) {
  const scrollContainer = column.locator(S.columnScrollContainer).first();
  const handle = await scrollContainer.elementHandle();
  if (!handle) return column.locator(S.boardCard).count();
  const cards = column.locator(S.boardCard);
  let count = await cards.count();
  let stable = 0;
  for (let i = 0; i < 40 && count < targetCount && stable < 3; i++) {
    await handle.evaluate((el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll', { bubbles: true })); });
    await page.waitForTimeout(700);
    const n = await cards.count();
    stable = n === count ? stable + 1 : 0;
    count = n;
  }
  return count;
}

async function ensureAllCardsLoaded(page, column) {
  const badgeText = await column.locator('.leads-total').first().innerText().catch(() => null);
  const badge = badgeText ? parseInt(badgeText.trim(), 10) : null;
  let count = await column.locator(S.boardCard).count();
  if (badge && count < badge) count = await scrollColumnToLoadAllCards(page, column, badge);
  return { count, badge };
}

// Ідентифікуємо картку заново перед КОЖНОЮ обробкою — за унікальним іменем,
// відкриваючи модалку й звіряючи .lead-title (позиційний індекс і data-id
// з board-DOM ненадійні; імʼя може повторюватись -> тоді пропускаємо).
// Повертає { status: 'found'|'not-found'|'ambiguous', index, leadId, cards }.
async function locateCardByName(page, column, customerName) {
  await ensureAllCardsLoaded(page, column);
  const cards = column.locator(S.boardCard);
  const n = await cards.count();
  const hits = [];
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    await card.scrollIntoViewIfNeeded().catch(() => {});
    await card.dblclick();
    const modal = page.locator(`${S.leadModal}:visible`);
    await modal.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    const title = stripChatPrefix(await modal.locator(S.leadModalTitle).first().innerText().catch(() => ''));
    const leadId = await card.getAttribute('data-id').catch(() => null);
    const match = normName(title) === normName(customerName);
    await closeLeadCard(page);
    await page.waitForTimeout(300);
    if (match) hits.push({ index: i, leadId });
  }
  if (hits.length === 0) return { status: 'not-found', cards };
  if (hits.length > 1) return { status: 'ambiguous', cards, hits };
  return { status: 'found', cards, index: hits[0].index, leadId: hits[0].leadId };
}

async function openLeadCard(cards, index) {
  const card = cards.nth(index);
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await card.dblclick();
}

async function getVisibleLeadModal(page) {
  const modal = page.locator(`${S.leadModal}:visible`);
  await modal.waitFor({ state: 'visible', timeout: 30000 });
  return modal;
}

async function closeLeadCard(page) {
  const btn = page.locator(`${S.leadModal}:visible ${S.leadModalClose}`).first();
  if (await btn.count()) await btn.click().catch(() => {});
  else await page.keyboard.press('Escape').catch(() => {});
  await page.locator(`${S.leadModal}:visible`).waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Кроки 2–4: inline-поповери контактних даних у картці ліда
// ---------------------------------------------------------------------------
// kind: 'full_name' | 'phone' | 'email'
// Повертає { done, ok, stored, note }:
//   done=false  — поле вже містило коректне значення, дія не потрібна
//   ok=false    — сервер не прийняв значення (для phone — critical)
async function fillContactField(page, base, modal, kind, sentValue, leadId, live, currentValue) {
  const cfg = {
    full_name: {
      label: 'ПІБ', stepName: 'fill-full_name',
      trigger: modal.locator(S.pibTrigger, { hasText: /Вкажіть/i }).first(),
      input: S.pibInput,
      match: (a, b) => normName(a) === normName(b),
      pick: (contact) => contact && contact.full_name,
    },
    phone: {
      label: 'телефон', stepName: 'fill-phone',
      trigger: modal.locator(S.addPhoneTrigger, { hasText: /Додати телефон/i }).first(),
      input: S.phoneInput,
      match: (a, b) => digitsTail(a) && digitsTail(a) === digitsTail(b),
      pick: (contact) => contact && contact.phone,
    },
    email: {
      label: 'email', stepName: 'fill-email',
      trigger: modal.locator(S.addEmailTrigger, { hasText: /Додати email/i }).first(),
      input: S.emailInput,
      match: (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase(),
      pick: (contact) => contact && contact.email,
    },
  }[kind];

  // 1) Поле вже заповнене?
  if (currentValue) {
    if (cfg.match(currentValue, sentValue)) {
      step(base, cfg.stepName, 'ok', 'already-set: значення в CRM вже коректне', { stored: currentValue });
      return { done: false, ok: true, stored: currentValue };
    }
    // заповнене іншим значенням — редагування вже наявного поля НЕ
    // відрекогнащено (тригер відрізняється від "Додати…"); не чіпаємо.
    step(base, cfg.stepName, 'skipped', `manual-review: поле ${cfg.label} має інше значення`, { inCrm: currentValue, expected: sentValue });
    return { done: false, ok: false, manualReview: true };
  }

  // 2) Порожнє поле — dry-run лише повідомляє намір.
  if (!live) {
    step(base, cfg.stepName, 'would-do', `заповнив би ${cfg.label}`, { sent: sentValue });
    return { done: true, ok: true, stored: null };
  }

  // 3) LIVE: відкрити popover, заповнити, зберегти, звірити PUT.
  try {
    await cfg.trigger.waitFor({ state: 'visible', timeout: 10000 });
    await cfg.trigger.click();
    await page.waitForTimeout(500);
    const popover = page.locator(`${S.popover}:visible`).last();
    await popover.waitFor({ state: 'visible', timeout: 5000 });
    const input = popover.locator(cfg.input).first();
    await input.click({ timeout: 3000 }).catch(() => {});
    await input.fill(sentValue);
    await page.waitForTimeout(200);
    const masked = await input.inputValue().catch(() => null);

    const respP = expectApi(page, 'PUT', `/leads/${leadId}`);
    await popover.locator(S.popoverSave, { hasText: /^\s*Зберегти\s*$/i }).first().click();
    const resp = await respP;
    await page.waitForTimeout(800);

    if (!resp) {
      step(base, cfg.stepName, 'failed', `не дочекались PUT /leads/${leadId} після збереження ${cfg.label}`, { sent: sentValue, masked });
      return { done: true, ok: false };
    }
    if (!resp.url().includes(`/leads/${leadId}`)) {
      step(base, cfg.stepName, 'failed', `PUT пішов на інший lead: ${resp.url()}`, { sent: sentValue });
      return { done: true, ok: false };
    }
    const body = await resp.json().catch(() => null);
    const stored = cfg.pick(body && body.contact);
    const ok = cfg.match(stored, sentValue);
    step(base, cfg.stepName, ok ? 'ok' : 'failed',
      ok ? `${cfg.label} збережено й підтверджено` : `${cfg.label}: сервер НЕ зберіг очікуване значення (мовчазна відмова?)`,
      { sent: sentValue, masked, stored, httpStatus: resp.status() });
    return { done: true, ok, stored };
  } catch (err) {
    step(base, cfg.stepName, 'error', `виняток при заповненні ${cfg.label}: ${err.message}`, { sent: sentValue });
    return { done: true, ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Крок 5: "Зберегти покупця"
// Повертає { ok, clientId }
// ---------------------------------------------------------------------------
async function savePurchaser(page, base, modal, leadId, live) {
  const btn = modal.locator(S.savePurchaserBtn, { hasText: /Зберегти покупця/i }).first();
  // Чекаємо, поки стане активною (за recon — одразу після успішного full_name).
  let enabled = false;
  for (let i = 0; i < 20; i++) {
    if ((await btn.count()) && !(await btn.isDisabled().catch(() => true))) { enabled = true; break; }
    await page.waitForTimeout(500);
  }
  if (!enabled) {
    step(base, 'save-purchaser', 'failed', 'кнопка "Зберегти покупця" не стала активною', {});
    return { ok: false };
  }

  if (!live) {
    step(base, 'save-purchaser', 'would-do', 'натиснув би "Зберегти покупця" (POST /clients/from-contact + PUT /leads/{id})', {});
    return { ok: true, clientId: null };
  }

  const fromContactP = expectApi(page, 'POST', '/clients/from-contact');
  const leadPutP = expectApi(page, 'PUT', `/leads/${leadId}`);
  await btn.click();
  const fromContact = await fromContactP;
  const leadPut = await leadPutP;
  await page.waitForTimeout(1000);

  if (!fromContact) {
    step(base, 'save-purchaser', 'failed', 'не дочекались POST /clients/from-contact', {});
    return { ok: false };
  }
  const fcBody = await fromContact.json().catch(() => null);
  const clientId = fcBody && fcBody.id;
  if (!clientId) {
    step(base, 'save-purchaser', 'failed', 'POST /clients/from-contact без id у відповіді', { httpStatus: fromContact.status() });
    return { ok: false };
  }
  // Звірка привʼязки в ліді
  let linkedOk = false;
  if (leadPut) {
    const lpBody = await leadPut.json().catch(() => null);
    linkedOk = lpBody && lpBody.contact && Number(lpBody.contact.client_id) === Number(clientId);
  }
  step(base, 'save-purchaser', linkedOk ? 'ok' : 'ok',
    linkedOk ? `покупця створено (id ${clientId}) і привʼязано до ліда` : `покупця створено (id ${clientId}); PUT-привʼязку не підтверджено з відповіді — перевіримо GET`,
    { clientId, fromContactStatus: fromContact.status() });
  return { ok: true, clientId };
}

// ---------------------------------------------------------------------------
// Кроки 7–11: адреса доставки на повній картці покупця
// ---------------------------------------------------------------------------
async function openAddressModal(page) {
  const addLink = page.locator('xpath=//*[contains(text(),"Адреси доставки")]/ancestor::*[1]//*[contains(text(),"Додати")]').first();
  await addLink.waitFor({ state: 'visible', timeout: 15000 });
  await addLink.scrollIntoViewIfNeeded().catch(() => {});
  await addLink.click();
  await page.waitForSelector(`${S.addrDrawer} ${S.addrForm}`, { timeout: 15000 });
  await page.waitForTimeout(1000);
  return page.locator(S.addrDrawer).filter({ has: page.locator(S.addrForm) }).last();
}

async function switchDeliveryModeToWarehouse(page) {
  // Спершу "Адреса" (change -> mount), потім "Склад" — інакше поля Місто/Склад
  // не монтуються (за замовч. активний уже "Склад", повторний клік = no-op).
  await page.locator(`label.el-radio-button:has-text("Адреса") ${S.radioBtnInner}`).last().click({ force: true }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.locator(`label.el-radio-button:has-text("Склад") ${S.radioBtnInner}`).last().click({ force: true }).catch(() => {});
  const city = page.locator(S.cityInput).last();
  for (let i = 0; i < 24; i++) {
    if (await city.isVisible().catch(() => false)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function readVisibleOptions(page) {
  return page.evaluate((sel) => {
    const dds = [...document.querySelectorAll(sel.dd)].filter((d) => getComputedStyle(d).display !== 'none');
    const out = [];
    for (const dd of dds) for (const li of dd.querySelectorAll(sel.item)) {
      out.push((li.textContent || '').replace(/\s+/g, ' ').trim());
    }
    return out;
  }, { dd: S.selectDropdown, item: S.selectDropdownItem });
}

// Крок 9. Повертає { ok, present, note }
async function fillCity(page, base, item, live) {
  const input = page.locator(S.cityInput).last();
  const respP = expectApi(page, 'GET', '/delivery/novaposhta/location');
  await input.click();
  await page.waitForTimeout(300);
  await input.type(String(item.citySearchText || '').trim(), { delay: 110 });
  const resp = await respP;
  await page.waitForTimeout(2500);

  if (!resp) {
    step(base, 'fill-city', 'failed', 'не дочекались GET /delivery/novaposhta/location', { query: item.citySearchText });
    return { ok: false };
  }
  const arr = await resp.json().catch(() => null);
  if (!Array.isArray(arr) || !arr.length) {
    step(base, 'fill-city', 'failed', 'порожня відповідь автокомпліту міста', { query: item.citySearchText });
    return { ok: false };
  }
  const hit = arr.find((x) => x.Ref === item.cityRef);
  if (!hit) {
    step(base, 'fill-city', 'failed', 'провалідований city.ref відсутній серед варіантів автокомпліту',
      { query: item.citySearchText, wantRef: item.cityRef, got: arr.slice(0, 8).map((x) => ({ Ref: x.Ref, Present: x.Present })) });
    return { ok: false };
  }

  if (!live) {
    step(base, 'fill-city', 'would-do', `вибрав би місто "${hit.Present}"`, { ref: hit.Ref, present: hit.Present });
    // у dry-run все одно клікаємо (клієнтський вибір, без запису) — щоб
    // наступний крок "склад" мав контекст location_ref.
  }
  const opt = page.locator(`${S.selectDropdown} ${S.selectDropdownItem}`, { hasText: hit.Present }).first();
  await opt.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const val = await input.inputValue().catch(() => null);
  const ok = normName(val) === normName(hit.Present) || (val || '').includes(hit.MainDescription || '###');
  if (live) {
    step(base, 'fill-city', ok ? 'ok' : 'failed', ok ? `місто "${hit.Present}"` : `значення поля міста не збіглось: "${val}"`,
      { ref: hit.Ref, present: hit.Present, fieldValue: val });
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
  return { ok, present: hit.Present, ref: hit.Ref };
}

// Крок 10. Повертає { ok, description }
async function fillWarehouse(page, base, item, live) {
  const input = page.locator(S.warehouseInput).last();
  const respP = expectApi(page, 'GET', '/delivery/novaposhta/warehouse');
  await input.click();
  await page.waitForTimeout(400);
  await input.type(String(item.warehouseNumber).trim(), { delay: 140 });
  const resp = await respP;
  await page.waitForTimeout(2500);

  if (!resp) {
    step(base, 'fill-warehouse', 'failed', 'не дочекались GET /delivery/novaposhta/warehouse', { query: item.warehouseNumber });
    return { ok: false };
  }
  const arr = await resp.json().catch(() => null);
  if (!Array.isArray(arr) || !arr.length) {
    step(base, 'fill-warehouse', 'failed', 'порожня відповідь автокомпліту складу', { query: item.warehouseNumber });
    return { ok: false };
  }
  let hit = arr.find((x) => x.Ref === item.warehouseRef);
  if (!hit) hit = arr.find((x) => String(x.Number) === String(item.warehouseNumber));
  if (!hit) {
    step(base, 'fill-warehouse', 'failed', 'провалідований warehouse.ref/№ відсутній серед варіантів',
      { query: item.warehouseNumber, wantRef: item.warehouseRef, got: arr.slice(0, 8).map((x) => ({ Ref: x.Ref, Number: x.Number, Description: x.Description })) });
    return { ok: false };
  }
  if (hit.Ref !== item.warehouseRef) {
    step(base, 'fill-warehouse', 'failed', `знайдено відділення №${hit.Number}, але Ref не збігається з провалідованим`,
      { gotRef: hit.Ref, wantRef: item.warehouseRef, description: hit.Description });
    return { ok: false };
  }

  if (!live) {
    step(base, 'fill-warehouse', 'would-do', `вибрав би склад "${hit.Description}"`, { ref: hit.Ref, number: hit.Number });
  }
  const opt = page.locator(`${S.selectDropdown} ${S.selectDropdownItem}`, { hasText: hit.Description }).first();
  await opt.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const val = await input.inputValue().catch(() => null);
  const ok = normName(val) === normName(hit.Description);
  if (live) {
    step(base, 'fill-warehouse', ok ? 'ok' : 'failed', ok ? `склад "${hit.Description}"` : `значення поля складу не збіглось: "${val}"`,
      { ref: hit.Ref, number: hit.Number, fieldValue: val });
  }
  return { ok, description: hit.Description, ref: hit.Ref };
}

// Крок 11. Повертає { ok }
async function saveAddress(page, base, drawer, clientId, expectWhRef, live) {
  const btn = drawer.locator(S.saveAddressBtn, { hasText: /Зберегти адресу/i }).first();
  await btn.waitFor({ state: 'visible', timeout: 8000 });
  if (await btn.isDisabled().catch(() => false)) {
    step(base, 'save-address', 'failed', 'кнопка "Зберегти адресу" неактивна', {});
    return { ok: false };
  }

  if (!live) {
    // Клікаємо, але route перехопить POST і залогує тіло як would-save.
    let captured = null;
    await page.route(`${API}/**`, async (route) => {
      const req = route.request();
      if (req.method() !== 'GET' && /\/shipping-address\b/.test(req.url())) {
        captured = { url: req.url(), body: req.postData() };
        return route.abort('failed');
      }
      return route.continue();
    });
    await btn.click().catch(() => {});
    await page.waitForTimeout(2000);
    await page.unroute(`${API}/**`).catch(() => {});
    let body = null;
    try { body = captured && JSON.parse(captured.body); } catch (e) { body = captured && captured.body; }
    const payloadOk = body && body.payload && body.payload.warehouse_ref === expectWhRef && Number(body.client_id) === Number(clientId || body.client_id);
    step(base, 'save-address', 'would-save',
      captured ? `перехоплено POST shipping-address; payload.warehouse_ref ${payloadOk ? 'збігається' : 'НЕ збігається'} з провалідованим` : 'клік виконано, POST не зафіксовано',
      { wouldSaveBody: body, expectWarehouseRef: expectWhRef });
    return { ok: Boolean(captured && payloadOk) };
  }

  // LIVE
  const respP = expectApi(page, 'POST', '/shipping-address');
  await btn.click();
  const resp = await respP;
  await page.waitForTimeout(1200);
  if (!resp) {
    step(base, 'save-address', 'failed', 'не дочекались POST /clients/{id}/shipping-address', {});
    return { ok: false };
  }
  if (!resp.url().includes(`/clients/${clientId}/shipping-address`)) {
    step(base, 'save-address', 'failed', `POST пішов на іншого клієнта: ${resp.url()}`, {});
    return { ok: false };
  }
  const httpOk = resp.status() >= 200 && resp.status() < 300;
  const reqBody = (() => { try { return JSON.parse(resp.request().postData()); } catch (e) { return null; } })();
  const payloadOk = reqBody && reqBody.payload && reqBody.payload.warehouse_ref === expectWhRef;
  step(base, 'save-address', httpOk && payloadOk ? 'ok' : 'failed',
    httpOk && payloadOk ? 'адресу збережено (POST 2xx, payload.warehouse_ref збігається)' : `POST status ${resp.status()}, payloadOk=${payloadOk}`,
    { httpStatus: resp.status(), sentWarehouseRef: reqBody && reqBody.payload && reqBody.payload.warehouse_ref, expectWarehouseRef: expectWhRef });
  return { ok: httpOk && payloadOk };
}

// ---------------------------------------------------------------------------
// Оркестрація однієї картки (кроки A–N з плану)
// ---------------------------------------------------------------------------
async function processCard(page, column, item, live, authToken) {
  const base = { cardIndex: item.cardIndex, customerName: item.customerName, mode: live ? 'live' : 'dry-run' };

  // A. Знайти картку в колонці "Замовлення сформовано".
  const loc = await locateCardByName(page, column, item.customerName);
  if (loc.status === 'not-found') {
    step(base, 'locate-card', 'skipped', `картки "${item.customerName}" немає в колонці "${config.ORDER_FORMED_COLUMN_TITLE}" (ймовірно вже оброблено / переміщено)`, {});
    return { outcome: 'skipped' };
  }
  if (loc.status === 'ambiguous') {
    step(base, 'locate-card', 'skipped', `кілька карток з імʼям "${item.customerName}" — позиційно розрізнити небезпечно, ручний розгляд`, { hits: loc.hits });
    return { outcome: 'skipped', notifyLine: `#${item.cardIndex} ${item.customerName}: неоднозначне імʼя в колонці` };
  }
  const leadId = loc.leadId;
  base.leadId = leadId;
  step(base, 'locate-card', 'ok', `знайдено, leadId=${leadId}, позиція ${loc.index}`, {});

  // B. Прочитати поточний стан контакту через API.
  const leadRes = await apiGet(`/leads/${leadId}`, authToken);
  if (leadRes.status === 401) throw new Error('API 401 — сесія протухла під час прогону');
  if (leadRes.status !== 200 || !leadRes.json) {
    step(base, 'read-state', 'error', `GET /leads/${leadId} -> ${leadRes.status}`, {});
    return { outcome: 'error' };
  }
  const contact = leadRes.json.contact || {};
  let clientId = contact.client_id || null;
  step(base, 'read-state', 'ok', `full_name=${JSON.stringify(contact.full_name)} phone=${JSON.stringify(contact.phone)} email=${JSON.stringify(contact.email)} client_id=${clientId}`,
    { fullName: contact.full_name, phone: contact.phone, email: contact.email, clientId });

  let modal = null;
  try {
    // C. Відкрити картку ліда, звірити title.
    await openLeadCard(loc.cards, loc.index);
    modal = await getVisibleLeadModal(page);
    await page.waitForTimeout(800);
    const modalName = stripChatPrefix(await modal.locator(S.leadModalTitle).first().innerText().catch(() => ''));
    if (normName(modalName) !== normName(item.customerName)) {
      step(base, 'open-lead-card', 'error', `відкрилась не та картка: "${modalName}"`, {});
      await closeLeadCard(page).catch(() => {});
      return { outcome: 'error' };
    }
    step(base, 'open-lead-card', 'ok', `картку відкрито, title="${modalName}"`, {});

    // D. Кроки 2–5 — лише якщо покупця ще не привʼязано.
    if (!clientId) {
      const fn = await fillContactField(page, base, modal, 'full_name', item.fullName, leadId, live, contact.full_name);
      if (fn.manualReview || fn.ok === false) {
        await closeLeadCard(page).catch(() => {});
        return { outcome: fn.manualReview ? 'skipped' : 'failed', notifyLine: `#${item.cardIndex} ${item.customerName}: ПІБ — ${fn.manualReview ? 'ручний розгляд' : 'не збережено'}` };
      }

      const ph = await fillContactField(page, base, modal, 'phone', item.phone, leadId, live, contact.phone);
      if (ph.manualReview || ph.ok === false) {
        step(base, 'abort-card', 'failed', 'КРИТИЧНО: телефон не збережено/не підтверджено — картку зупинено до створення покупця', {});
        await closeLeadCard(page).catch(() => {});
        await saveShot(page, `card${item.cardIndex}-phone-fail`);
        return { outcome: ph.manualReview ? 'skipped' : 'failed', notifyLine: `#${item.cardIndex} ${item.customerName}: телефон не пройшов` };
      }

      if (item.email) {
        const em = await fillContactField(page, base, modal, 'email', item.email, leadId, live, contact.email);
        if (em.ok === false && !em.manualReview) {
          step(base, 'email-warning', 'ok', 'email не збережено — не блокуюче, продовжую', { sent: item.email });
        }
      } else {
        step(base, 'fill-email', 'skipped', 'email відсутній у даних екстракції', {});
      }

      const sp = await savePurchaser(page, base, modal, leadId, live);
      if (!sp.ok) {
        await closeLeadCard(page).catch(() => {});
        await saveShot(page, `card${item.cardIndex}-save-purchaser-fail`);
        return { outcome: 'failed', notifyLine: `#${item.cardIndex} ${item.customerName}: не вдалось "Зберегти покупця"` };
      }
      clientId = sp.clientId;
    } else {
      step(base, 'purchaser', 'skipped', `покупця вже привʼязано (client_id=${clientId}) — кроки 2–5 пропущено`, {});
    }

    // E. Закрити картку ліда. "Успішно завершити обробку" НЕ чіпаємо.
    await closeLeadCard(page);
    step(base, 'close-lead-card', 'ok', 'картку ліда закрито', {});
  } catch (err) {
    step(base, 'lead-card-phase', 'error', `виняток: ${err.message}`, {});
    await saveShot(page, `card${item.cardIndex}-leadphase-error`);
    await closeLeadCard(page).catch(() => {});
    return { outcome: 'error' };
  }

  // --- Адресна фаза ---
  if (!clientId) {
    step(base, 'address-phase', 'skipped', 'dry-run без наявного clientId — адресну частину неможливо перевірити без реального покупця; буде виконана в --live', {});
    return { outcome: 'dry-partial' };
  }
  base.clientId = clientId;

  // F. Адреса з таким відділенням уже є?
  const addrRes = await apiGet(`/clients/${clientId}/shipping-address`, authToken);
  if (addrRes.status === 200 && Array.isArray(addrRes.json)) {
    const exists = addrRes.json.some((a) => a && a.payload && a.payload.warehouse_ref === item.warehouseRef);
    if (exists) {
      step(base, 'address-exists', 'skipped', 'у покупця вже є адреса з цим відділенням — пропускаю', { warehouseRef: item.warehouseRef });
      return { outcome: 'ok' };
    }
  }

  try {
    // G. Повна картка покупця.
    await page.goto(`${config.BASE_URL}/app/clients/${clientId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await page.locator('text=Адреси доставки').first().waitFor({ state: 'visible', timeout: 15000 });
    step(base, 'open-client-card', 'ok', `картку покупця ${clientId} відкрито`, {});

    // H. Модалка адреси.
    const drawer = await openAddressModal(page);
    step(base, 'open-address-modal', 'ok', 'модалку "Інформація про доставку" відкрито', {});

    // I. Режим "Склад".
    const switched = await switchDeliveryModeToWarehouse(page);
    if (!switched) {
      step(base, 'switch-mode', 'failed', 'поля Місто/Склад не змонтувались після перемикання режиму', {});
      await saveShot(page, `card${item.cardIndex}-switch-mode-fail`);
      return { outcome: 'failed', notifyLine: `#${item.cardIndex} ${item.customerName}: не змонтувались поля складу` };
    }
    step(base, 'switch-mode', 'ok', 'режим "Склад", поля Місто/Склад доступні', {});

    // J. Місто.
    const city = await fillCity(page, base, item, live);
    if (!city.ok) { await saveShot(page, `card${item.cardIndex}-city-fail`); return { outcome: 'failed', notifyLine: `#${item.cardIndex} ${item.customerName}: місто` }; }

    // K. Склад.
    const wh = await fillWarehouse(page, base, item, live);
    if (!wh.ok) { await saveShot(page, `card${item.cardIndex}-warehouse-fail`); return { outcome: 'failed', notifyLine: `#${item.cardIndex} ${item.customerName}: відділення` }; }

    // L. Зберегти адресу.
    const saved = await saveAddress(page, base, drawer, clientId, item.warehouseRef, live);
    if (!saved.ok && live) {
      await saveShot(page, `card${item.cardIndex}-save-address-fail`);
      return { outcome: 'failed', notifyLine: `#${item.cardIndex} ${item.customerName}: збереження адреси` };
    }

    // M. Перевірка через GET (лише LIVE).
    if (live) {
      const after = await apiGet(`/clients/${clientId}/shipping-address`, authToken);
      const present = after.status === 200 && Array.isArray(after.json)
        && after.json.some((a) => a && a.payload && a.payload.warehouse_ref === item.warehouseRef);
      step(base, 'verify-address', present ? 'ok' : 'failed',
        present ? 'GET підтвердив: адреса з потрібним відділенням зʼявилась у покупця' : 'GET НЕ бачить нову адресу — перевір вручну',
        { warehouseRef: item.warehouseRef });
      if (!present) return { outcome: 'failed', notifyLine: `#${item.cardIndex} ${item.customerName}: адреса не підтвердилась GET` };
    }

    step(base, 'card-done', 'ok', live ? 'картку опрацьовано повністю' : 'dry-run: усі кроки пройшли перевірку', { clientId, warehouseRef: item.warehouseRef });
    return { outcome: live ? 'ok' : 'dry-ok' };
  } catch (err) {
    step(base, 'address-phase', 'error', `виняток: ${err.message}`, {});
    await saveShot(page, `card${item.cardIndex}-addressphase-error`);
    return { outcome: 'error' };
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  ensureDirs();

  if (!fs.existsSync(config.STORAGE_STATE_PATH)) {
    console.error(`Файл сесії не знайдено: ${config.STORAGE_STATE_PATH}\nСпочатку: npm run login`);
    process.exit(1);
  }
  await ensureFreshSession(config.STORAGE_STATE_PATH);
  const authToken = readAuthToken();

  const { eligible, skipped } = loadCandidates();
  const limited = Number.isFinite(PROCESS_LIMIT) ? eligible.slice(0, PROCESS_LIMIT) : eligible;

  console.log('='.repeat(72));
  console.log(`fill-client-data.js — режим: ${LIVE_MODE ? 'LIVE (РЕАЛЬНІ ЗАПИСИ)' : 'DRY-RUN (без змін)'}`);
  console.log(`Кандидатів (confidence:high + validate ok): ${eligible.length}`);
  console.log(`Пропущено (ручний розгляд): ${skipped.length}`);
  skipped.forEach((s) => console.log(`  #${s.cardIndex} ${s.customerName} — ${s.skipReasons.join('; ')}`));
  if (Number.isFinite(PROCESS_LIMIT) && PROCESS_LIMIT < eligible.length) {
    console.log(`--limit=${PROCESS_LIMIT}: цей прогін обробить перші ${limited.length} з ${eligible.length}.`);
  }
  console.log('='.repeat(72));

  if (limited.length > MAX_CARDS) {
    const msg = `fill-client-data.js: кандидатів (${limited.length}) більше за стелю MAX_CARDS=${MAX_CARDS} — прогін ЗУПИНЕНО. Перевір вхідні файли.`;
    console.error(msg);
    await notify(msg);
    process.exit(1);
  }

  appendLog({ ts: new Date().toISOString(), event: 'run-start', mode: LIVE_MODE ? 'live' : 'dry-run', eligible: eligible.length, skipped: skipped.length, willProcess: limited.length });

  if (LIVE_MODE) {
    console.log('\n' + '#'.repeat(72));
    console.log('УВАГА: LIVE-РЕЖИМ. Скрипт РЕАЛЬНО запише ПІБ/телефон/email, створить');
    console.log('покупця і додасть адресу доставки в KeyCRM. Ctrl+C протягом 5с щоб скасувати.');
    console.log('#'.repeat(72));
    await notify(
      `▶️ fill-client-data.js — СТАРТ LIVE-прогону.\n` +
      `Оброблю ${limited.length} карток (confidence:high + validate ok). Пропущено: ${skipped.length}.`,
    );
    await new Promise((r) => setTimeout(r, 5000));
  } else {
    console.log('\nDRY-RUN (за замовчуванням). Реальний запуск: node fill-client-data.js --live\n');
  }

  const batches = [];
  for (let i = 0; i < limited.length; i += BATCH_SIZE) batches.push(limited.slice(i, i + BATCH_SIZE));

  const tally = { ok: 0, 'dry-ok': 0, 'dry-partial': 0, skipped: 0, failed: 0, error: 0 };
  const notifyLines = [];

  const browser = await chromium.launch({ headless: config.HEADLESS });
  const context = await browser.newContext({ storageState: config.STORAGE_STATE_PATH });
  const page = await context.newPage();

  try {
    await page.goto(config.LEADS_URL, { waitUntil: 'domcontentloaded' });
    await page.locator(S.columnTitle).first().waitFor({ state: 'visible', timeout: 30000 });
    const column = await getOrderFormedColumn(page);
    const { count, badge } = await ensureAllCardsLoaded(page, column);
    console.log(`Колонка "${config.ORDER_FORMED_COLUMN_TITLE}": карток ${count}${badge != null ? ` (бейдж ${badge})` : ''}\n`);

    for (let b = 0; b < batches.length; b++) {
      console.log(`\n=== Партія ${b + 1}/${batches.length} (${batches[b].length} карток) ===`);
      for (let i = 0; i < batches[b].length; i++) {
        const item = batches[b][i];
        console.log(`\n[${b + 1}.${i + 1}] Картка #${item.cardIndex} — ${item.customerName} (${item.confidence})`);
        let res;
        try {
          res = await processCard(page, column, item, LIVE_MODE, authToken);
        } catch (err) {
          step({ cardIndex: item.cardIndex, customerName: item.customerName, mode: LIVE_MODE ? 'live' : 'dry-run' }, 'card-exception', 'error', err.message, {});
          if (/401|сесія протухла/.test(err.message)) throw err; // фатально — виходимо
          res = { outcome: 'error', notifyLine: `#${item.cardIndex} ${item.customerName}: виняток — ${err.message}` };
        }
        tally[res.outcome] = (tally[res.outcome] || 0) + 1;
        if (res.notifyLine) notifyLines.push(res.notifyLine);
        await page.waitForTimeout(CARD_PAUSE_MS);
      }
      if (b < batches.length - 1) {
        console.log(`\nПауза ${BATCH_PAUSE_MS / 1000}с (контрольна точка)...`);
        await page.waitForTimeout(BATCH_PAUSE_MS);
      }
    }
  } finally {
    await browser.close();
  }

  const summary =
    `Режим: ${LIVE_MODE ? 'LIVE' : 'DRY-RUN'}\n` +
    `Опрацьовано карток: ${limited.length}\n` +
    (LIVE_MODE
      ? `  успішно: ${tally.ok} · провал: ${tally.failed} · помилка: ${tally.error} · пропущено: ${tally.skipped}`
      : `  dry-ok: ${tally['dry-ok']} · dry-partial(без покупця): ${tally['dry-partial']} · провал: ${tally.failed} · помилка: ${tally.error} · пропущено: ${tally.skipped}`) +
    (notifyLines.length ? `\nПотребують уваги:\n${notifyLines.map((l) => '  ' + l).join('\n')}` : '') +
    formatSkippedForNotify(skipped);

  console.log('\n' + '='.repeat(72));
  console.log('ПІДСУМОК\n' + summary);
  console.log(`\nПовний лог: ${config.FILL_LOG_PATH}`);
  console.log('='.repeat(72));

  appendLog({ ts: new Date().toISOString(), event: 'run-end', mode: LIVE_MODE ? 'live' : 'dry-run', tally });

  await notify(`✅ fill-client-data.js — ЗАВЕРШЕНО.\n${summary}`);
}

main().catch(async (err) => {
  console.error(err);
  appendLog({ ts: new Date().toISOString(), event: 'fatal', error: err.message });
  await notify(`❌ КРИТИЧНА ПОМИЛКА в fill-client-data.js: ${err.message}`);
  process.exit(1);
});
