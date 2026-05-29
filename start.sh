#!/bin/sh
set -e

echo "[START] Running prisma migrate deploy..."
npx prisma migrate deploy
echo "[START] Migrations done. Starting server and worker..."

node src/server.js &
SERVER_PID=$!

node src/workers/jobWorker.js &
WORKER_PID=$!

echo "[START] server PID=$SERVER_PID worker PID=$WORKER_PID"
wait $SERVER_PID $WORKER_PID
