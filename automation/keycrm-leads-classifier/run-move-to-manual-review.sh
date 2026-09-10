#!/bin/bash
# Автозапуск move-to-manual-review.js: переносить картки з "Відхилити лід" у
# "Відхилити лід  ручний розгляд" (status_id=374) для medium/low confidence
# карток, які НЕ підпадають під rule 3/10 маркер move-to-reminder.js (той їх
# забирає окремо). Без цього кроку колонка "Відхилити лід" росте необмежено,
# бо apply-classification.js (run-cycle.sh) обробляє автоматично лише
# confidence "high".
#
# Розклад: 40 10,12,14,16,18,20,22,0 * * * — тобто ГОДИНУ ПІСЛЯ кожного
# run-cycle.sh (парні години), хвилина 40. Офсет +55хв У ТОМУ Ж вікні
# (спробований 2026-09-10) зламався в перший же запуск: run-check-lead-
# notifications.sh (старт :45) на тому самому акаунті tviykomplekt_auto ще
# активно працював (реальні тривалості з логів з 27.08: run-cycle.sh до
# ~33хв, check-order-notifications.sh (:15) до ~55хв у звичайному режимі —
# без --limit, теоретично необмежено, check-lead-notifications.sh (:45) до
# ~39хв, тобто може закінчуватись аж під :25 наступної години). +1год:40
# лишає ~15хв запасу після цього і ~20хв до наступного run-cycle.sh.
# Сервер на TZ=Europe/Kyiv з 2026-08-26.
#
# LIVE-режим НЕ вмикається тут. move-to-manual-review.js сам читає
# MOVE_TO_MANUAL_REVIEW_LIVE з .env (окремо від APPLY_LIVE і
# MOVE_TO_REMINDER_LIVE) — свідоме окреме рішення власника, а не побічний
# ефект розкладу cron. За замовчуванням (без прапора в .env) — DRY-RUN.
set -uo pipefail
cd "$(dirname "$0")" || exit 1

TS=$(date +%Y-%m-%d-%H)
LOG="output/cron-move-to-manual-review-${TS}.log"
mkdir -p output

{
  echo "=== Автозапуск move-to-manual-review.js: $(date -Iseconds) ==="
  node move-to-manual-review.js
  STATUS=$?
  if [ "$STATUS" -ne 0 ]; then
    echo "ПОМИЛКА: move-to-manual-review.js завершився з кодом $STATUS"
    node notify-failure.js "⚠️ move-to-manual-review.js: запуск ПРОВАЛИВСЯ (код $STATUS). Лог: cron-move-to-manual-review-${TS}.log"
  fi
  echo "=== Завершено: $(date -Iseconds), exit code: $STATUS ==="
  exit "$STATUS"
} >> "$LOG" 2>&1
