const path = require('path');

module.exports = {
  BASE_URL: 'https://tviykomplekt.keycrm.app',
  LOGIN_URL: 'https://tviykomplekt.keycrm.app/login',
  LEADS_URL: 'https://tviykomplekt.keycrm.app/app/leads',
  STORAGE_STATE_PATH: path.join(__dirname, 'storage-state.json'),
  OUTPUT_DIR: path.join(__dirname, 'output'),
  OUTPUT_PATH: path.join(__dirname, 'output', 'leads_dialogs.json'),
  CLASSIFICATION_OUTPUT_PATH: path.join(__dirname, 'output', 'classification_results.json'),
  APPLY_LOG_PATH: path.join(__dirname, 'output', 'apply-log.jsonl'),
  DEBUG_DIR: path.join(__dirname, 'output', 'debug'),
  REJECTED_COLUMN_TITLE: 'Відхилити лід',
  // Не точна кількість карток — верхня межа "про всяк випадок" (захист від
  // випадкового збору сотень карток, якщо колонка колись розростеться).
  // Реальну кількість collect-leads.js визначає сам із бейджа-лічильника
  // колонки (.leads-total) і збирає рівно стільки.
  CARDS_TO_COLLECT: 200,
  HEADLESS: process.env.HEADLESS === 'true',
};
