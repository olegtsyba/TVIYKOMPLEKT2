require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { chromium } = require('playwright');
const config = require('./config');

// Селектори форми логіну — типові варіанти для email/password форм.
// Якщо KeyCRM використовує нестандартну розмітку, скоригуй тут.
const EMAIL_SELECTOR = 'input[type="email"], input[name="email"], input[name="login"], input[autocomplete="username"]';
const PASSWORD_SELECTOR = 'input[type="password"], input[name="password"], input[autocomplete="current-password"]';
// Використовуємо точну (exact) відповідність тексту, бо на сторінці є ще
// кнопка "Увійти через акаунт keyCRM" (SSO), яка теж містить слово "Увійти".

async function main() {
  const email = process.env.KEYCRM_EMAIL;
  const password = process.env.KEYCRM_PASSWORD;

  if (!email || !password) {
    console.error(
      'Помилка: KEYCRM_EMAIL та/або KEYCRM_PASSWORD не задані у файлі .env.\n' +
      'Скопіюй .env.example у .env і заповни реальні дані перед запуском.'
    );
    process.exit(1);
  }

  console.log('Запускаю браузер...');
  const browser = await chromium.launch({ headless: config.HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Якщо бекенд поверне 400 на /auth/login (наприклад, невірні креденшли),
  // одразу піднімаємо зрозумілу помилку замість очікування 60с таймауту навігації.
  page.on('response', async (res) => {
    if (res.url().includes('/auth/login')) {
      const headers = res.headers();
      let bodyText = null;
      try {
        bodyText = await res.text();
      } catch {
        // тіло вже спожите/недоступне — просто лишаємо null
      }
      console.error(
        `[auth/login response] статус ${res.status()} ${res.statusText()} | url: ${res.url()}\n` +
        `  headers: ${JSON.stringify(headers)}\n` +
        `  body: ${bodyText}`
      );
    }
  });

  try {
    console.log(`Відкриваю сторінку логіну: ${config.LOGIN_URL}`);
    await page.goto(config.LOGIN_URL, { waitUntil: 'domcontentloaded' });

    const emailInput = page.locator(EMAIL_SELECTOR).first();
    const passwordInput = page.locator(PASSWORD_SELECTOR).first();

    await emailInput.waitFor({ state: 'visible', timeout: 30000 });
    await emailInput.fill(email);
    // Явно тригеримо input/change — про всяк випадок, якщо реактивний фреймворк
    // (Vue/React) не підхопив programmatic fill() як реальне введення.
    await emailInput.dispatchEvent('input');
    await emailInput.dispatchEvent('change');

    await passwordInput.fill(password);
    await passwordInput.dispatchEvent('input');
    await passwordInput.dispatchEvent('change');
    await passwordInput.blur();

    // Невелика пауза — даємо фронтенду час асинхронно провалідувати форму
    // (і, наприклад, розблокувати кнопку "Увійти").
    await page.waitForTimeout(500);

    // Текст кнопки залежить від мови інтерфейсу форми логіну ("Увійти" укр.
    // / "Enter" англ.) — свіжий контекст без storageState інколи рендерить
    // цю сторінку англійською (виявлено 2026-08-25: сторінка логіну
    // англійською навіть без жодного логіну, тобто локаль визначається ДО
    // автентифікації, не з налаштувань акаунта). Тому шукаємо ОБидва варіанти.
    const submitButton = page.getByRole('button', { name: /^(Увійти|Enter)$/, exact: true });
    await submitButton.waitFor({ state: 'visible', timeout: 10000 });

    // Чекаємо, поки кнопка стане активною (не disabled), максимум 10с.
    await page.waitForFunction(
      () => {
        const btns = [...document.querySelectorAll('button')];
        const btn = btns.find((b) => ['Увійти', 'Enter'].includes(b.textContent.trim()));
        return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
      },
      { timeout: 10000 }
    ).catch(() => {
      console.warn('Попередження: не вдалось підтвердити, що кнопка логіну активна — пробую клікнути все одно.');
    });

    console.log('Надсилаю форму логіну...');
    await submitButton.click();

    // Виявлено 2026-08-25: очікування URL з "/app/" ненадійне — ця SPA,
    // схоже, робить client-side роутинг, який не завжди тригерить подію
    // навігації, яку відстежує waitForURL (POST /auth/login повертав 200
    // з токенами, скріншот показував уже автентифікований дашборд
    // "Привіт, {ім'я}!", а waitForURL все одно падав по таймауту й
    // scriptнавіть не доходив до збереження storageState). Тому чекаємо
    // прямої ознаки успішного логіну — authToken у localStorage (той
    // самий ключ, яким користується fetchAuthToken() в
    // check-order-notifications.js) — а не URL.
    console.log('Очікую появу authToken у localStorage (ознака успішного логіну)...');
    await page.waitForFunction(() => !!localStorage.getItem('authToken'), { timeout: 60000 });

    // Даємо застосунку час дорендерити основний layout перед збереженням сесії.
    await page.waitForTimeout(2000);

    await context.storageState({ path: config.STORAGE_STATE_PATH });
    console.log(`Готово. Сесію збережено у: ${config.STORAGE_STATE_PATH}`);
  } catch (err) {
    console.error('Помилка під час логіну:', err.message);
    await page.screenshot({ path: require('path').join(config.OUTPUT_DIR, 'login-error.png') }).catch(() => {});
    console.error('Скріншот помилки збережено (якщо вдалось) у output/login-error.png');
    throw err;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
