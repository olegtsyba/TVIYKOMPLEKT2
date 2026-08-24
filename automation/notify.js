const fs = require('fs');
const path = require('path');
const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LOG_PATH = path.join(process.cwd(), 'output', 'notify.log');

function logLine(line) {
  const entry = `[${new Date().toISOString()}] ${line}`;
  console.log(entry);
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, entry + '\n');
  } catch (err) {
    console.error(`Не вдалося записати ${LOG_PATH}: ${err.message}`);
  }
}

function notify(text) {
  return new Promise((resolve) => {
    if (!BOT_TOKEN || !CHAT_ID) {
      logLine('⚠️ Telegram сповіщення НЕ надіслано — TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID відсутні в .env');
      resolve(false);
      return;
    }
    const data = JSON.stringify({ chat_id: CHAT_ID, text });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        const bodyPreview = body.length > 300 ? `${body.slice(0, 300)}…` : body;
        if (res.statusCode === 200) {
          logLine(`Telegram OK — status ${res.statusCode}, body: ${bodyPreview}`);
        } else {
          logLine(`⚠️ Telegram ПОМИЛКА — status ${res.statusCode}, body: ${bodyPreview}`);
        }
        resolve(res.statusCode === 200);
      });
    });
    req.setTimeout(15000, () => {
      logLine('⚠️ Telegram ПОМИЛКА: таймаут запиту (15с) — обрив зʼєднання');
      req.destroy();
    });
    req.on('error', (err) => {
      logLine(`⚠️ Telegram ПОМИЛКА ЗАПИТУ: ${err.message}`);
      resolve(false);
    });
    req.write(data);
    req.end();
  });
}

module.exports = { notify };
