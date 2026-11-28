# Phase 3: Full D1 staging snapshot and POS pilot

This phase creates a **separate Cloudflare D1 staging database** from the supplied PostgreSQL backup. It does not switch the POS or alter the existing cafe-pos-dev menu pilot.

## Included scope

- 46 application tables from the backup's public schema.
- 5,861 rows across six businesses: IDs 1, 4, 15, 16, 17, and 18. There are also 16 system-level network-usage rows tagged with business ID 0.
- Primary keys, foreign keys, 90 PostgreSQL indexes, 12 unique constraints, and 14 check constraints translated to SQLite/D1.
- The business/profile reference cycle is imported safely by linking business profiles after both tables are present.
- Oversized JSON/text values are preserved exactly through bounded 40 KB chunk inserts, then restored in D1 after their rows are loaded.

Supabase-managed auth, storage, realtime, and extension schemas are not copied. New image uploads made by D1-enabled businesses are stored in Cloudflare R2: menu and category images use `slash-pos-assets-pilot`, and café logos use the separate `cafe-logos` bucket. Existing image URLs and Supabase objects are left intact; D1 references switch to the Worker image URL only when an image is replaced or newly uploaded.

## Important safety and compatibility notes

- The backup and generated snapshot contain customer/business information and authentication-related values, including password fields/hashes and session records. Keep generated/ private; it is ignored by Git. Do not upload or share the generated snapshot.
- This is a point-in-time copy, not ongoing replication. Supabase remains the production source of truth.
- The production POS backend remains the Vercel-hosted Express app using PostgreSQL. A separate opt-in staging bridge can route only explicitly ported POS APIs for allowlisted businesses to this Worker; production continues to use Supabase while the bridge switch is off.
- PostgreSQL row-level security policies are not carried over. D1 has no PostgreSQL RLS; the future Worker/API must enforce business authorization on every query.
- The 14 PostgreSQL CHECK constraints are carried over as SQLite validation triggers. PostgreSQL business functions and non-check triggers are not portable; their behavior must be reimplemented and verified in the Worker/API before production cutover.
- Integer primary keys use SQLite row IDs. The Worker/API must generate UUIDs for UUID-keyed rows.
- INSERT OR REPLACE refreshes rows present in the snapshot. It does not remove rows that were deleted from Supabase after the backup. Use a fresh staging database for a clean snapshot comparison.

## Generate the local schema and data snapshot

Run from this folder:

~~~powershell
node .\scripts\pgdump-public-to-d1.js --input "C:\Users\anshu\OneDrive\Desktop\cafepos_migration\cafe_pos_backup.sql" --schema-output .\generated\schema.sql --data-output .\generated\snapshot.sql --manifest-output .\generated\manifest.json
~~~

migrations\0001_public_schema.sql and migrations\0002_public_constraints.sql are generated from the supplied backup. Review both files if the source schema changes before making a new migration.

## Create and populate the isolated D1 database

The initial database setup uses the Wrangler config below to bind the separate D1 database and the staging Worker described below.

~~~powershell
npx wrangler d1 create cafe-pos-full-dev --location apac
~~~

Copy the database ID Wrangler returns into wrangler.jsonc as database_id. Then apply the schema and snapshot:

~~~powershell
npx wrangler d1 execute cafe-pos-full-dev --remote --file=.\migrations\0001_public_schema.sql
npx wrangler d1 execute cafe-pos-full-dev --remote --file=.\migrations\0002_public_constraints.sql
npx wrangler d1 execute cafe-pos-full-dev --remote --file=.\generated\snapshot.sql
npx wrangler d1 execute cafe-pos-full-dev --remote --file=.\migrations\0003_d1_onboarded_businesses.sql
~~~

The SQL snapshot is locally generated from the user-provided backup. Large individual values are chunked so every SQL statement stays below D1's 100 KB statement limit, and the complete values are reassembled inside D1 after insertion. The temporary helper table is emptied when restoration completes. The D1 file import flow is documented by [Cloudflare](https://developers.cloudflare.com/d1/best-practices/import-export-data/). D1 enforces foreign keys; the import order accounts for the one business/profile cycle, so the import does not disable integrity checks. See [Cloudflare's D1 foreign-key guidance](https://developers.cloudflare.com/d1/sql-api/foreign-keys/).

## Verify the staged copy

After import, compare row counts to generated\manifest.json, for example:

~~~powershell
npx wrangler d1 execute cafe-pos-full-dev --remote --command "SELECT 'businesses' AS table_name, COUNT(*) AS row_count FROM businesses UNION ALL SELECT 'orders', COUNT(*) FROM orders UNION ALL SELECT 'order_items', COUNT(*) FROM order_items UNION ALL SELECT 'menu', COUNT(*) FROM menu UNION ALL SELECT 'payments', COUNT(*) FROM payments;"
~~~

Protected API modules that have not been ported return HTTP 501 when the staging bridge is enabled; they do not silently fall back to PostgreSQL for the same screen. D1 now handles the staged public business-registration flow, device registration and session/auth routes, secure image references, and R2 image uploads in addition to the POS, reporting, QR and support routes described below. The QR menu does not verify guest phone numbers with OTP; its browser-scoped session groups that guest's orders. Keep the Supabase-backed production POS running until the required flows pass staging validation.

## D1 staging Worker

The D1 staging Worker is a separate service. It does not change Supabase or the production route. Existing imported data access remains limited to business IDs 1 and 18. New businesses created through the D1 registration flow are recorded in `d1_onboarded_businesses` and authorized dynamically; this does not activate other businesses in the imported snapshot. Data endpoints require a private STAGING_API_KEY or a short-lived signed backend token and return no-store responses. POS order creation, payment settlement, and public QR order creation each have a Worker-side write gate. The staging bridge routes menu, table, and reservation CRUD, bulk menu import, secure image-reference updates, printer configuration, payment history, POS settings and sale channels, QR menu settings and public menu reads/push subscriptions/tracking, reports, invoice reads/creation, business logo references, billing adjustments, marketing deals/push-campaign records, expenses, loyalty, KOT groups and polling, QR order status, QR service-request polling, and QR order submission to D1. QR guests use browser-stored session details and do not verify their phone numbers with OTP. New item, category and logo uploads for D1-enabled businesses use the `IMAGES` and `LOGOS` R2 bindings to `slash-pos-assets-pilot` and `cafe-logos` respectively. Staging deployment `d549d8a7-88a4-4243-89be-2167cd12c60a` includes these bindings.

Direct D1 endpoint calls are intended for CLI inspection. Do not place either key in the browser or POS JavaScript. No production POS screen or data route is switched to D1.

~~~powershell
npx wrangler secret put STAGING_API_KEY
# Enter a randomly generated value of at least 32 characters when prompted.
~~~

Direct Worker calls require `STAGING_API_KEY`. Calls from the POS backend use a short-lived HMAC token instead and require `D1_STAGING_BRIDGE_SECRET`. If neither secret is configured, data requests fail closed. The public `/health` route returns only the staging mode label. The business allowlist is not a security boundary by itself; a secret or valid signed token is required as well.

The deployed key is stored outside the repository at `%APPDATA%\CafePOS\CloudflareStaging\staging-api-key.txt` and as a Cloudflare Worker secret. Keep that file private and do not commit it. Example PowerShell request:

~~~powershell
$key = [IO.File]::ReadAllText((Join-Path $env:APPDATA 'CafePOS\CloudflareStaging\staging-api-key.txt')).Trim()
$headers = @{ 'X-Staging-Key' = $key }
Invoke-RestMethod -Uri 'https://slash-pos-full-d1-staging.anshulkashyap6464.workers.dev/v1/business?business_id=18' -Headers $headers
~~~

Available direct read endpoints (all require the X-Staging-Key header and a business_id query parameter):

- `GET /v1/business?business_id=18`
- `GET /v1/menu/categories?business_id=18&limit=100&offset=0`
- `GET /v1/menu?business_id=18&limit=100&offset=0`
- `GET /v1/orders?business_id=18&limit=50&offset=0` — compact order list
- `GET /v1/orders/123?business_id=18` — one order summary
- `GET /v1/orders/123/items?business_id=18&limit=50&offset=0`
- `GET /v1/orders/123/payments?business_id=18&limit=50&offset=0`
- `GET /v1/orders/123/kot?business_id=18&limit=50&offset=0`
- `GET /v1/pos/billing-adjustments?business_id=18`
- `GET /v1/pos/marketing/deals?business_id=18`

The authenticated Express inspection paths are /api/d1-staging/orders, /api/d1-staging/orders/:id, and /api/d1-staging/orders/:id/{items|payments|kot}. The Worker also exposes D1 POS paths for menu and variant management, menu categories and option sets, table metadata, reservations, printers, settings, QR menu configuration, customer CRUD, payment history, reports, invoices, business logo references, order lists/details, payment summaries, order activity/status, order creation and editing, settlement, KOT creation, cancellation, and bill-print timestamps. Public QR menu reads, analytics, order tracking/status reads, push subscriptions, and table service requests use D1 for recognized pilot tokens. Order creation and edits recalculate prices and tax from D1, validate the business and dine-in table, and save order items, KOT links, discounts, and activity in D1 batches. Reducing or removing saved items requires a configured cancellation reason. Settlement supports full, split, partial, and non-chargeable payments and writes payment, loyalty award, order state, invoice, optional KOT, and activity in a D1 batch with an optimistic balance check. Customer contact and order data stay scoped to the signed-in business. Network printing and Web Push delivery still run in the existing POS server, while printer configuration, subscriber records, campaign records, and receipt settings for staged businesses use D1.

OrderCoordinator serializes writes for each business before those D1 batches run. It uses a SQLite-backed Durable Object namespace declared in wrangler.jsonc; order, payment, and KOT records remain in D1. Deploying the Worker applies the namespace declaration. Direct STAGING_API_KEY requests cannot use write routes.

### Connect the local or Preview POS to D1

The normal Express API remains on PostgreSQL unless both switches below are set. Add them to the local .env or Vercel Preview environment only after the new Worker version is deployed:

~~~text
D1_STAGING_POS_ENABLED=true
D1_STAGING_POS_BUSINESS_IDS=1,18
~~~

To route the public registration form to D1 in local development or Vercel Preview, also set `PUBLIC_BUSINESS_REGISTRATION_ENABLED=true` and `D1_STAGING_REGISTRATION_ENABLED=true`. New signups write only to D1 and receive a one-time registration key; the Express server generates and returns the raw key while D1 stores only its hash. Apply `migrations/0003_d1_onboarded_businesses.sql` before enabling this route. Keep these settings out of Vercel Production until the D1 pilot is approved for production.

The Express server resolves D1-registered devices and sessions through signed public lookup routes, then sends sign-in, license/device checks, and authorized POS requests to the Worker for enabled D1 businesses. For the imported pilot, that remains businesses 1 and 18; newly onboarded D1 businesses are recognized through the D1 marker table after device/session lookup. POS reads and writes, QR menu reads/subscriptions/tracking/order submission, reports, image references, and support/auth flows use D1 routes where ported. Protected API modules that are not ported return 501 rather than silently falling back to PostgreSQL.

New orders with checkout are saved as Open in D1, then settled through the D1 payment route. If settlement fails, the saved open order remains available to recover from the Orders screen. Open-order item edits recalculate the bill from current D1 menu prices and taxes; an edit cannot reduce the bill below payments already collected. Public QR order submission is connected and controlled by the Worker write gate. New D1-onboarded businesses are enabled dynamically while the imported-business allowlist stays at 1 and 18.

Leave D1_STAGING_POS_ENABLED unset or false in Vercel Production. The Vercel production app stays on Supabase until the local/Preview flows and staging recovery checks are finished. This pilot is not dual-write and does not switch customer traffic by itself. The staging Worker deployment succeeded with the D1, Durable Object, and R2 bindings. The POS screens still need live local/Preview verification before any production cutover. Do not add the staging switch to Production.

Staff password login is not part of this staging Worker. The existing POS hashes passwords with Node `scrypt`; Cloudflare's [Free Workers CPU limit](https://developers.cloudflare.com/workers/platform/limits/) is 10 ms per request, so sign-in needs a measured compatibility path before moving it. Keep staff authentication on the existing POS until that is addressed. Public QR order writes must pass staging validation before the D1 write gate is enabled; staff access administration and the remaining protected management APIs must be ported before production cutover.

### POS backend bridge configuration

The Express staging routes run behind the existing session, device, license, and permission checks. They take the business ID from the authenticated account and never accept a browser-provided business ID. The server signs a short-lived token with the bridge secret, and the Worker checks the signature, expiry, scope, and business allowlist before reading or writing D1.

Set these variables only in the local .env for local inspection or in the Vercel Preview environment for a staging deployment. Do not add the bridge secret or the POS switch to Production:

~~~text
D1_STAGING_WORKER_URL=https://slash-pos-full-d1-staging.anshulkashyap6464.workers.dev
D1_STAGING_BRIDGE_SECRET=<copy the private value from %APPDATA%\CafePOS\CloudflareStaging\d1-staging-bridge-secret.txt>
~~~

The same bridge secret must be configured on the Worker with `npx wrangler secret put D1_STAGING_BRIDGE_SECRET`. This Worker secret is separate from `STAGING_API_KEY`.
