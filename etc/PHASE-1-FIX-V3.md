# Phase 1 Fix V3

This build fixes legacy `businesses` schema compatibility.

- Ensures `business_code` exists, backfills it, and enforces NOT NULL + unique index.
- Ensures legacy `password_hash` is nullable because authentication belongs to `app_users`.
- Relaxes unexpected legacy NOT NULL columns on `businesses` so they cannot block registration.
- Registration runs the business-table compatibility migration defensively before inserting.

Run with `node server.js` and open `http://localhost:3000`.
