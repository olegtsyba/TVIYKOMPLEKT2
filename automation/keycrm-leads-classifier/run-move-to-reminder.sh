#!/bin/bash
# Щоденний автозапуск move-to-reminder.js: переносить картки з
# "Відхилити лід" у "Нагадати", коли rationale класифікації містить явний
# rule-3/rule-10 маркер ("потребує нагадування", "воронку 'Нагадати'",
# "не остаточної відмови"). М'якший інструмент за класифікатор — тому раз
# на день, не щогодини.
#
# LIVE-режим НЕ вмикається тут. move-to-reminder.js сам читає
# MOVE_TO_REMINDER_LIVE з .env (окремо від APPLY_LIVE, яку читає
# apply-classification.js) — свідоме окреме рішення власника, а не
# побічний ефект розкладу cron.
set -uo pipefail
cd "$(dirname "$0")" || exit 1

TS=$(date +%Y-%m-%d)
LOG="output/cron-move-to-reminder-${TS}.log"
mkdir -p output

{
  echo "=== Автозапуск move-to-reminder.js: $(date -Iseconds) ==="
  node move-to-reminder.js
  STATUS=$?
  if [ "$STATUS" -ne 0 ]; then
    echo "ПОМИЛКА: move-to-reminder.js завершився з кодом $STATUS"
    node notify-failure.js "⚠️ move-to-reminder.js: запуск ПРОВАЛИВСЯ (код $STATUS). Лог: cron-move-to-reminder-${TS}.log"
  fi
  echo "=== Завершено: $(date -Iseconds), exit code: $STATUS ==="
  exit "$STATUS"
} >> "$LOG" 2>&1
