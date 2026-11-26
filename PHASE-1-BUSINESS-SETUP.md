# Cafe POS Phase 1 - Multi-Business Foundation

Implemented:
- businesses table and business profile fields
- existing users backfilled to the first business
- app_users.business_id
- new cafe/business registration screen
- owner account created automatically with Admin profile
- login session now carries business profile information
- frontend API changed from localhost URL to relative `/api`
- server port now uses `PORT` environment variable
- Express serves the frontend from the same server

Registration flow:
1. Open Cafe POS
2. Click "Create a new cafe business"
3. Enter business + owner details
4. Create account
5. Log in with the newly created owner username/password

Important:
This phase establishes business identity and account ownership. Existing data is preserved and assigned to the first/default business. Full row-level business isolation across every module is Phase 2.

## Phase 1.1 registration hardening
- Registration now backfills missing `businesses` columns on older databases.
- Existing `app_users` rows are automatically linked to the default business when `business_id` is missing.
- The Admin access profile is created defensively if an older database does not contain it.
- Local development registration returns the actual database error message instead of a generic 500.
