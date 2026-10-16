# Phase 2A — Multi-Cafe Core Data Isolation

This update adds a business tenant context and PostgreSQL row-level security for core operational tables.

## Core tables covered
menu_categories, menu, menu_variants, restaurant_tables, orders, order_items, reservations, kot_groups, kot, payments, customers, invoices, loyalty_transactions, billing_adjustments, expense_categories, expenses

## What it does
- Adds `business_id` to the core tenant tables and backfills existing rows to the first/default business.
- Adds tenant-scoped defaults for new inserts.
- Enables and forces PostgreSQL RLS on those tables.
- Applies the authenticated user's `business_id` to every database connection used by the request.
- Makes KOT groups, expense categories, and billing adjustment names unique per business.
- Seeds default KOT/expense categories for a newly registered business.
- Keeps existing frontend/static deployment fixes (`public/` and `/public/index.html`).

## Important
Phase 2A covers core operational data. Settings, loyalty settings, access profiles, and app users are intentionally left for Phase 2B/2C. Do not onboard a second real cafe until those remaining configuration/auth tables are tenant-scoped too.
