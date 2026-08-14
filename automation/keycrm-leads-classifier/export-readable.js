const fs = require('fs');
const path = require('path');
const config = require('./config');

function buildReadableText(dialog, classification) {
  const lines = [];
  lines.push(`Клієнт: ${dialog.customerName}`);
  lines.push(`Кількість повідомлень: ${dialog.messages.length}`);
  lines.push('='.repeat(60));
  lines.push('');

  dialog.messages.forEach((m, i) => {
    const dirLabel = m.direction === 'incoming' ? 'Клієнт' : 'Менеджер';
    const who = m.sender ? ` (${m.sender})` : '';
    const date = m.dateLabel ? ` — ${m.dateLabel}` : '';
    lines.push(`[${i + 1}] ${dirLabel}${who}${date}`);
    lines.push(m.text);
    lines.push('');
  });

  lines.push('='.repeat(60));
  lines.push('РЕЗУЛЬТАТ КЛАСИФІКАЦІЇ');
  lines.push('='.repeat(60));
  if (classification) {
    lines.push(`Причина: ${classification.reason || '(помилка класифікації)'}`);
    lines.push(`Впевненість: ${classification.confidence || '-'}`);
    lines.push(`Обґрунтування: ${classification.rationale || '-'}`);
  } else {
    lines.push('Результат класифікації не знайдено для цієї картки.');
  }
  lines.push('');

  return lines.join('\n');
}

function main() {
  if (!fs.existsSync(config.OUTPUT_PATH)) {
    console.error(`Файл із зібраними діалогами не знайдено: ${config.OUTPUT_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(config.CLASSIFICATION_OUTPUT_PATH)) {
    console.error(`Файл із результатами класифікації не знайдено: ${config.CLASSIFICATION_OUTPUT_PATH}`);
    process.exit(1);
  }

  const dialogs = JSON.parse(fs.readFileSync(config.OUTPUT_PATH, 'utf-8'));
  const classifications = JSON.parse(fs.readFileSync(config.CLASSIFICATION_OUTPUT_PATH, 'utf-8'));
  const classByIndex = new Map(classifications.map((c) => [c.cardIndex, c]));

  const summaryRows = [];

  for (const dialog of dialogs) {
    const classification = classByIndex.get(dialog.cardIndex);
    const text = buildReadableText(dialog, classification);
    const filePath = path.join(config.OUTPUT_DIR, `dialog-${dialog.cardIndex}-readable.txt`);
    fs.writeFileSync(filePath, text, 'utf-8');
    console.log(`Збережено: output/dialog-${dialog.cardIndex}-readable.txt`);

    summaryRows.push({
      cardIndex: dialog.cardIndex,
      'Клієнт': dialog.customerName || '(без імені)',
      'Причина': classification?.reason || '(помилка)',
      'Впевненість': classification?.confidence || '-',
    });
  }

  console.log('\n=== Зведена таблиця ===\n');
  console.table(summaryRows.map(({ cardIndex, ...rest }) => rest));

  const needsReview = summaryRows.filter((r) => r['Впевненість'] === 'low');
  if (needsReview.length) {
    console.log('\n⚠️  Потребують ручної перевірки:');
    needsReview.forEach((r) => {
      console.log(`  #${r.cardIndex} — ${r['Клієнт']}: "${r['Причина']}" (впевненість: ${r['Впевненість']})`);
    });
  }
}

main();
