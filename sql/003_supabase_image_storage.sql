-- Slash POS public image buckets.
-- Run this migration in the Supabase SQL Editor as the project owner.
-- The application authenticates users with its own café-scoped sessions, not Supabase Auth.
-- Public reads are provided by bucket settings; browser writes are denied, while authenticated image management goes through
-- the POS server, which validates the user's menu/settings permission and business_id.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
    ('cafe-menu-items', 'cafe-menu-items', TRUE, 2097152, ARRAY['image/jpeg','image/png','image/webp']::text[]),
    ('cafe-category-images', 'cafe-category-images', TRUE, 2097152, ARRAY['image/jpeg','image/png','image/webp']::text[]),
    ('cafe-logos', 'cafe-logos', TRUE, 2097152, ARRAY['image/jpeg','image/png','image/webp']::text[])
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    public = TRUE,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Public buckets serve known object URLs without login; do not add SELECT policies that allow listing.
-- Remove the earlier permissive policy name if this migration is re-applied.
DROP POLICY IF EXISTS slash_cafe_images_public_read ON storage.objects;
-- Restrictive policies prevent any existing broad permissive Storage policy from
-- granting browser uploads, replacements, or deletions in these image buckets.
DROP POLICY IF EXISTS slash_cafe_images_block_browser_insert ON storage.objects;
CREATE POLICY slash_cafe_images_block_browser_insert
    ON storage.objects AS RESTRICTIVE FOR INSERT TO anon, authenticated
    WITH CHECK (bucket_id NOT IN ('cafe-menu-items','cafe-category-images','cafe-logos'));

DROP POLICY IF EXISTS slash_cafe_images_block_browser_update ON storage.objects;
CREATE POLICY slash_cafe_images_block_browser_update
    ON storage.objects AS RESTRICTIVE FOR UPDATE TO anon, authenticated
    USING (bucket_id NOT IN ('cafe-menu-items','cafe-category-images','cafe-logos'))
    WITH CHECK (bucket_id NOT IN ('cafe-menu-items','cafe-category-images','cafe-logos'));

DROP POLICY IF EXISTS slash_cafe_images_block_browser_delete ON storage.objects;
CREATE POLICY slash_cafe_images_block_browser_delete
    ON storage.objects AS RESTRICTIVE FOR DELETE TO anon, authenticated
    USING (bucket_id NOT IN ('cafe-menu-items','cafe-category-images','cafe-logos'));