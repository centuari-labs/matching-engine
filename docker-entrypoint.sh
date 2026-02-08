#!/bin/sh
# Runs both matching engine and DB writer. Forwards SIGTERM/SIGINT to both for graceful shutdown.

trap 'kill -TERM $db_pid $me_pid 2>/dev/null; wait $db_pid $me_pid 2>/dev/null; exit 0' TERM INT

node dist/services/db-writer-main.js &
db_pid=$!

node dist/services/main.js &
me_pid=$!

wait
