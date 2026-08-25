#!/bin/bash
# Автозапуск check-lead-notifications.js: масово переносить картки лідів
# із колонок-тригерів ("Нагадати 2" / "Відправити знижку -10%") у
# відповідні колонки "день 2" (обидва цикли воронки "Ліди" одразу) і
# перевіряє в чаті ліда, чи бот KeyCRM доставив автоповідомлення в
# Instagram Direct — дублює текст, якщо доставка провалилась (помилка
# #10) і ще ніхто не продублював вручну.
#
# LIVE-режим НЕ вмикається тут. check-lead-notifications.js сам читає
# CHECK_LEAD_NOTIFICATIONS_LIVE з .env (окремо від APPLY_LIVE,
# MOVE_TO_REMINDER_LIVE і CHECK_NOTIFICATIONS_LIVE) — за замовчуванням
# відсутній -> DRY-RUN. Свідомо залишено в DRY-RUN на старті регулярного
# розкладу (2026-08-25): контрольний ручний --live тест на 2 картках і
# один повний ручний --live прогін (54 картки, 2 безпечні edge-case
# помилки самої перевірки чату — не збої відправки) підтвердили
# коректність сценаріїв delivered/duplicated/already-duplicated-manually,
# але власниця хоче спершу побачити регулярну поведінку скрипта й
# Telegram-сповіщення на розкладі, перш ніж явно вмикати
# CHECK_LEAD_NOTIFICATIONS_LIVE=true.
set -uo pipefail
cd "$(dirname "$0")" || exit 1

TS=$(date +%Y-%m-%d-%H)
LOG="output/cron-check-lead-notifications-${TS}.log"
mkdir -p output

{
  echo "=== Автозапуск check-lead-notifications.js: $(date -Iseconds) ==="
  node check-lead-notifications.js
  STATUS=$?
  if [ "$STATUS" -ne 0 ]; then
    echo "ПОМИЛКА: check-lead-notifications.js завершився з кодом $STATUS"
    node notify-failure.js "⚠️ check-lead-notifications.js: запуск ПРОВАЛИВСЯ (код $STATUS). Лог: cron-check-lead-notifications-${TS}.log"
  fi
  echo "=== Завершено: $(date -Iseconds), exit code: $STATUS ==="
  exit "$STATUS"
} >> "$LOG" 2>&1
