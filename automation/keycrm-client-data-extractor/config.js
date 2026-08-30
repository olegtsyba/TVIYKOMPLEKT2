const path = require('path');

module.exports = {
  BASE_URL: 'https://tviykomplekt.keycrm.app',
  API_BASE_URL: 'https://tviykomplekt.api.keycrm.app',
  LOGIN_URL: 'https://tviykomplekt.keycrm.app/login',
  LEADS_URL: 'https://tviykomplekt.keycrm.app/app/leads',
  STORAGE_STATE_PATH: path.join(__dirname, 'storage-state.json'),
  OUTPUT_DIR: path.join(__dirname, 'output'),
  OUTPUT_PATH: path.join(__dirname, 'output', 'orders_dialogs.json'),
  EXTRACTION_OUTPUT_PATH: path.join(__dirname, 'output', 'extraction_results.json'),
  VALIDATION_OUTPUT_PATH: path.join(__dirname, 'output', 'validation_results.json'),
  FILL_LOG_PATH: path.join(__dirname, 'output', 'fill-client-data-log.jsonl'),
  DEBUG_DIR: path.join(__dirname, 'output', 'debug'),
  ORDER_FORMED_COLUMN_TITLE: 'Замовлення сформовано',
  CARDS_TO_COLLECT: 10,
  HEADLESS: process.env.HEADLESS === 'true',
};
