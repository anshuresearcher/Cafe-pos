# Slash POS image storage setup

## How this project authorizes uploads

Slash POS uses its own café-scoped session cookie and permission checks. It does not use Supabase Auth for POS users, so `auth.uid()` and a Storage folder name cannot reliably identify a logged-in POS café. The web app sends image bytes to the existing POS server. The server derives the café from the verified session, checks `menu.edit` for item/category images or `settings.edit` for a logo, confirms item/category ownership in PostgreSQL, and then calls Storage with a server-only Supabase secret key. Clients cannot choose a café ID, bucket, or object path.

All three buckets are public-read so unauthenticated QR menu visitors can load an image when they have its URL. Public bucket delivery already handles reads, so the migration adds no object-listing SELECT policy. Browser `anon` and `authenticated` roles are explicitly prevented from uploading, replacing, or deleting objects. Those operations go through the tenant-checked POS server.

## Supabase setup

1. Open the correct Supabase project and go to **SQL Editor**.
2. Run the complete migration in [`sql/003_supabase_image_storage.sql`](sql/003_supabase_image_storage.sql) as a project owner.
3. In **Storage → Buckets**, confirm these buckets exist and are public:
   - `cafe-menu-items`
   - `cafe-category-images`
   - `cafe-logos`
4. Confirm each bucket has a **2 MB** file limit and accepts only `image/jpeg`, `image/png`, and `image/webp`. The SQL migration applies these values; no separate bucket creation is required.
5. Add these **server environment variables** to the local backend and the deployed backend hosting the POS API:

   ```text
   SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
   SUPABASE_SECRET_KEY=YOUR_SUPABASE_SECRET_KEY
   ```

   Use the project's **secret key** (`sb_secret_…`) from Supabase API settings. Legacy `service_role` JWT keys are also accepted through `SUPABASE_SERVICE_ROLE_KEY`. Keep either key only in server environment settings or the private local `.env`; never place it in `public/`, a browser build, a `NEXT_PUBLIC_*` variable, or a checked-in file. Restart/redeploy the backend after setting it. Do not rotate or replace the database connection settings for this feature. The backend sends new secret keys only in the `apikey` header; it uses a bearer header only for legacy JWT keys.

There is no Supabase Storage SDK or new frontend credential. If the two variables are missing, image saves show a clear configuration error and existing images continue displaying.

## What changes in the POS

- Item photos are resized to at most 800×800 pixels; category photos to 800×800 and café logos to 500×500. WebP is used when supported. Items target 100–250 KB and have a 2 MB hard limit. Category photos and logos retain the POS 200 KB maximum.
- The optimized file is uploaded first. PostgreSQL is updated with its public Storage URL only after Storage confirms the upload. Failed uploads leave the current image reference intact.
- Replacements use unique object names, so the existing file remains available until the new URL is saved. Old managed objects are removed only when no known item, category, logo, settings, or receipt snapshot still references that URL.
- Removing an image clears its reference and then performs the same reference check before deleting the object.
- Existing data-URL images and external image URLs remain readable. They are not migrated or deleted automatically; re-upload an existing image from its editor to move it to Storage.
- Public QR menu images already use lazy loading; missing images continue to use the existing visual fallback.

## Two-café isolation check

Use two test cafés and accounts with the appropriate menu/settings edit permissions.

1. Sign in to Café A and upload one item image, one category image, and its logo. Confirm each POS preview and public QR menu image loads. The generated object paths begin with Café A's numeric business ID.
2. Copy a public image URL and open it in a private/incognito browser window without signing in. The image should load.
3. Sign in to Café B. Upload an image and confirm its path begins with Café B's own business ID.
4. While signed in as Café B, try the authenticated POS request `DELETE /api/image-storage/item/{Café-A-item-id}` (or category equivalent). It must return **404** and leave Café A's image unchanged. A user lacking `menu.edit`/`settings.edit` must receive **403**.
5. From a browser/anon key, try Storage API upload, update, and delete requests for one of these buckets. They must be denied by Storage RLS. Do not use the service-role key in this browser check.
6. Replace Café A's test image. Confirm the new image loads and the old Storage object is removed only if no record references it. Clear it and confirm it disappears from the item/category/logo record.

Run these checks on a staging/test Supabase project before using production data.

## Usage monitoring

Use the Supabase project **Usage** page for project-wide Storage size and bandwidth. This change does not add per-café bandwidth analytics to the POS; public image delivery is served by Supabase/CDN, so the POS server cannot accurately count guest downloads.