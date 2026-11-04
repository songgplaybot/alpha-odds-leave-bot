# Alpha Odds on Cloudflare Workers

This entry point preserves Aiven's existing users and join_requests tables, Telegram admin commands, welcome messages, one-use rejoin links, and Mini App. The original Python service remains available for rollback.

## Deploy

Run npm ci in this directory. Wrangler uses Cloudflare OAuth. Never commit credentials. Create a Hyperdrive connection to the existing Aiven database, with query caching disabled, and the alpha-odds-approvals Queue. The Wrangler config contains only non-secret bindings. Upload BOT_TOKEN, ADMIN_ID, and CHANNEL_ID using wrangler secret bulk with private standard input. Apply schema.sql to add the internal bookkeeping tables, then run npm run deploy.

Only after HTTPS, signed /api/admin/state, and unsigned-access rejection pass, change Telegram's webhook and admin menu to the new URL. Preserve queued updates. The webhook secret is compatible with the Python service: SHA-256 of miniapp-webhook: followed by the bot token.

Set PUBLIC_URL to the active Worker origin to enable scheduled webhook recovery. Before migrating away, remove PUBLIC_URL or disable the cron so it does not restore the Cloudflare webhook.

## Durable approvals

One database-backed active job prevents overlapping bulk runs across bot commands and the Mini App. Each Queue delivery processes up to 32 approvals, stopping at the 50-request section boundary. Progress and successful request statuses commit together. Timestamp checks prevent an old approval from resolving a newer request. A 90-second lease prevents concurrent duplicate deliveries. Retrying is safe when Telegram accepted a request before a storage failure.

Rate limits delay subsequent chunks. Permanent failures stay in the pending list. A one-minute cron recovers jobs interrupted between saving progress and enqueueing the next chunk. This provides concurrency, not a promise of 1,000 approvals in seconds. Cloudflare's free execution, Queue-operation, and database-query quotas apply.

Webhook updates are processed before success is returned, with Aiven-backed deduplication. Completion markers expire after seven days. Errors cause Telegram to retry. The Mini App accepts only signed, recent Telegram sessions belonging to ADMIN_ID.

## Verify

npm test covers authentication, webhook access, and concurrency. Set TEST_DATABASE_URL with the appropriate TLS configuration to also run the database recovery test. It uses connection-local temporary tables, simulates 1,000 requests and Telegram failures, and never contacts Telegram or changes real request records.
