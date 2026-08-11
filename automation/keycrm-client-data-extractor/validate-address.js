const fs = require('fs');
const path = require('path');
const config = require('./config');

// ---------------------------------------------------------------------------
// Форма відповіді API підтверджена живим recon-запитом (GET, без побічних
// ефектів) через authToken з storage-state.json:
//
// /delivery/novaposhta/location?query=<text> -> масив
//   { Ref, Present, MainDescription, Area, Region, SettlementTypeCode }
//   Present містить повний опис з типом ("м. Київ, Київська обл."),
//   MainDescription — лише назва населеного пункту ("Київ"), саме по ній
//   і звіряємось. Пошук нечіткий і матчить однакові назви в різних
//   областях/районах (є навіть кілька сіл "Київ") — тому навіть точний
//   збіг по MainDescription може дати кілька кандидатів (неоднозначність).
//
// /delivery/novaposhta/warehouse?location_ref=<Ref> -> масив
//   { Ref, Description, ShortAddress, TypeOfWarehouse, Number, CityRef,
//     CityDescription, SettlementRef, SettlementDescription,
//     SettlementAreaDescription, SettlementTypeDescription,
//     CategoryOfWarehouse }
//   Відповідь без пагінації обрізана на 100 записів — для міст з великою
//   кількістю відділень (Київ і подібні) це замало, тому для перевірки
//   конкретного номера ОБОВ'ЯЗКОВО додаємо &query=<number> (ендпоінт
//   підтримує текстовий фільтр так само, як location) і фільтруємо
//   результат по точному співпадінню Number — query сам по собі лише
//   префіксний/підрядковий пошук ("query=250" матчить і "25018").
// ---------------------------------------------------------------------------

function getAuthToken() {
  if (!fs.existsSync(config.STORAGE_STATE_PATH)) {
    console.error(
      `Файл сесії не знайдено: ${config.STORAGE_STATE_PATH}\n` +
      `Спочатку виконай: npm run login (або онови storage-state.json вручну).`
    );
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(config.STORAGE_STATE_PATH, 'utf-8'));
  const origin = state.origins.find((o) => o.origin === config.BASE_URL);
  const tokenEntry = origin && origin.localStorage.find((e) => e.name === 'authToken');
  if (!tokenEntry) {
    console.error('Не вдалося знайти authToken у storage-state.json.');
    process.exit(1);
  }
  return tokenEntry.value;
}

async function apiGet(authToken, urlPath) {
  const res = await fetch(`${config.API_BASE_URL}${urlPath}`, {
    headers: { Authorization: `Bearer ${authToken}`, Accept: 'application/json' },
  });
  if (res.status === 401) {
    throw new Error('401 Unauthorized — сесія протухла, онови storage-state.json (npm run login або вручну через DevTools).');
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} на ${urlPath}`);
  }
  return res.json();
}

// Клієнт міг написати "м. Київ", "місто Київ" тощо — MainDescription
// у відповіді API цих префіксів не містить, тож знімаємо їх перед звіркою.
function normalizeCityText(raw) {
  return raw
    .trim()
    .replace(/^(м\.|місто|смт\.?|село|с\.)\s*/i, '')
    .trim()
    .toLowerCase();
}

// Клієнт міг дописати уточнення області через кому ("Дрогобич, Львівська
// область") або без коми ("Дрогобич Львівська обл."). MainDescription у
// відповіді API містить ЛИШЕ назву населеного пункту — область там окремим
// полем (Area), тому пошук і звірка по повному рядку з областю ніколи не
// дають точного збігу, навіть якщо потрібне місто є серед fuzzy-кандидатів
// API. Відрізаємо уточнення області перед пошуком/звіркою, а повний
// оригінальний текст лишаємо в результаті окремо — для відображення в звіті.
function stripRegionSuffix(raw) {
  return raw
    .split(',')[0]
    .replace(/\s+(область|обл\.?)\s*$/i, '')
    .trim();
}

function toCandidateInfo(c) {
  return { ref: c.Ref, present: c.Present, area: c.Area, region: c.Region, type: c.SettlementTypeCode };
}

async function fetchWarehouseByNumber(authToken, locationRef, warehouseNumber) {
  const list = await apiGet(
    authToken,
    `/delivery/novaposhta/warehouse?location_ref=${encodeURIComponent(locationRef)}&query=${encodeURIComponent(warehouseNumber)}`
  );
  const exactMatches = list.filter((w) => String(w.Number).trim() === String(warehouseNumber).trim());
  return { list, exactMatches };
}

function buildWarehouseOkResult(match, warehouseType, warehouseNumber, extraNote) {
  let note = extraNote || null;
  // needsAttention розрізняє суто інформаційні нотатки (наприклад
  // "підтверджено тай-брейкером") від реальних попереджень, що
  // потребують ручної перевірки (розбіжність типу відділення) — інакше
  // export-readable.js позначав би "потребує перевірки" навіть повністю
  // благополучні записи лише через наявність будь-якої нотатки.
  let needsAttention = false;
  // М'яка звірка типу — Нова Пошта у CategoryOfWarehouse не завжди явно
  // розрізняє "поштомат" словом, тому це попередження, а не hard fail.
  if (warehouseType === 'поштомат' && match.CategoryOfWarehouse === 'Branch') {
    const mismatchNote = `Клієнт написав "поштомат", але за номером ${warehouseNumber} знайдено відділення (CategoryOfWarehouse=Branch) — перевір вручну.`;
    note = note ? `${note} ${mismatchNote}` : mismatchNote;
    needsAttention = true;
  }
  return {
    status: 'ok',
    match: { ref: match.Ref, description: match.Description, shortAddress: match.ShortAddress, category: match.CategoryOfWarehouse },
    note,
    needsAttention,
  };
}

// Якщо точний збіг MainDescription дає кілька кандидатів (наприклад
// однойменне місто й село), а клієнт назвав номер відділення/поштомата —
// пробуємо розрізнити кандидатів реальністю: запитуємо список складів
// (той самий &query=<номер> прийом для обходу ліміту 100 записів) для
// КОЖНОГО кандидата. Якщо номер існує рівно в одного — це і є
// відповідь, з приміткою що вибір підтверджено перевіркою номера.
async function tryResolveByWarehouseNumber(authToken, exactMatches, warehouseNumber, debugLabel) {
  const hits = [];
  for (let i = 0; i < exactMatches.length; i++) {
    const candidate = exactMatches[i];
    const { list, exactMatches: whMatches } = await fetchWarehouseByNumber(authToken, candidate.Ref, warehouseNumber);
    fs.writeFileSync(
      path.join(config.DEBUG_DIR, `${debugLabel}-warehouse-tiebreak-${i + 1}.json`),
      JSON.stringify(list, null, 2),
      'utf-8'
    );
    if (whMatches.length > 0) {
      hits.push({ candidate, warehouseMatch: whMatches[0] });
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return hits;
}

async function validateCity(authToken, cityText, warehouseNumber, debugLabel) {
  const citySearchText = stripRegionSuffix(cityText);
  const wasCleaned = citySearchText.toLowerCase() !== cityText.trim().toLowerCase();
  const cleanedNote = wasCleaned
    ? `Пошук виконано за очищеною назвою "${citySearchText}" (оригінал з переписки: "${cityText}").`
    : null;

  const candidates = await apiGet(authToken, `/delivery/novaposhta/location?query=${encodeURIComponent(citySearchText)}`);
  fs.writeFileSync(
    path.join(config.DEBUG_DIR, `${debugLabel}-location.json`),
    JSON.stringify(candidates, null, 2),
    'utf-8'
  );

  const normalizedInput = normalizeCityText(citySearchText);
  const exactMatches = candidates.filter((c) => (c.MainDescription || '').trim().toLowerCase() === normalizedInput);

  const withCleanedNote = (note) => (cleanedNote ? (note ? `${cleanedNote} ${note}` : cleanedNote) : note);

  if (exactMatches.length === 0) {
    return {
      status: 'не знайдено',
      ref: null,
      matches: [],
      originalCityText: cityText,
      citySearchText,
      note: withCleanedNote(`Жодного точного співпадіння MainDescription для "${citySearchText}".`),
    };
  }

  if (exactMatches.length > 1) {
    if (warehouseNumber) {
      const hits = await tryResolveByWarehouseNumber(authToken, exactMatches, warehouseNumber, debugLabel);
      if (hits.length === 1) {
        const { candidate, warehouseMatch } = hits[0];
        return {
          status: 'ok',
          ref: candidate.Ref,
          matches: [toCandidateInfo(candidate)],
          originalCityText: cityText,
          citySearchText,
          note: withCleanedNote(`Кілька населених пунктів з назвою "${citySearchText}", але вибір підтверджено перевіркою номера відділення №${warehouseNumber} — він існує лише в одного кандидата.`),
          resolvedWarehouseMatch: warehouseMatch,
        };
      }
    }
    return {
      status: 'неоднозначно',
      ref: null,
      matches: exactMatches.map(toCandidateInfo),
      originalCityText: cityText,
      citySearchText,
      note: withCleanedNote(`Кілька населених пунктів з назвою "${citySearchText}" — потрібен вибір вручну.`),
    };
  }

  const match = exactMatches[0];
  return {
    status: 'ok',
    ref: match.Ref,
    matches: [toCandidateInfo(match)],
    originalCityText: cityText,
    citySearchText,
    note: cleanedNote,
  };
}

async function validateWarehouse(authToken, locationRef, warehouseNumber, warehouseType, debugLabel) {
  const { list, exactMatches } = await fetchWarehouseByNumber(authToken, locationRef, warehouseNumber);
  fs.writeFileSync(
    path.join(config.DEBUG_DIR, `${debugLabel}-warehouse.json`),
    JSON.stringify(list, null, 2),
    'utf-8'
  );

  if (exactMatches.length === 0) {
    return { status: 'не знайдено', match: null, note: `Відділення/поштомат №${warehouseNumber} не знайдено для цього міста.` };
  }

  return buildWarehouseOkResult(exactMatches[0], warehouseType, warehouseNumber);
}

async function main() {
  if (!fs.existsSync(config.EXTRACTION_OUTPUT_PATH)) {
    console.error(
      `Файл з результатами екстракції не знайдено: ${config.EXTRACTION_OUTPUT_PATH}\n` +
      `Спочатку виконай: npm run extract`
    );
    process.exit(1);
  }

  fs.mkdirSync(config.DEBUG_DIR, { recursive: true });

  const authToken = getAuthToken();
  const extractions = JSON.parse(fs.readFileSync(config.EXTRACTION_OUTPUT_PATH, 'utf-8'));
  console.log(`Завантажено записів для валідації адрес: ${extractions.length}`);

  const results = [];

  for (let i = 0; i < extractions.length; i++) {
    const record = extractions[i];
    const debugLabel = `order-${record.cardIndex}`;
    console.log(`\n[${i + 1}/${extractions.length}] Перевіряю адресу: ${record.customerName || '(без імені)'}...`);

    const result = { cardIndex: record.cardIndex, customerName: record.customerName };

    if (!record.city) {
      result.city = { status: 'не вказано', ref: null, matches: [], note: 'Місто не витягнуто з переписки.' };
      result.warehouse = { status: 'не перевірено', match: null, note: 'Місто невідоме.' };
      results.push(result);
      console.log('  Місто відсутнє — пропускаю перевірку.');
      continue;
    }

    try {
      result.city = await validateCity(authToken, record.city, record.warehouse_number, debugLabel);
      console.log(`  Місто "${record.city}": ${result.city.status}`);
    } catch (err) {
      console.error(`  Помилка перевірки міста: ${err.message}`);
      result.city = { status: 'помилка', ref: null, matches: [], note: err.message };
    }

    if (result.city.status !== 'ok') {
      result.warehouse = { status: 'не перевірено', match: null, note: 'Місто не підтверджено однозначно.' };
      results.push(result);
      continue;
    }

    if (result.city.resolvedWarehouseMatch) {
      // Тай-брейкер уже отримав дані складу під час розв'язання
      // неоднозначності міста — повторний запит не потрібен.
      result.warehouse = buildWarehouseOkResult(
        result.city.resolvedWarehouseMatch,
        record.warehouse_type,
        record.warehouse_number,
        'Відділення підтверджено в рамках тай-брейкера міста.'
      );
      console.log(`  Відділення №${record.warehouse_number}: ${result.warehouse.status} (з тай-брейкера)`);
    } else if (record.warehouse_number) {
      try {
        result.warehouse = await validateWarehouse(authToken, result.city.ref, record.warehouse_number, record.warehouse_type, debugLabel);
        console.log(`  Відділення №${record.warehouse_number}: ${result.warehouse.status}`);
      } catch (err) {
        console.error(`  Помилка перевірки відділення: ${err.message}`);
        result.warehouse = { status: 'помилка', match: null, note: err.message };
      }
    } else if (record.warehouse_address_hint) {
      result.warehouse = { status: 'потребує ручної перевірки', match: null, note: `Вказано адресою, не номером: "${record.warehouse_address_hint}".` };
    } else {
      result.warehouse = { status: 'не вказано', match: null, note: 'Номер відділення/поштомата не витягнуто з переписки.' };
    }

    results.push(result);
    // Невелика пауза між запитами — не б'ємо API без потреби.
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log('\n\n=== Результати валідації адрес ===\n');
  console.table(
    results.map((r) => ({
      'Клієнт': r.customerName || '(без імені)',
      'Місто': r.city.status,
      'Відділення': r.warehouse.status,
    }))
  );

  fs.writeFileSync(config.VALIDATION_OUTPUT_PATH, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`\nЗбережено у: ${config.VALIDATION_OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
