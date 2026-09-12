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
async function markOrder(orderId, telegram, error) {
  try {
    await db.collection("orders").doc(orderId).update({
      status: "logged",
      telegram,
      telegramError: error,
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("Failed to update order log", orderId, err);
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
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
      await markOrder(orderId, "failed", "telegram_unreachable");
      res.status(200).json({ ok: true, orderId });
      return;
    }

    if (!tgRes.ok) {
      const tgBody = await tgRes.text().catch(() => "");
      console.error("Telegram rejected sendMessage", tgRes.status, tgBody);
      await markOrder(orderId, "failed", `telegram_rejected_${tgRes.status}`);
      res.status(200).json({ ok: true, orderId });
      return;
    }

    await markOrder(orderId, "sent", null);
    res.status(200).json({ ok: true, orderId });
  }
);
