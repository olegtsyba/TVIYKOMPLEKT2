const { onRequest } = require("firebase-functions/v2/https");
const { defineString } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

const KEYCRM_API_KEY = defineString("KEYCRM_API_KEY");
const KEYCRM_BASE_URL = "https://openapi.keycrm.app/v1";
const PREFIX = "/api/keycrm";

// Telegram order-notification credentials. Kept server-side only so the bot
// token never ships in the public client bundle (previously hardcoded in
// App.tsx). Set both in functions/.env (see functions/.env.example).
const TG_BOT_TOKEN = defineString("TG_BOT_TOKEN");
const TG_CHAT_ID = defineString("TG_CHAT_ID");

// Only read-only catalog endpoints are exposed through the proxy. Anything
// else (including the PUT endpoints that edit prices/stock) is rejected —
// this route exists to hide the API key from the client, not to forward
// arbitrary KeyCRM requests.
const ALLOWED_PATHS = [
  /^\/products$/,
  /^\/products\/categories$/,
  /^\/products\/[\w-]+$/,
  /^\/offers$/,
  /^\/offers\/stocks$/,
];

function appendQuery(searchParams, key, value) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v) => appendQuery(searchParams, key, v));
  } else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      appendQuery(searchParams, `${key}[${k}]`, v);
    }
  } else {
    searchParams.append(key, String(value));
  }
}

exports.keycrmProxy = onRequest(
  { cors: true, region: "us-central1" },
  async (req, res) => {
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    let path = req.path || "/";
    if (path.startsWith(PREFIX)) {
      path = path.slice(PREFIX.length) || "/";
    }

    if (!ALLOWED_PATHS.some((re) => re.test(path))) {
      res.status(404).json({ error: "Unknown or disallowed endpoint" });
      return;
    }

    const url = new URL(KEYCRM_BASE_URL + path);
    for (const [key, value] of Object.entries(req.query)) {
      appendQuery(url.searchParams, key, value);
    }

    try {
      const keycrmRes = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${KEYCRM_API_KEY.value()}`,
          Accept: "application/json",
        },
      });

      const body = await keycrmRes.text();
      res.status(keycrmRes.status);
      res.set(
        "Content-Type",
        keycrmRes.headers.get("content-type") || "application/json"
      );
      res.send(body);
    } catch (err) {
      console.error("KeyCRM proxy error", err);
      res.status(502).json({ error: "Failed to reach KeyCRM" });
    }
  }
);

// Escape the characters that are special to Telegram's HTML parse mode so a
// customer-supplied value (name, city, ...) can't break or inject markup.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Readable enough to eyeball in Firestore, and unique enough to double as the
// KeyCRM `source_uuid` idempotency key once orders reach the CRM.
function buildOrderId() {
  const now = new Date().toISOString().slice(0, 10);
  return `web-${now}-${crypto.randomUUID().slice(0, 8)}`;
}

// This is the first place the project persists client-supplied data, so take
// only known fields, coerce the types and cap the lengths.
function sanitizeItem(item) {
  const obj = item && typeof item === "object" ? item : {};
  const text = (value, max) =>
    isNonEmptyString(value) ? value.trim().slice(0, max) : null;
  // Number() lets Infinity through, which Firestore would happily store.
  const price = Number(obj.price);
  return {
    title: text(obj.title, 200),
    size: text(obj.size, 40),
    color: text(obj.color, 60),
    sku: text(obj.sku, 60),
    price: Number.isFinite(price) && price > 0 ? price : 0,
    quantity: 1, // the cart has no quantity control; each add is its own line
  };
}

// Best-effort: the order is already stored, so a failed status update must not
// turn into a failed request.
async function markOrder(orderId, telegram, error, crm = {}) {
  try {
    await db.collection("orders").doc(orderId).update({
      // 'sent' once KeyCRM has it; 'failed' is what the step 4 sweep picks up.
      status: crm.status === "sent" ? "sent" : crm.status === "failed" ? "failed" : "logged",
      telegram,
      telegramError: error,
      crmStatus: crm.status ?? "skipped",
      crmError: crm.error ?? null,
      keycrmOrderId: crm.keycrmOrderId ?? null,
      serverTotal: crm.serverTotal ?? null,
      priceMismatch: crm.mismatches?.length ? crm.mismatches : null,
      crmWarnings: crm.warnings?.length ? crm.warnings : null,
      skuResolved: crm.skuResolved ?? null,
      attempts: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("Failed to update order log", orderId, err);
  }
}

async function sendTelegram(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN.value()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID.value(), parse_mode: "html", text }),
    });
  } catch (err) {
    console.error("Telegram send failed", err);
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}


// --- KeyCRM order creation -------------------------------------------------

// Defaults if settings/catalog is missing or unreadable. The source falls back
// to the TEST one on purpose: a misconfigured deploy should pollute the test
// filter, never the real order flow.
const CRM_DEFAULT_SOURCE_ID = 3; // "Сайт (тест)"
const CRM_DELIVERY_SERVICE_ID = 3; // "Нова Пошта Циба"
const CRM_BACKOFF_MS = [1000, 2000, 4000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readCrmSettings() {
  try {
    const snap = await db.collection("settings").doc("catalog").get();
    const data = snap.exists ? snap.data() : {};
    return {
      crmEnabled: data.crmEnabled !== false, // opt-out, not opt-in
      orderSourceId: Number(data.orderSourceId) || CRM_DEFAULT_SOURCE_ID,
    };
  } catch (err) {
    console.error("Could not read settings/catalog, using defaults", err);
    return { crmEnabled: true, orderSourceId: CRM_DEFAULT_SOURCE_ID };
  }
}

// `retry` is off for POST: a 5xx can arrive after the order was actually
// created, so retrying here would duplicate it. Failed creates are left to the
// step 4 sweep, which re-checks source_uuid first.
async function keycrmRequest(path, { method = "GET", body, retry = true } = {}) {
  const attempts = retry ? CRM_BACKOFF_MS.length + 1 : 1;
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(CRM_BACKOFF_MS[attempt - 1]);

    let res;
    try {
      res = await fetch(KEYCRM_BASE_URL + path, {
        method,
        headers: {
          Authorization: `Bearer ${KEYCRM_API_KEY.value()}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      lastError = err;
      continue;
    }

    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`KeyCRM ${res.status}: ${text.slice(0, 200)}`);
      continue;
    }
    if (!res.ok) throw new Error(`KeyCRM ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  throw lastError || new Error("KeyCRM unreachable");
}

async function findOfferBySku(sku) {
  const data = await keycrmRequest(
    `/offers?filter[sku]=${encodeURIComponent(sku)}&limit=2`
  );
  const rows = Array.isArray(data.data) ? data.data : [];
  return { offer: rows[0] || null, matches: rows.length };
}

// Already created? Runs before every POST, including the step 4 retries, so the
// same source_uuid can never produce two orders.
async function findExistingOrderId(sourceUuid) {
  const data = await keycrmRequest(
    `/order?filter[source_uuid]=${encodeURIComponent(sourceUuid)}&limit=1`
  );
  const rows = Array.isArray(data.data) ? data.data : [];
  return rows[0]?.id ?? null;
}

// The customer is charged what the site showed them. When KeyCRM disagrees the
// site was working from stale data - the line keeps the promised price and the
// manager gets told loudly, because there is no online payment and they confirm
// every order anyway.
async function buildCrmProducts(items) {
  const products = [];
  const mismatches = [];
  const warnings = [];

  for (const item of items) {
    const properties = [];
    if (item.color) properties.push({ name: "Колір", value: item.color });
    if (item.size) properties.push({ name: "Розмір", value: item.size });

    const line = {
      name: item.title || "Товар",
      price: item.price,
      quantity: item.quantity,
      unit_type: "шт",
      ...(properties.length > 0 ? { properties } : {}),
    };

    if (!item.sku) {
      products.push({ line, skuResolved: false });
      continue;
    }

    let offer = null;
    let matches = 0;
    try {
      ({ offer, matches } = await findOfferBySku(item.sku));
    } catch (err) {
      console.error("Offer lookup failed", item.sku, err);
      warnings.push(`не вдалось перевірити артикул ${item.sku}`);
    }

    if (!offer) {
      // Still worth sending: a line with no catalog link beats a lost order.
      warnings.push(`артикул ${item.sku} не знайдено в каталозі`);
      products.push({ line, skuResolved: false });
      continue;
    }
    if (matches > 1) warnings.push(`артикул ${item.sku} не унікальний у каталозі`);

    if (Number(offer.price) > 0 && Number(offer.price) !== item.price) {
      mismatches.push({ sku: item.sku, site: item.price, crm: Number(offer.price) });
    }

    // KeyCRM links the line to the offer by sku on its own.
    products.push({ line: { ...line, sku: item.sku }, skuResolved: true });
  }

  return { products, mismatches, warnings };
}

function buildManagerComment(sourceId, mismatches, warnings) {
  const parts = [];
  if (sourceId === CRM_DEFAULT_SOURCE_ID) parts.push("[ТЕСТ]");
  parts.push("Замовлення з сайту tviykomplekt.com");
  for (const m of mismatches) {
    parts.push(`⚠️ ЦІНА ${m.sku}: сайт ${m.site} / CRM ${m.crm} — перевірити`);
  }
  for (const w of warnings) parts.push(`⚠️ ${w}`);
  return parts.join("\n");
}


// Returns what the log should record. Never throws: a CRM failure must not cost
// us the Telegram message or the customer's success response.
async function pushOrderToCrm({ orderId, customer, items, settings }) {
  const { products, mismatches, warnings } = await buildCrmProducts(items);
  const serverTotal = products.reduce(
    (sum, p) => sum + (Number(p.line.price) || 0) * (Number(p.line.quantity) || 0),
    0
  );
  const skuResolved = products.map((p) => p.skuResolved);

  const existingId = await findExistingOrderId(orderId);
  if (existingId) {
    console.warn("Order already in KeyCRM, skipping create", orderId, existingId);
    return { status: "sent", keycrmOrderId: existingId, serverTotal, mismatches, warnings, skuResolved };
  }

  const fullName = `${customer.firstName} ${customer.lastName}`.trim();
  const phone = toInternationalPhone(customer.phone);

  const created = await keycrmRequest("/order", {
    method: "POST",
    retry: false,
    body: {
      source_id: settings.orderSourceId,
      source_uuid: orderId,
      manager_comment: buildManagerComment(settings.orderSourceId, mismatches, warnings),
      buyer: { full_name: fullName, phone },
      shipping: {
        delivery_service_id: CRM_DELIVERY_SERVICE_ID,
        shipping_address_city: customer.city,
        shipping_receive_point: customer.branch,
        recipient_full_name: fullName,
        recipient_phone: phone,
      },
      products: products.map((p) => p.line),
    },
  });

  return { status: "sent", keycrmOrderId: created?.id ?? null, serverTotal, mismatches, warnings, skuResolved };
}

// KeyCRM asks for the international form; the checkout already normalises to
// exactly 12 digits, so this is just a reformat.
function toInternationalPhone(value) {
  const digits = String(value).replace(/\D/g, "");
  return digits ? `+${digits}` : String(value);
}

// Receives a structured order payload from the storefront checkout and relays
// it to the orders Telegram chat. This exists so the bot token / chat id stay
// out of the client bundle — the message text is built here, not by the client.
//
// Request  (POST, JSON):
//   { customer: { firstName, lastName, phone, city, branch },
//     items: [{ title, size, color, price, sku }], total }
//
// Every order is written to Firestore `orders/{orderId}` BEFORE Telegram is
// called, so a Telegram outage can no longer lose an order outright - which it
// silently did while the message was the only record.
//
// Response:
//   200 { ok: true, orderId }                     - logged (Telegram may still have failed)
//   400 { error }                                 - malformed payload
//   405 { error }                                 - wrong method
//   500 { error: "log_failed" }                   - could not persist; the client should retry
exports.sendOrderNotification = onRequest(
  { cors: true, region: "us-central1" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const body = req.body || {};
    const customer = body.customer;
    const items = body.items;
    const total = body.total;

    if (!customer || typeof customer !== "object") {
      res.status(400).json({ error: "Missing customer" });
      return;
    }
    const { firstName, lastName, phone, city, branch } = customer;
    for (const [field, value] of Object.entries({
      firstName,
      lastName,
      phone,
      city,
      branch,
    })) {
      if (!isNonEmptyString(value)) {
        res.status(400).json({ error: `Missing field: ${field}` });
        return;
      }
    }
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: "Missing items" });
      return;
    }

    // Persist first. Everything below is best-effort: the order already exists.
    const orderId = buildOrderId();
    try {
      await db.collection("orders").doc(orderId).set({
        source: "web",
        status: "pending",
        telegram: "pending",
        customer: { firstName, lastName, phone, city, branch },
        items: items.map(sanitizeItem),
        // Reported by the client and NOT trusted - recomputed server-side once
        // orders start reaching KeyCRM.
        clientTotal: Number.isFinite(Number(total)) ? Number(total) : 0,
        // Placeholder so online payments can be added without reshaping the doc.
        payment: { status: "unpaid", kind: "none", amount: 0, method: null },
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.error("Failed to log order", err);
      res.status(500).json({ error: "log_failed" });
      return;
    }

    // KeyCRM next. Failures are recorded, never fatal: the order is already
    // stored and the customer must not be asked to submit it again.
    const settings = await readCrmSettings();
    let crm = { status: "skipped" };
    if (settings.crmEnabled) {
      try {
        crm = await pushOrderToCrm({
          orderId,
          customer: { firstName, lastName, phone, city, branch },
          items: items.map(sanitizeItem),
          settings,
        });
      } catch (err) {
        console.error("KeyCRM order creation failed", orderId, err);
        crm = { status: "failed", error: String(err.message || err).slice(0, 500) };
      }
    }

    // Same message layout as the previous client-side implementation.
    let message = `<b>📦 НОВЕ ЗАМОВЛЕННЯ!</b>\n\n`;
    message += `👤 <b>Клієнт:</b> ${escapeHtml(firstName)} ${escapeHtml(lastName)}\n`;
    message += `📞 <b>Телефон:</b> ${escapeHtml(phone)}\n`;
    message += `🏙 <b>Місто:</b> ${escapeHtml(city)}\n`;
    message += `🚚 <b>Відділення/Поштомат НП:</b> ${escapeHtml(branch)}\n\n`;
    message += `🛒 <b>Товари:</b>\n`;
    items.forEach((item, index) => {
      const itemObj = item && typeof item === "object" ? item : {};
      const title = escapeHtml(itemObj.title != null ? itemObj.title : "");
      const size = escapeHtml(itemObj.size != null ? itemObj.size : "");
      const color = isNonEmptyString(itemObj.color) ? escapeHtml(itemObj.color) : "";
      const price = Number(itemObj.price) || 0;
      const variant = color ? `${size}, ${color}` : size;
      message += `${index + 1}. ${title} (${variant}) - ${price} грн\n`;
    });
    message += `\n💰 <b>Разом до сплати:</b> ${Number(total) || 0} грн`;
    if (crm.status === "failed") {
      message += `\n\n⚠️ <b>НЕ ПОТРАПИЛО В CRM</b> — заявка збережена, id ${escapeHtml(orderId)}`;
    }

    let tgRes;
    try {
      tgRes = await fetch(
        `https://api.telegram.org/bot${TG_BOT_TOKEN.value()}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: TG_CHAT_ID.value(),
            parse_mode: "html",
            text: message,
          }),
        }
      );
    } catch (err) {
      console.error("Telegram request failed", err);
      await markOrder(orderId, "failed", "telegram_unreachable", crm);
      res.status(200).json({ ok: true, orderId });
      return;
    }

    if (!tgRes.ok) {
      const tgBody = await tgRes.text().catch(() => "");
      console.error("Telegram rejected sendMessage", tgRes.status, tgBody);
      await markOrder(orderId, "failed", `telegram_rejected_${tgRes.status}`, crm);
      res.status(200).json({ ok: true, orderId });
      return;
    }

    // Separate message so a price mismatch is not buried inside a normal order.
    if (crm.mismatches?.length) {
      const lines = crm.mismatches
        .map((m) => `${escapeHtml(m.sku)}: сайт ${m.site} / CRM ${m.crm}`)
        .join("\n");
      await sendTelegram(
        `⚠️ <b>РОЗБІЖНІСТЬ ЦІН</b>\nЗамовлення ${escapeHtml(orderId)}\n\n${lines}\n\nУ CRM пішла ціна з сайту — перевірте.`
      );
    }

    await markOrder(orderId, "sent", null, crm);
    res.status(200).json({ ok: true, orderId });
  }
);
