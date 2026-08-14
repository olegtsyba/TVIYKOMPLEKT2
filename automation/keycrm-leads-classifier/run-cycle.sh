#!/bin/bash
# Автозапуск повного циклу класифікатора лідів: collect -> classify -> apply.
#
# LIVE-режим НЕ вмикається тут. apply-classification.js сам читає
# APPLY_LIVE з .env (за замовчуванням відсутній -> DRY-RUN). Щоб дозволити
# реальні зміни в KeyCRM, власник має явно додати APPLY_LIVE=true в .env —
# це свідоме окреме рішення, а не побічний ефект розкладу cron.
set -uo pipefail
cd "$(dirname "$0")" || exit 1

TS=$(date +%Y-%m-%d-%H)
LOG="output/cron-run-${TS}.log"
mkdir -p output

{
  echo "=== Автозапуск циклу класифікатора лідів: $(date -Iseconds) ==="

  echo "--- npm run collect ---"
  npm run collect
  COLLECT_STATUS=$?
  if [ "$COLLECT_STATUS" -ne 0 ]; then
    echo "ПОМИЛКА: collect завершився з кодом $COLLECT_STATUS — зупиняю цикл"
    node notify-failure.js "⚠️ Автоцикл класифікатора лідів: КРОК COLLECT ПРОВАЛИВСЯ (код $COLLECT_STATUS). Лог: cron-run-${TS}.log"
    exit "$COLLECT_STATUS"
  fi

  echo "--- npm run classify ---"
  npm run classify
  CLASSIFY_STATUS=$?
  if [ "$CLASSIFY_STATUS" -ne 0 ]; then
    echo "ПОМИЛКА: classify завершився з кодом $CLASSIFY_STATUS — зупиняю цикл"
    node notify-failure.js "⚠️ Автоцикл класифікатора лідів: КРОК CLASSIFY ПРОВАЛИВСЯ (код $CLASSIFY_STATUS). Лог: cron-run-${TS}.log"
    exit "$CLASSIFY_STATUS"
  fi

  echo "--- node apply-classification.js --batch-size=30 (режим визначає APPLY_LIVE у .env; за замовчуванням DRY-RUN) ---"
  node apply-classification.js --batch-size=30
  APPLY_STATUS=$?

  echo "=== Цикл завершено: $(date -Iseconds), apply exit code: $APPLY_STATUS ==="
  exit "$APPLY_STATUS"
} >> "$LOG" 2>&1
