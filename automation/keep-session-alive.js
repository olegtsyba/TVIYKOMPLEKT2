const path = require('path');
require(path.join(__dirname, 'keycrm-leads-classifier', 'node_modules', 'dotenv')).config({
  path: path.join(__dirname, 'keycrm-leads-classifier', '.env'),
});
const { ensureFreshSession } = require('./refresh-session');
const { notify } = require('./notify');

const TARGETS = [
  { name: 'keycrm-leads-classifier', storageStatePath: path.join(__dirname, 'keycrm-leads-classifier', 'storage-state.json') },
  { name: 'keycrm-client-data-extractor', storageStatePath: path.join(__dirname, 'keycrm-client-data-extractor', 'storage-state.json') },
];

async function main() {
  const failures = [];
  for (const target of TARGETS) {
    try {
      const { refreshed } = await ensureFreshSession(target.storageStatePath);
      console.log(`[${target.name}] ${refreshed ? 'Токен оновлено' : 'Сесія вже жива'}`);
    } catch (err) {
      console.error(`[${target.name}] ПОМИЛКА: ${err.message}`);
      failures.push(`${target.name}: ${err.message}`);
    }
  }

  if (failures.length > 0) {
    await notify(`⚠️ keep-session-alive: не вдалось утримати сесію KeyCRM для: ${failures.join('; ')}. Потрібен ручний npm run login.`);
    process.exit(1);
  }
  process.exit(0);
}

main();
