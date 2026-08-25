#!/bin/bash
# Автозапуск check-order-notifications.js: перевіряє останнє автоповідомлення
# бота KeyCRM для замовлень у цільових статусах воронки "Доставка" і
# дублює текст, якщо доставка в Instagram Direct провалилась (помилка #10)
# і ще ніхто не продублював вручну.
#
# LIVE-режим НЕ вмикається тут. check-order-notifications.js сам читає
# CHECK_NOTIFICATIONS_LIVE з .env (окремо від APPLY_LIVE і
# MOVE_TO_REMINDER_LIVE) — за замовчуванням відсутній -> DRY-RUN. Свідомо
# залишено в DRY-RUN на старті регулярного розкладу (2026-08-25): власниця
# хоче спершу побачити реальну поведінку скрипта й Telegram-сповіщення
# (включно з окремим 🔔⚠️ алертом на "Фідбек відмова") на регулярній
# основі, перш ніж явно вмикати CHECK_NOTIFICATIONS_LIVE=true.
set -uo pipefail
cd "$(dirname "$0")" || exit 1

TS=$(date +%Y-%m-%d-%H)
LOG="output/cron-check-order-notifications-${TS}.log"
mkdir -p output

{
  echo "=== Автозапуск check-order-notifications.js: $(date -Iseconds) ==="
  node check-order-notifications.js
  STATUS=$?
  if [ "$STATUS" -ne 0 ]; then
    echo "ПОМИЛКА: check-order-notifications.js завершився з кодом $STATUS"
    node notify-failure.js "⚠️ check-order-notifications.js: запуск ПРОВАЛИВСЯ (код $STATUS). Лог: cron-check-order-notifications-${TS}.log"
  fi
  echo "=== Завершено: $(date -Iseconds), exit code: $STATUS ==="
  exit "$STATUS"
} >> "$LOG" 2>&1
