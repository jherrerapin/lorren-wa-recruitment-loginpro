#!/bin/sh
set -e

echo "[START] Running prisma migrate deploy..."
npx prisma migrate deploy
echo "[START] Migrations done. Starting server bootstrap and workers..."

node src/bootstrap.js &
SERVER_PID=$!

node src/workers/jobWorker.js &
WORKER_PID=$!

node src/workers/cronReminders.js &
REMINDER_PID=$!

node src/workers/attendanceBillingInvoiceWorker.js &
BILLING_PID=$!

echo "[START] server PID=$SERVER_PID worker PID=$WORKER_PID reminders PID=$REMINDER_PID billing PID=$BILLING_PID"
wait $SERVER_PID $WORKER_PID $REMINDER_PID $BILLING_PID
