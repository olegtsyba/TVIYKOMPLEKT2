const fs = require('fs');
const path = require('path');
const config = require('./config');
const { ensureFreshSession } = require('../refresh-session');

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

// Клієнт міг написати "м. Київ", "місто Київ", "смт.Заводське" тощо —
// MainDescription у відповіді API цих префіксів не містить. Прибираємо
// префікс і перед самим API-запитом (фуззі-пошук NP не завжди знаходить
// збіги, коли префікс приклеєний до назви без пробілу, напр.
// "смт.Заводське" дає 0 кандидатів, тоді як чисте "Заводське" — 6), і
// перед звіркою з MainDescription.
function stripSettlementTypePrefix(raw) {
  return raw.trim().replace(/^(м\.|місто|смт\.?|село|с\.)\s*/i, '').trim();
}

function normalizeCityText(raw) {
  return stripSettlementTypePrefix(raw).toLowerCase();
}

// Клієнт міг дописати уточнення області через кому в кінці ("Дрогобич,
// Львівська область"), без коми в кінці ("Дрогобич Львівська обл.") або
// в дужках НА ПОЧАТКУ ("(Тернопільська обл.) смт.Заводське" — типовий
// спосіб уточнити регіон для дрібних НП, чия назва сама по собі
// неоднозначна). MainDescription у відповіді API містить ЛИШЕ назву
// населеного пункту — область там окремим полем (Area), тому пошук і
// звірка по повному рядку з областю ніколи не дають точного збігу.
// Відрізаємо уточнення області перед пошуком/звіркою, а розпізнану назву
// області НЕ викидаємо — вона стає додатковим сигналом тай-брейкера
// (filterByRegionHint), коли сама назва населеного пункту неоднозначна
// (кілька однойменних населених пунктів в різних областях).
function extractCityAndRegion(raw) {
  const trimmed = raw.trim();

  const leadingParen = trimmed.match(/^\(\s*([^)]*?)\s*\)\s*(.+)$/s);
  if (leadingParen) {
    const [, parenContent, rest] = leadingParen;
    const regionMatch = parenContent.match(/^(.+?)\s*(?:область|обл\.?)$/i);
    if (regionMatch) {
      return { citySearchText: rest.trim(), regionHint: regionMatch[1].trim() };
    }
  }

  const commaParts = trimmed.split(',');
  if (commaParts.length > 1) {
    const tail = commaParts.slice(1).join(',').trim();
    const regionMatch = tail.match(/^(.+?)\s*(?:область|обл\.?)$/i);
    return {
      citySearchText: commaParts[0].trim(),
      regionHint: regionMatch ? regionMatch[1].trim() : null,
    };
  }

  // Без коми і без провідних дужок: лише прибираємо трейлінгове "обл."/
  // "область", область як сигнал тай-брейкера тут не розпізнаємо (щоб не
  // чіпати поведінку для цього рідкісного варіанту без надійного парсингу).
  return {
    citySearchText: trimmed.replace(/\s+(область|обл\.?)\s*$/i, '').trim(),
    regionHint: null,
  };
}

// Якщо назва населеного пункту сама по собі неоднозначна (кілька
// однойменних в різних областях) і клієнт вказав область — звужуємо
// кандидатів звіркою з полем Area. Якщо жоден кандидат не збігся
// (наприклад, клієнт помилився чи назвав область нестандартно) —
// повертаємо candidates без змін, а не порожній список, щоб не
// втратити реальних кандидатів через хибний сигнал.
function filterByRegionHint(candidates, regionHint) {
  if (!regionHint) return candidates;
  const normalizedHint = regionHint.trim().toLowerCase();
  const filtered = candidates.filter((c) => {
    const area = (c.Area || '').trim().toLowerCase();
    return area === normalizedHint || area.startsWith(normalizedHint) || normalizedHint.startsWith(area);
  });
  return filtered.length > 0 ? filtered : candidates;
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
  const { citySearchText, regionHint } = extractCityAndRegion(cityText);
  const wasCleaned = citySearchText.toLowerCase() !== cityText.trim().toLowerCase();
  const cleanedNote = wasCleaned
    ? `Пошук виконано за очищеною назвою "${citySearchText}" (оригінал з переписки: "${cityText}").`
    : null;

  const queryText = stripSettlementTypePrefix(citySearchText);
  const candidates = await apiGet(authToken, `/delivery/novaposhta/location?query=${encodeURIComponent(queryText)}`);
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
    // Спершу пробуємо звузити за областю, яку назвав клієнт (якщо
    // назвав) — якщо це дає рівно одного кандидата, номер відділення
    // лише підтверджує його (не є єдиним джерелом істини). Якщо ні —
    // працюємо далі з exactMatches як і раніше (без регресії для
    // кейсів без regionHint чи з хибним/нестандартним уточненням
    // області — filterByRegionHint тоді повертає candidates без змін).
    const regionFiltered = filterByRegionHint(exactMatches, regionHint);
    const regionNarrowed = Boolean(regionHint) && regionFiltered.length < exactMatches.length;
    const candidatePool = regionNarrowed ? regionFiltered : exactMatches;

    if (candidatePool.length === 1) {
      const candidate = candidatePool[0];
      let resolvedWarehouseMatch = null;
      if (warehouseNumber) {
        const { exactMatches: whMatches } = await fetchWarehouseByNumber(authToken, candidate.Ref, warehouseNumber);
        if (whMatches.length > 0) resolvedWarehouseMatch = whMatches[0];
      }
      return {
        status: 'ok',
        ref: candidate.Ref,
        matches: [toCandidateInfo(candidate)],
        originalCityText: cityText,
        citySearchText,
        note: withCleanedNote(`Кілька населених пунктів з назвою "${citySearchText}", але вибір підтверджено за областю "${regionHint}", яку вказав клієнт, — вона є лише в одного кандидата.`),
        ...(resolvedWarehouseMatch ? { resolvedWarehouseMatch } : {}),
      };
    }

    if (warehouseNumber) {
      const hits = await tryResolveByWarehouseNumber(authToken, candidatePool, warehouseNumber, debugLabel);
      if (hits.length === 1) {
        const { candidate, warehouseMatch } = hits[0];
        const note = regionNarrowed
          ? `Кілька населених пунктів з назвою "${citySearchText}"; спершу звужено за областю "${regionHint}", яку вказав клієнт, а тоді підтверджено перевіркою номера відділення №${warehouseNumber} — він існує лише в одного кандидата.`
          : `Кілька населених пунктів з назвою "${citySearchText}", але вибір підтверджено перевіркою номера відділення №${warehouseNumber} — він існує лише в одного кандидата.`;
        return {
          status: 'ok',
          ref: candidate.Ref,
          matches: [toCandidateInfo(candidate)],
          originalCityText: cityText,
          citySearchText,
          note: withCleanedNote(note),
          resolvedWarehouseMatch: warehouseMatch,
        };
      }
    }

    return {
      status: 'неоднозначно',
      ref: null,
      matches: candidatePool.map(toCandidateInfo),
      originalCityText: cityText,
      citySearchText,
      note: withCleanedNote(
        regionNarrowed
          ? `Кілька населених пунктів з назвою "${citySearchText}" навіть після звуження за областю "${regionHint}" — потрібен вибір вручну.`
          : `Кілька населених пунктів з назвою "${citySearchText}" — потрібен вибір вручну.`
      ),
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

  if (fs.existsSync(config.STORAGE_STATE_PATH)) {
    try {
      await ensureFreshSession(config.STORAGE_STATE_PATH);
    } catch (err) {
      console.error(`Не вдалося перевірити/оновити сесію: ${err.message}`);
      console.error('Онови сесію вручну: npm run login (або через DevTools Console).');
      process.exit(1);
    }
  }

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
