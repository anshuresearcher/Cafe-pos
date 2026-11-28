# Phase 1: read-only menu pilot on Cloudflare D1

## What this pilot does

- Creates an isolated D1 database schema for menu items, categories, and variants.
- Converts only those three public table data sections from the plain-text PostgreSQL backup.
- Runs a separate Cloudflare Worker that allows authenticated **GET-only** reads for business IDs 1 and 18, with explicit selection on each request.
- Keeps the existing Vercel POS, Supabase PostgreSQL, and Supabase Storage unchanged.

It does not write menu changes back, update billing, route production requests, or copy images to R2. Supabase remains authoritative.

## Requirements

- A Cloudflare account with Workers and D1 access, and Wrangler installed or available through `npx`.
- Node.js 22+ to convert the supplied SQL backup (already required by the POS project).
- Business IDs 1 and 18 are allowlisted for the test pilot.

## Create the isolated D1 database

Run these commands from this folder. If this computer is not signed into Cloudflare yet, start with `npx wrangler login`:

```powershell
npx wrangler d1 create slash-pos-menu-pilot --location apac
```

Wrangler prints a database ID. Put it in `wrangler.jsonc` by replacing `REPLACE_AFTER_WRANGLER_D1_CREATE`. This pilot is configured for business IDs 1 and 18; each read must select one with a `business_id` query parameter. Do not use a real customer-facing POS route for this pilot.

Create the schema in the new remote D1 database:

```powershell
npx wrangler d1 execute slash-pos-menu-pilot --remote --file=./schema.sql
```

## Convert and import only the menu catalog

The converter needs a plain-text PostgreSQL dump. It does not connect to Supabase, Cloudflare, or the internet.

```powershell
node .\scripts\pgdump-menu-to-d1.js --input "C:\Users\anshu\OneDrive\Desktop\cafepos_migration\cafe_pos_backup.sql" --output .\generated\menu-pilot-data.sql --business-id 1 --business-id 18
```

Review the printed table counts for business_id=1 and business_id=18. The output file is ignored by Git. Import it into the isolated D1 database:

```powershell
npx wrangler d1 execute slash-pos-menu-pilot --remote --file=.\generated\menu-pilot-data.sql
```

For a fresh snapshot, generate a new output file and import it again. The inserts replace rows with matching IDs, but this does not remove rows deleted from the source since the previous snapshot. Use a newly created test database for a clean comparison; do not run cleanup commands against production.

## Lock and deploy the pilot Worker

Set a strong private access key when prompted. Wrangler stores it as a Worker secret, not in source files:

```powershell
npx wrangler secret put PILOT_ACCESS_KEY
npx wrangler deploy
```

The Worker is read-only and requires the bearer key on every route. Only business IDs 1 and 18 are allowlisted in configuration, and each menu request must explicitly select one. Other business IDs receive 403; missing selection receives 400.

Example checks (replace the URL and key locally):

```powershell
curl.exe -H "Authorization: Bearer YOUR_PRIVATE_KEY" https://YOUR-WORKER-URL/health
curl.exe -H "Authorization: Bearer YOUR_PRIVATE_KEY" "https://YOUR-WORKER-URL/v1/menu?business_id=18&limit=100"
curl.exe -H "Authorization: Bearer YOUR_PRIVATE_KEY" "https://YOUR-WORKER-URL/v1/menu/ITEM_ID/variants?business_id=18&limit=100"
```

The menu endpoint is paginated (maximum 200 items per request). Categories are capped at 200. Variants are fetched by menu item ID and are paginated too. Responses are marked `no-store`.

## What to compare before expanding

1. Compare D1 item, category, and variant counts for the selected business with Supabase.
2. Compare sample item IDs, names, prices, availability, tax fields, sales-channel prices, category links, and variants.
3. Check menu/category images still load from their Supabase URLs.
4. Confirm requests without the secret return 401, and that POST/PUT/DELETE return 405.
5. Repeat using a fresh source backup and record how long the export and import take.

This first check validates the D1 schema and read path. It does not prove that orders, payment settlement, KOT printing, QR sessions, or the desktop app are ready to move.

## Expected extra activity and limits

- No extra requests are added to the live POS. The pilot runs only when you directly call the Worker.
- The supplied snapshot exports 442 rows total for the two businesses (49 categories, 299 menu items, and 94 variants); each manual read queries only the requested page.
- No monitoring/dashboard polling is added.
- The menu images remain in Supabase Storage, so this phase adds no image copy or R2 traffic.
- The export is a point-in-time snapshot. There is no automatic replication or dual-write; refresh it intentionally when you need a newer comparison.

## Before any production cutover

The current POS cannot point its PostgreSQL pool at D1. The production API would need a Cloudflare Worker/SQLite port or a deliberately designed API bridge. Tenant isolation must be implemented explicitly because the current PostgreSQL RLS policies are not present in D1. Build and test those features against staging before moving any write traffic. Keep Supabase available through validation and prepare a route-level rollback before cutover.
