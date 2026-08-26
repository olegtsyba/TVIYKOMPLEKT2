// Спільний витяг повідомлень чату vue-advanced-chat (KeyCRM) —
// використовується і check-order-notifications.js, і
// check-lead-notifications.js (обидва в keycrm-leads-classifier).
// Виконується в контексті сторінки через page.evaluate(extractMessages) —
// тому має спиратись лише на глобальний document, без замикання на
// зовнішні змінні.
//
// Клас "vac-message-wrapper" — один запис. Автора беремо з
// ".vac-text-username" ("KeyCRM Bot" для бота, реальне ім'я менеджера для
// ручних повідомлень; системні записи на кшталт "X закрив(-ла) діалог" не
// мають ні username, ні тексту повідомлення — відсіюються фільтром).
// Помилку доставки (#10) видає іконка ".el-icon-error" всередині
// ".vac-message-date" замість звичайного ".el-icon-check" — підтверджено
// живим прикладом на замовленні #10189 recon'ом 2026-08-24 (скріншот +
// сирий HTML переглянуто вручну).
//
// Текст читаємо через innerText (не textContent) з
// ".vac-format-message-wrapper" і НЕ схлопуємо внутрішні переноси рядків —
// вони змістовні (списки, абзаци в повідомленнях бота на кшталт переліку
// знижок системи лояльності). Раніше тут стояв
// `textContent.replace(/\s+/g, ' ')`, який свідомо перетворював будь-який
// перенос рядка на пробіл — саме це, а не сам textContent, ламало
// форматування копії при дублюванні повідомлення в чат (баг, показаний
// Крістіною на відео 2026-08-26). Підтверджено живим прикладом того ж
// дня (замовлення #10434, повідомлення системи лояльності зі списком
// знижок): textContent і innerText для цього DOM дають ІДЕНТИЧНИЙ,
// коректно структурований результат (KeyCRM рендерить переноси як живі
// символи \n у тексті, не <br>) — innerText обрано як надійніший загальний
// варіант (враховує CSS-рендеринг: <br>, block-елементи, white-space), а
// не тому що textContent сам по собі був зіпсований.
//
// Обрізаємо лише зовнішні пробіли (.trim()) — внутрішню структуру
// (переноси, порожні рядки-роздільники абзаців) лишаємо як є: саме такий
// текст менеджер побачив би і скопіював вручну з чату. Поле вводу чату
// (<textarea placeholder="Введіть повідомлення...">) підтверджено коректно
// приймає багаторядковий текст через Playwright .fill().
function extractMessages() {
  return [...document.querySelectorAll('.vac-message-wrapper')]
    .map((el) => {
      const usernameEl = el.querySelector('.vac-text-username');
      const sender = usernameEl ? usernameEl.textContent.trim() : null;
      const textWrapper = el.querySelector('.vac-format-message-wrapper');
      const text = textWrapper ? textWrapper.innerText.trim() : '';
      const hasError = !!el.querySelector('.vac-message-date .el-icon-error');
      const dataId = el.getAttribute('data-id');
      return { dataId, sender, text, hasError };
    })
    .filter((m) => m.sender && m.text);
}

module.exports = { extractMessages };
