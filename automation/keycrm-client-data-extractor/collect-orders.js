const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');

// ---------------------------------------------------------------------------
// СЕЛЕКТОРИ. Підтверджені живою інспекцією DOM tviykomplekt.keycrm.app
// (Element UI / Vue kanban-дошка лідів) — та сама дошка й модалка, що й у
// keycrm-leads-classifier, тільки інша колонка.
// ---------------------------------------------------------------------------
const SELECTORS = {
  columnTitle: '.column-title__text',
  columnAncestor: '.lead-column',
  boardCard: '.lead-card.clickable',
  columnScrollContainer: '.column-content.scrollable',
  modal: '.el-dialog.lead-full-card',
  modalTitle: '.lead-title',
  closeButton: '.dialog-close',
  communicationTabItem: '.el-tabs__item',
  messagesContainer: '.entity-messages',
  messageItem: '.message',
};

function ensureDirs() {
  fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(config.DEBUG_DIR, { recursive: true });
}

async function saveDebugArtifacts(page, label) {
  try {
    await page.screenshot({ path: path.join(config.DEBUG_DIR, `${label}.png`), fullPage: true });
    const html = await page.content();
    fs.writeFileSync(path.join(config.DEBUG_DIR, `${label}.html`), html, 'utf-8');
    console.log(`  [debug] артефакти збережено: output/debug/${label}.png / .html`);
  } catch (err) {
    console.warn(`  [debug] не вдалося зберегти debug-артефакти: ${err.message}`);
  }
}

// Колонка рендерить картки лінивим скролом (Vue virtual-list-подібна
// поведінка): при першому завантаженні в DOM є лише частина карток
// (~15), решта підвантажується, коли прокрутити внутрішній контейнер
// column-content до низу. Бейдж-лічильник у заголовку колонки
// (.leads-total) показує РЕАЛЬНУ кількість карток — саме до нього і
// докручуємо.
async function scrollColumnToLoadAllCards(page, column, targetCount) {
  const scrollContainer = column.locator(SELECTORS.columnScrollContainer).first();
  const scrollHandle = await scrollContainer.elementHandle();
  const cards = column.locator(SELECTORS.boardCard);

  let count = await cards.count();
  let stableRounds = 0;
  for (let i = 0; i < 40 && count < targetCount && stableRounds < 3; i++) {
    await scrollHandle.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.waitForTimeout(700);
    const newCount = await cards.count();
    stableRounds = newCount === count ? stableRounds + 1 : 0;
    count = newCount;
  }
  return count;
}

async function findOrderFormedColumnCards(page) {
  console.log(`Шукаю колонку "${config.ORDER_FORMED_COLUMN_TITLE}"...`);
  const columnTitle = page.locator(SELECTORS.columnTitle, { hasText: config.ORDER_FORMED_COLUMN_TITLE }).first();
  await columnTitle.waitFor({ state: 'visible', timeout: 30000 });

  const column = columnTitle.locator(`xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " lead-column ")][1]`);

  const totalBadgeText = await column.locator('.leads-total').first().innerText().catch(() => null);
  const totalBadge = totalBadgeText ? parseInt(totalBadgeText.trim(), 10) : null;

  const cards = column.locator(SELECTORS.boardCard);
  let count = await cards.count();
  console.log(`Знайдено колонку, карток у DOM: ${count}${totalBadge ? ` (за бейджем колонки: ${totalBadge})` : ''}`);

  if (totalBadge && count < totalBadge) {
    console.log(`Докручую колонку, щоб підвантажити решту карток (${count} -> ${totalBadge})...`);
    count = await scrollColumnToLoadAllCards(page, column, totalBadge);
    console.log(`Після скролу карток у DOM: ${count}`);
  }

  return { column, cards };
}

// Клік по картці kanban-дошки не відкриває модалку зі звичайного одинарного
// кліку (картка — draggable-елемент; drag-бібліотека "з'їдає" перший клік).
// Підтверджено емпірично: потрібен double-click.
async function openCard(cards, index) {
  const card = cards.nth(index);
  await card.scrollIntoViewIfNeeded();
  await card.dblclick();
}

async function openCommunicationTab(page) {
  // DOM тримає ще й прихований компактний варіант з тим самим класом
  // (display:none), тож явно відбираємо лише видиму модалку — інакше
  // Playwright у строгому режимі кидає помилку "resolved to 2 elements".
  const modal = page.locator(`${SELECTORS.modal}:visible`);
  await modal.waitFor({ state: 'visible', timeout: 30000 });

  const commTab = modal.locator(SELECTORS.communicationTabItem, { hasText: 'Спілкування' }).first();
  await commTab.click();

  // Чекаємо, поки з'явиться хоча б одне повідомлення в блоці спілкування.
  await modal.locator(`${SELECTORS.messagesContainer} ${SELECTORS.messageItem}`).first()
    .waitFor({ state: 'visible', timeout: 30000 });

  return modal;
}

// Витяг даних виконується цілком у контексті сторінки (page.evaluate) —
// швидше і надійніше за десятки окремих Playwright-локаторів.
async function extractDialog(page) {
  return page.evaluate(({ modalSel, titleSel, containerSel, itemSel }) => {
    // Може бути декілька елементів з цим класом (прихований компактний
    // варіант має display:none) — беремо саме видимий.
    const dialog = [...document.querySelectorAll(modalSel)].find((el) => !!el.offsetParent);
    if (!dialog) return null;

    const titleEl = dialog.querySelector(titleSel);
    const titleText = titleEl ? titleEl.textContent.trim() : null;
    const customerName = titleText ? titleText.replace(/^Чат\s*з\s*/i, '').trim() : null;

    const panes = [...dialog.querySelectorAll('.el-tab-pane')];
    const activePane = panes.find((p) => p.getBoundingClientRect().width > 50);
    const container = activePane ? activePane.querySelector(containerSel) : null;
    if (!container) return { customerName, messages: [], rawText: '' };

    const msgEls = [...container.querySelectorAll(itemSel)];
    let lastIncomingName = null;
    let lastOutgoingName = null;

    const messages = msgEls
      .map((m) => {
        const textEl = m.querySelector('.message__text');
        const nameEl = m.querySelector('.message__name');
        const dateEl = m.querySelector('.message__date');
        const metaEl = m.querySelector('.message__meta');

        const direction = textEl && textEl.classList.contains('incoming')
          ? 'incoming'
          : (textEl && textEl.classList.contains('outgoing') ? 'outgoing' : null);

        let sender = nameEl ? nameEl.textContent.trim() : null;
        if (sender) {
          if (direction === 'incoming') lastIncomingName = sender;
          else if (direction === 'outgoing') lastOutgoingName = sender;
        } else if (direction === 'incoming') {
          sender = lastIncomingName;
        } else if (direction === 'outgoing') {
          sender = lastOutgoingName;
        }

        let text = '';
        if (textEl) {
          const clone = textEl.cloneNode(true);
          clone.querySelectorAll('.message__link').forEach((a) => a.remove());
          text = clone.textContent.trim();
        }

        return {
          direction,
          sender,
          text,
          dateLabel: dateEl ? dateEl.textContent.trim() : null,
          meta: metaEl ? metaEl.textContent.replace(/\s+/g, ' ').trim() : null,
        };
      })
      .filter((m) => m.text);

    const rawText = messages
      .map((m) => `${m.sender || (m.direction === 'incoming' ? 'Клієнт' : 'Менеджер')}: ${m.text}`)
      .join('\n');

    return { customerName, messages, rawText };
  }, {
    modalSel: SELECTORS.modal,
    titleSel: SELECTORS.modalTitle,
    containerSel: SELECTORS.messagesContainer,
    itemSel: SELECTORS.messageItem,
  });
}

async function closeCard(page) {
  const closeBtn = page.locator(`${SELECTORS.modal}:visible ${SELECTORS.closeButton}`).first();
  if (await closeBtn.count()) {
    await closeBtn.click();
  } else {
    console.warn('  Кнопку закриття не знайдено, закриваю через Escape.');
    await page.keyboard.press('Escape');
  }
  await page.locator(`${SELECTORS.modal}:visible`).waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
}

async function main() {
  ensureDirs();

  if (!fs.existsSync(config.STORAGE_STATE_PATH)) {
    console.error(
      `Файл сесії не знайдено: ${config.STORAGE_STATE_PATH}\n` +
      `Спочатку виконай: npm run login`
    );
    process.exit(1);
  }

  console.log('Запускаю браузер зі збереженою сесією...');
  const browser = await chromium.launch({ headless: config.HEADLESS });
  const context = await browser.newContext({ storageState: config.STORAGE_STATE_PATH });
  const page = await context.newPage();

  const results = [];

  try {
    console.log(`Переходжу на ${config.LEADS_URL}`);
    await page.goto(config.LEADS_URL, { waitUntil: 'domcontentloaded' });
    // Kanban-дошка довантажується асинхронно після початкового рендеру —
    // чекаємо появи хоч однієї колонки замість довільної паузи.
    await page.locator(SELECTORS.columnTitle).first().waitFor({ state: 'visible', timeout: 30000 });

    const { cards } = await findOrderFormedColumnCards(page);
    const totalCards = await cards.count();
    const n = Math.min(config.CARDS_TO_COLLECT, totalCards);
    console.log(`Карток у колонці: ${totalCards}. Обробляю перші ${n}.`);

    for (let i = 0; i < n; i++) {
      console.log(`\n[${i + 1}/${n}] Відкриваю картку #${i + 1}...`);
      try {
        await openCard(cards, i);
        await openCommunicationTab(page);

        // Пауза перед читанням/закриттям — даємо CRM дорендерити асинхронні дані.
        await page.waitForTimeout(1500);

        const dialog = await extractDialog(page);
        if (!dialog) throw new Error('Не вдалося прочитати дані модалки (dialog === null)');

        console.log(`  Клієнт: ${dialog.customerName || '(не визначено)'}, повідомлень: ${dialog.messages.length}`);

        results.push({
          cardIndex: i + 1,
          customerName: dialog.customerName,
          messages: dialog.messages,
          rawText: dialog.rawText,
        });

        await closeCard(page);
        await page.waitForTimeout(1000);
      } catch (err) {
        console.error(`  Помилка на картці #${i + 1}:`, err.message);
        await saveDebugArtifacts(page, `order-${i + 1}-error`);
        await closeCard(page).catch(() => {});
        await page.waitForTimeout(1000);
      }
    }

    fs.writeFileSync(config.OUTPUT_PATH, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`\nГотово. Зібрано діалогів: ${results.length}/${n}.`);
    console.log(`Збережено у: ${config.OUTPUT_PATH}`);
  } catch (err) {
    console.error('Критична помилка:', err.message);
    await saveDebugArtifacts(page, 'fatal-error');
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
