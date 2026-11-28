# Cloudflare migration work

This folder contains isolated Cloudflare migration stages. None of them change the running POS app; Supabase remains the production source of truth.

## Migration approach

1. **Keep Supabase live.** The existing Vercel Express app continues using its PostgreSQL pool and Supabase Storage.
2. **Pilot the menu catalog in D1.** Export only `public.menu`, `public.menu_categories`, and `public.menu_variants` from the supplied PostgreSQL backup. Serve them from a private, read-only Cloudflare Worker for selected test cafés 1 and 18; each request selects one allowlisted business.
3. **Compare before expanding.** Check item/category/variant counts and representative values against Supabase. Repeat with a fresh backup before treating the pilot as current data.
4. **Copy object storage separately.** A verified copy of the selected menu/category images exists in the R2 pilot bucket and can be served by the authenticated pilot route. Production menu URLs have not been rewritten and still use Supabase Storage.
5. **Port business workflows only after the read pilot passes.** Orders, payments, invoices, KOT, QR sessions, reports, and permissions need a route-by-route SQLite/Worker design and tenant-isolation review. PostgreSQL row-level security does not transfer to D1.
6. **Cut over last.** Supabase remains the source of truth until writes can be reconciled, business workflows pass staging tests, and a rollback path is ready. This pilot does not dual-write or route customer traffic.

## Current hosting and portability

The inspected app is a Vercel serverless Express function using `pg` and PostgreSQL-specific SQL. D1 is accessed through a Cloudflare Worker binding; it is not a PostgreSQL connection string that can be placed in the current Vercel `DATABASE_URL`. The pilot Worker runs separately and is deliberately not wired into POS screens.

The app uses its own café-scoped login/session system, not Supabase Auth. If POS APIs later move to Workers, their authentication and business-level authorization must be ported and tested explicitly.

## Backup and privacy

The supplied file is a plain-text PostgreSQL dump containing Supabase-managed schemas as well as POS data. D1 cannot import that dump directly. The phase-one converter reads only the three menu COPY sections and does not export customers, orders, payment data, support sessions, Supabase Auth/Storage internals, or other tables.

Generated SQL goes in the ignored `phase-1-menu-pilot/generated/` directory. Do not remove that ignore rule or commit the generated file. It contains menu catalog rows and Supabase image URLs for the selected cafés only.

## Phase one

See [phase-1-menu-pilot/README.md](phase-1-menu-pilot/README.md) for setup, import, and read-only endpoint instructions.

## Phase three: full database snapshot

The full public POS schema and backup rows have been imported into the separate APAC D1 database `cafe-pos-full-dev`. See [phase-3-full-d1/README.md](phase-3-full-d1/README.md) for scope, schema/data checks, and limits. It contains a point-in-time snapshot; the production app is not connected to it.
