// Допоміжний модуль для обох проєктів (keycrm-leads-classifier,
// keycrm-client-data-extractor): перевіряє, чи ще живий authToken у
// storage-state.json, і якщо ні — автоматично оновлює його через
// refreshAuthToken, без DevTools і без участі людини.
//
// Технічну можливість підтверджено ручним recon-тестом (11.08.2026) проти
// https://tviykomplekt.api.keycrm.app:
//   GET  /auth/profile  -> 200 (токен живий) / 401 {"message":"Unauthenticated."} (протух)
//   POST /auth/refresh  { token: <refreshAuthToken> } + Authorization: Bearer <authToken>
//                       -> 200 { access_token, refresh_token, expires_in }
//
// Підтверджено живим викликом: свіжий (ще не протухлий на момент виклику)
// authToken успішно обмінюється на нову пару токенів; refresh_token у
// відповіді може лишатись тим самим значенням (сервер не завжди його
// ротує), access_token — завжди новий.
//
// ВАЖЛИВИЙ НЮАНС (виявлено тим самим тестом): щойно access_token був
// один раз використаний для успішного /auth/refresh, СТАРИЙ access_token
// одразу перестає працювати — і як Bearer для звичайних запитів (422/401),
// і як Bearer для ПОВТОРНОГО /auth/refresh (400, так само як і повністю
// зіпсований/нерозшифровний токен). Тобто ендпоінт відхиляє не лише
// "непридатний формат", а й "вже застарілу, перевипущену пару" — тому
// ОБОВ'ЯЗКОВО одразу зберігати нову пару на диск після кожного успішного
// refresh (що й робить ensureFreshSession нижче), інакше наступний виклик
// з диска піде зі "старим" Bearer і теж впаде в 400.
//
// Це також означає, що поведінка для СПРАВЖНЬОГО TTL-протухлого (а не
// просто "перевипущеного" чи зіпсованого) authToken прямим тестом не
// підтверджена — під рукою на момент тесту не було органічно протухлого
// токена. Тому рекомендація: викликати ensureFreshSession() ПРОАКТИВНО
// (на старті кожного pipeline-скрипта, або періодично за розкладом), а не
// покладатись на те, що це спрацює вже ПІСЛЯ того, як токен встиг
// по-справжньому протухнути. Якщо колись усе ж знадобиться оновити вже
// реально протухлий (без наших дій) authToken і POST /auth/refresh
// поверне 400 — це буде сигнал, що для органічного TTL-протухання
// поведінка інша, і без ручного логіну (npm run login) не обійтись.

const fs = require('fs');

const BASE_URL = 'https://tviykomplekt.keycrm.app';
const API_BASE_URL = 'https://tviykomplekt.api.keycrm.app';

function readTokens(storageStatePath) {
  const state = JSON.parse(fs.readFileSync(storageStatePath, 'utf-8'));
  const origin = state.origins.find((o) => o.origin === BASE_URL);
  if (!origin) {
    throw new Error(`Origin ${BASE_URL} не знайдено в ${storageStatePath}`);
  }
  const authEntry = origin.localStorage.find((e) => e.name === 'authToken');
  const refreshEntry = origin.localStorage.find((e) => e.name === 'refreshAuthToken');
  if (!authEntry || !refreshEntry) {
    throw new Error(`authToken/refreshAuthToken не знайдено в ${storageStatePath}`);
  }
  return { state, authEntry, refreshEntry };
}

async function isTokenAlive(authToken) {
  const res = await fetch(`${API_BASE_URL}/auth/profile`, {
    headers: { Authorization: `Bearer ${authToken}`, Accept: 'application/json' },
  });
  return res.status === 200;
}

async function refreshAuthToken(authToken, refreshToken) {
  const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ token: refreshToken }),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error(`POST /auth/refresh повернув HTTP ${res.status}: ${detail}`);
  }

  const data = await res.json();
  if (!data.access_token || !data.refresh_token) {
    throw new Error(`Неочікувана відповідь /auth/refresh: ${JSON.stringify(data)}`);
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

// Перевіряє живучість сесії у storageStatePath і, якщо треба, оновлює її
// на диску. Повертає { refreshed: boolean }. Кидає помилку, якщо ні поточний
// токен не живий, ні оновлення через refreshAuthToken не спрацювало —
// у такому разі потрібне ручне оновлення через DevTools (npm run login).
async function ensureFreshSession(storageStatePath) {
  const { state, authEntry, refreshEntry } = readTokens(storageStatePath);

  if (await isTokenAlive(authEntry.value)) {
    return { refreshed: false };
  }

  console.log('[refresh-session] authToken протух, пробую оновити через refreshAuthToken...');
  const { accessToken, refreshToken } = await refreshAuthToken(authEntry.value, refreshEntry.value);

  authEntry.value = accessToken;
  refreshEntry.value = refreshToken;
  fs.writeFileSync(storageStatePath, JSON.stringify(state, null, 2), 'utf-8');

  console.log(`[refresh-session] Токен оновлено, збережено у ${storageStatePath}`);
  return { refreshed: true };
}

module.exports = { ensureFreshSession, isTokenAlive, refreshAuthToken };

if (require.main === module) {
  const path = require('path');
  const target = process.argv[2];
  if (!target) {
    console.error('Використання: node refresh-session.js <шлях-до-storage-state.json>');
    process.exit(1);
  }

  ensureFreshSession(path.resolve(target))
    .then((result) => {
      console.log(result.refreshed ? 'Сесію оновлено.' : 'Сесія вже жива, оновлення не потрібне.');
    })
    .catch((err) => {
      console.error('[refresh-session] Не вдалося автоматично оновити сесію:', err.message);
      console.error('Потрібне ручне оновлення (DevTools Console або npm run login).');
      process.exit(1);
    });
}
