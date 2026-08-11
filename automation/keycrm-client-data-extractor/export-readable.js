const fs = require('fs');
const path = require('path');
const config = require('./config');

function formatCityLine(city) {
  if (city.status === 'ok') {
    const noteText = city.note ? ` ℹ️  ${city.note}` : '';
    return `Місто: OK — ${city.matches[0].present} (Ref: ${city.ref})${noteText}`;
  }
  if (city.status === 'неоднозначно') {
    const options = city.matches.map((m) => `    - ${m.present} (Ref: ${m.ref})`).join('\n');
    return `Місто: НЕОДНОЗНАЧНО — потрібен ручний вибір:\n${options}`;
  }
  if (city.status === 'не знайдено') return `Місто: НЕ ЗНАЙДЕНО — ${city.note || ''}`;
  if (city.status === 'не вказано') return `Місто: НЕ ВКАЗАНО в переписці`;
  return `Місто: ПОМИЛКА — ${city.note || ''}`;
}

function formatWarehouseLine(warehouse) {
  if (warehouse.status === 'ok') {
    const w = warehouse.match;
    const noteText = warehouse.note ? ` ${warehouse.needsAttention ? '⚠️ ' : 'ℹ️ '}${warehouse.note}` : '';
    return `Відділення: OK — ${w.description} [${w.category}]${noteText}`;
  }
  if (warehouse.status === 'не знайдено') return `Відділення: НЕ ЗНАЙДЕНО — ${warehouse.note || ''}`;
  if (warehouse.status === 'потребує ручної перевірки') return `Відділення: ПОТРЕБУЄ РУЧНОЇ ПЕРЕВІРКИ — ${warehouse.note || ''}`;
  if (warehouse.status === 'не вказано') return `Відділення: НЕ ВКАЗАНО в переписці`;
  if (warehouse.status === 'не перевірено') return `Відділення: НЕ ПЕРЕВІРЕНО — ${warehouse.note || ''}`;
  return `Відділення: ПОМИЛКА — ${warehouse.note || ''}`;
}

function needsReview(extraction, validation) {
  const reasons = [];
  if (extraction.confidence === 'low' || extraction.confidence === 'medium') {
    reasons.push(`низька/середня впевненість екстракції (${extraction.confidence})`);
  }
  // email не обов'язковий для доставки — його відсутність сама по собі не є підставою для ручної перевірки.
  const criticalMissingFields = (extraction.missing_fields || []).filter((f) => f !== 'email');
  if (criticalMissingFields.length) {
    reasons.push(`відсутні поля: ${criticalMissingFields.join(', ')}`);
  }
  if (validation.city.status !== 'ok') reasons.push(`місто: ${validation.city.status}`);
  if (validation.warehouse.status !== 'ok') reasons.push(`відділення: ${validation.warehouse.status}`);
  if (validation.warehouse.status === 'ok' && validation.warehouse.needsAttention) reasons.push(validation.warehouse.note);
  return reasons;
}

function buildReadableText(dialog, extraction, validation) {
  const lines = [];
  lines.push(`Клієнт: ${dialog ? dialog.customerName : extraction.customerName}`);
  lines.push('='.repeat(60));
  lines.push('');

  if (dialog) {
    lines.push('ПЕРЕПИСКА:');
    dialog.messages.forEach((m, i) => {
      const dirLabel = m.direction === 'incoming' ? 'Клієнт' : 'Менеджер';
      const who = m.sender ? ` (${m.sender})` : '';
      const date = m.dateLabel ? ` — ${m.dateLabel}` : '';
      lines.push(`[${i + 1}] ${dirLabel}${who}${date}`);
      lines.push(m.text);
      lines.push('');
    });
    lines.push('='.repeat(60));
  }

  lines.push('ВИТЯГНУТІ ДАНІ КЛІЄНТА');
  lines.push('='.repeat(60));
  if (extraction) {
    lines.push(`ПІБ: ${extraction.full_name || '(не знайдено)'}`);
    lines.push(`Телефон: ${extraction.phone || '(не знайдено)'}`);
    lines.push(`Email: ${extraction.email || '(не знайдено)'}`);
    lines.push(`Місто (як написав клієнт): ${extraction.city || '(не знайдено)'}`);
    lines.push(`Тип відправлення: ${extraction.warehouse_type}`);
    lines.push(`Номер відділення/поштомата: ${extraction.warehouse_number || '(не вказано)'}`);
    if (extraction.warehouse_address_hint) {
      lines.push(`Адреса-орієнтир (замість номера): ${extraction.warehouse_address_hint}`);
    }
    lines.push(`Впевненість екстракції: ${extraction.confidence || '-'}`);
    if (extraction.rationale) {
      lines.push(`Обґрунтування впевненості: ${extraction.rationale}`);
    }
    if (extraction.missing_fields && extraction.missing_fields.length) {
      lines.push(`Відсутні поля: ${extraction.missing_fields.join(', ')}`);
    }
  } else {
    lines.push('Результат екстракції не знайдено для цієї картки.');
  }
  lines.push('');

  lines.push('='.repeat(60));
  lines.push('ВАЛІДАЦІЯ АДРЕСИ (Нова Пошта)');
  lines.push('='.repeat(60));
  if (validation) {
    lines.push(formatCityLine(validation.city));
    lines.push(formatWarehouseLine(validation.warehouse));

    const reasons = needsReview(extraction, validation);
    if (reasons.length) {
      lines.push('');
      lines.push('⚠️  ПОТРЕБУЄ РУЧНОЇ ПЕРЕВІРКИ:');
      reasons.forEach((r) => lines.push(`  - ${r}`));
    }
  } else {
    lines.push('Результат валідації не знайдено для цієї картки.');
  }
  lines.push('');

  return lines.join('\n');
}

function main() {
  if (!fs.existsSync(config.EXTRACTION_OUTPUT_PATH)) {
    console.error(`Файл з результатами екстракції не знайдено: ${config.EXTRACTION_OUTPUT_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(config.VALIDATION_OUTPUT_PATH)) {
    console.error(`Файл з результатами валідації не знайдено: ${config.VALIDATION_OUTPUT_PATH}`);
    process.exit(1);
  }

  const dialogs = fs.existsSync(config.OUTPUT_PATH)
    ? JSON.parse(fs.readFileSync(config.OUTPUT_PATH, 'utf-8'))
    : [];
  const extractions = JSON.parse(fs.readFileSync(config.EXTRACTION_OUTPUT_PATH, 'utf-8'));
  const validations = JSON.parse(fs.readFileSync(config.VALIDATION_OUTPUT_PATH, 'utf-8'));

  const dialogByIndex = new Map(dialogs.map((d) => [d.cardIndex, d]));
  const validationByIndex = new Map(validations.map((v) => [v.cardIndex, v]));

  const summaryRows = [];
  const reviewRows = [];

  for (const extraction of extractions) {
    const dialog = dialogByIndex.get(extraction.cardIndex);
    const validation = validationByIndex.get(extraction.cardIndex);
    const text = buildReadableText(dialog, extraction, validation);

    const filePath = path.join(config.OUTPUT_DIR, `order-${extraction.cardIndex}-readable.txt`);
    fs.writeFileSync(filePath, text, 'utf-8');
    console.log(`Збережено: output/order-${extraction.cardIndex}-readable.txt`);

    const reasons = validation ? needsReview(extraction, validation) : ['немає результату валідації'];

    summaryRows.push({
      'Клієнт': extraction.customerName || '(без імені)',
      'ПІБ': extraction.full_name || '-',
      'Місто': validation ? validation.city.status : '-',
      'Відділення': validation ? validation.warehouse.status : '-',
      'Впевненість': extraction.confidence || '-',
      'Потребує перевірки': reasons.length ? 'так' : 'ні',
    });

    if (reasons.length) {
      reviewRows.push({ cardIndex: extraction.cardIndex, customerName: extraction.customerName, reasons });
    }
  }

  console.log('\n=== Зведена таблиця ===\n');
  console.table(summaryRows);

  if (reviewRows.length) {
    console.log('\n⚠️  Замовлення, що потребують ручної перевірки:');
    reviewRows.forEach((r) => {
      console.log(`  #${r.cardIndex} — ${r.customerName || '(без імені)'}:`);
      r.reasons.forEach((reason) => console.log(`      - ${reason}`));
    });
  } else {
    console.log('\nУсі замовлення пройшли перевірку без зауважень.');
  }
}

main();
