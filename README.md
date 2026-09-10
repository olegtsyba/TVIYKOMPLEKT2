# TVIYKOMPLEKT

Інтернет-вітрина TVIYKOMPLEKT — каталог і лід-форма замовлення поверх KeyCRM.
Каталог (товари, розміри, кольори, наявність) підтягується напряму з KeyCRM,
оформлення замовлення надсилає сповіщення менеджеру в Telegram (оплата й
підтвердження — вручну, без інтеграції з платіжною системою).

## Стек

- React + TypeScript + Vite
- Tailwind CSS
- Firebase (Hosting, Firestore, Cloud Functions, Storage)

## Локальний запуск

```bash
npm install
npm run dev
```

Адмін-панель (`admin.html`) відкривається окремо — вона не збирається Vite,
а копіюється в `dist/` при білді.

## Деплой

```bash
npm run build
firebase deploy
```

Щоб задеплоїти лише частину проєкту:

```bash
firebase deploy --only hosting
firebase deploy --only firestore:rules,storage
firebase deploy --only functions
```
