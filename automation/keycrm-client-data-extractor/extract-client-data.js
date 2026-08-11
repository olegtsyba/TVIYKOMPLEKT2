require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');

// claude-sonnet-5 — актуальний ідентифікатор моделі Sonnet на момент написання скрипта.
const MODEL = 'claude-sonnet-5';

const PROMPT_TEMPLATE = `Ти аналізуєш переписку менеджера інтернет-магазину з клієнтом, який щойно оформив замовлення. Твоя задача — витягти з переписки дані клієнта, потрібні для картки покупця: ПІБ, телефон, email, місто та відділення/поштомат Нової Пошти.

ВАЖЛИВО:
- У переписці можуть траплятись технічні дублікати повідомлень (наприклад однаковий текст від "KeyCRM Bot" і від менеджера одразу після) — ігноруй дублікати.
- Бери значення полів ЛИШЕ з повідомлень КЛІЄНТА (напрямок "incoming"). Повідомлення менеджера ("outgoing") використовуй тільки як контекст — щоб зрозуміти, на яке питання клієнт відповідає (наприклад, менеджер запитав "Напишіть, будь ласка, ПІБ, номер телефону, місто та відділення Нової Пошти" — а відповідь шукай у наступному повідомленні клієнта).
- Нічого не вигадуй і не добудовуй. Якщо якогось поля немає в тексті переписки — залиш його порожнім рядком "" і додай назву поля у missing_fields.
- Телефон записуй ТОЧНО так, як написав клієнт (не форматуй, не додавай код країни, якщо клієнт його не писав).
- Місто записуй ТОЧНО як написав клієнт (наприклад "Київ", "м. Одеса", "дніпро") — без виправлення помилок і без нормалізації, бо цей текст далі звіряється з довідником Нової Пошти окремим кроком.
- warehouse_type визнач за формулюванням клієнта: "відділення" якщо клієнт явно згадав відділення (або просто номер без уточнення типу — тоді теж "відділення", бо це типовий дефолт), "поштомат" якщо клієнт явно написав "поштомат"/"постомат". Якщо з тексту незрозуміло — постав "не вказано".
- warehouse_number — номер відділення/поштомата, якщо клієнт назвав його числом (наприклад "35", "№35", "відділення 35" -> "35").
- warehouse_address_hint — заповнюй ТІЛЬКИ якщо клієнт вказав відділення/поштомат ЧЕРЕЗ АДРЕСУ (вулицю, орієнтир), а не номером (наприклад "поштомат біля Сільпо на Хрещатику"). Якщо клієнт назвав номер — це поле лишається порожнім "".
- full_name — повне ім'я (і по батькові, якщо є) так, як його написав сам клієнт для доставки. Не плутай з ім'ям клієнта з заголовка чату (те ім'я може бути з Facebook-профілю і відрізнятись від імені для доставки) — пріоритет тексту, де клієнт явно диктує дані для замовлення.
- email НЕ Є обов'язковим полем для доставки Новою Поштою (доставка можлива й без нього). Якщо email відсутній у переписці — постав email: "" і додай "email" у missing_fields, АЛЕ це саме по собі НЕ ПОВИННО знижувати confidence. Оцінюй confidence виключно за чіткістю та однозначністю полів, які дійсно потрібні для доставки: ПІБ, телефон, місто, відділення/поштомат. Якщо ці поля продиктовані клієнтом чітко й однозначно (особливо якщо повторені без розбіжностей), став confidence "high" незалежно від того, чи є email.
- rationale — коротке (1-3 речення) пояснення українською: чому ти обрав саме такий рівень confidence. Явно назви конкретну причину (наприклад: яке з полів ПІБ/телефон/місто/відділення відсутнє чи неоднозначне, чи були розбіжності між повідомленнями клієнта, чи формулювання міста/адреси нестандартне). Відсутність email НЕ є підставою для зниження confidence — не згадуй її як причину medium/low (можеш згадати як окрему примітку, але рівень впевненості на неї не впливає). Якщо жодних застережень немає і всі потрібні для доставки поля продиктовані клієнтом чітко й однозначно — так і напиши.

Ось переписка:
{dialog_text}

Дай відповідь СУВОРО у форматі JSON, без жодного іншого тексту:
{"full_name": "...", "phone": "...", "email": "...", "city": "...", "warehouse_type": "відділення/поштомат/не вказано", "warehouse_number": "...", "warehouse_address_hint": "...", "confidence": "high/medium/low", "missing_fields": ["..."], "rationale": "..."}`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    full_name: { type: 'string' },
    phone: { type: 'string' },
    email: { type: 'string' },
    city: { type: 'string' },
    warehouse_type: { type: 'string', enum: ['відділення', 'поштомат', 'не вказано'] },
    warehouse_number: { type: 'string' },
    warehouse_address_hint: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    missing_fields: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
  },
  required: [
    'full_name', 'phone', 'email', 'city', 'warehouse_type',
    'warehouse_number', 'warehouse_address_hint', 'confidence', 'missing_fields', 'rationale',
  ],
  additionalProperties: false,
};

async function extractDialog(client, dialog) {
  const prompt = PROMPT_TEMPLATE.replace('{dialog_text}', dialog.rawText || '(порожня переписка)');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    output_config: {
      format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
    },
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Відповідь моделі не містить текстового блоку.');
  return JSON.parse(textBlock.text);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      'Помилка: ANTHROPIC_API_KEY не задано у файлі .env.\n' +
      'Додай ключ у .env перед запуском (див. .env.example).'
    );
    process.exit(1);
  }

  if (!fs.existsSync(config.OUTPUT_PATH)) {
    console.error(
      `Файл із зібраними діалогами не знайдено: ${config.OUTPUT_PATH}\n` +
      `Спочатку виконай: npm run collect`
    );
    process.exit(1);
  }

  const dialogs = JSON.parse(fs.readFileSync(config.OUTPUT_PATH, 'utf-8'));
  console.log(`Завантажено діалогів для екстракції: ${dialogs.length}`);

  const client = new Anthropic();
  const results = [];

  for (let i = 0; i < dialogs.length; i++) {
    const dialog = dialogs[i];
    console.log(`\n[${i + 1}/${dialogs.length}] Витягую дані клієнта: ${dialog.customerName || '(без імені)'}...`);
    try {
      const extraction = await extractDialog(client, dialog);
      console.log(`  ПІБ: ${extraction.full_name || '(не знайдено)'}, тел: ${extraction.phone || '(не знайдено)'}, місто: ${extraction.city || '(не знайдено)'}`);
      if (extraction.missing_fields.length) {
        console.log(`  Відсутні поля: ${extraction.missing_fields.join(', ')}`);
      }
      console.log(`  Обґрунтування (${extraction.confidence}): ${extraction.rationale || '(немає)'}`);
      results.push({
        cardIndex: dialog.cardIndex,
        customerName: dialog.customerName,
        ...extraction,
      });
    } catch (err) {
      console.error(`  Помилка екстракції: ${err.message}`);
      results.push({
        cardIndex: dialog.cardIndex,
        customerName: dialog.customerName,
        full_name: '', phone: '', email: '', city: '',
        warehouse_type: 'не вказано', warehouse_number: '', warehouse_address_hint: '',
        confidence: null,
        missing_fields: [],
        rationale: '',
        error: err.message,
      });
    }
  }

  console.log('\n\n=== Результати екстракції ===\n');
  console.table(
    results.map((r) => ({
      'Клієнт': r.customerName || '(без імені)',
      'ПІБ': r.full_name || '-',
      'Телефон': r.phone || '-',
      'Місто': r.city || '-',
      'Відділення': r.warehouse_number || r.warehouse_address_hint || '-',
      'Впевненість': r.confidence || '-',
    }))
  );

  fs.writeFileSync(config.EXTRACTION_OUTPUT_PATH, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`\nЗбережено у: ${config.EXTRACTION_OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
