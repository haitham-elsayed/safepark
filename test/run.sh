#!/bin/bash
# Reset local state, boot wrangler dev, run the e2e suite, shut down.
set -u
cd "$(dirname "$0")/.."
pkill -f "wrangler dev" 2>/dev/null
sleep 1
rm -rf .wrangler/state
npx wrangler d1 execute safepark --local --file ./schema.sql >/dev/null 2>&1
npx wrangler dev --port 8787 --test-scheduled > /tmp/wrangler.log 2>&1 &
WPID=$!
for i in $(seq 1 40); do
  curl -s -m 2 http://localhost:8787/health >/dev/null 2>&1 && break
  sleep 1
done
node test/e2e.mjs
RC=$?
kill $WPID 2>/dev/null
pkill -f "wrangler dev" 2>/dev/null
exit $RC
