# Phase 2: copy pilot menu images to R2

This phase copies only menu-item and category images in the phase-one D1 seed for the selected businesses. It uploads them to a dedicated R2 bucket and verifies each copy by reading it back and comparing SHA-256 checksums.

It does not update D1 image URLs, Supabase records, POS routes, or the public website. Supabase remains the live source for customers.

## Enable R2 in Cloudflare

Wrangler returned Cloudflare error 10042 because R2 is not enabled for the current account. In the Cloudflare Dashboard, open Storage & databases > R2 > Overview and complete the R2 subscription checkout first. Cloudflare currently includes free monthly usage, but R2 usage is billed monthly after the included amounts. See the [R2 getting-started guide](https://developers.cloudflare.com/r2/get-started/).

## Create or select the R2 bucket

In Cloudflare, open R2 and create a dedicated bucket named slash-pos-assets-pilot. Or run this from the phase-2 folder:

    npx wrangler r2 bucket create slash-pos-assets-pilot

If that name already exists in your account, reuse it only if it is the pilot bucket. Otherwise choose another bucket and pass it with --bucket.

## Review the plan

From the phase-2 folder, run:

    node .\scripts\migrate-images-to-r2.js --input "..\..\phase-1-menu-pilot\generated\menu-pilot-data.sql" --business-id 1 --business-id 18 --bucket slash-pos-assets-pilot

This is a dry run. It reads image URLs from the selected seed, accepts only public Supabase URLs in the cafe-menu-items and cafe-category-images buckets, and requires the object path to start with business 1 or 18. The generated manifest contains public source URLs; do not commit or share it publicly.

Review phase-1-menu-pilot\generated\r2-image-manifest.json and the printed counts.

## Copy and verify

After reviewing the plan and confirming Wrangler is logged into the intended Cloudflare account, run:

    node .\scripts\migrate-images-to-r2.js --input "..\..\phase-1-menu-pilot\generated\menu-pilot-data.sql" --business-id 1 --business-id 18 --bucket slash-pos-assets-pilot --execute

The script asks you to type COPY before it starts. It processes up to four images at a time: downloads them from Supabase, uploads them through Wrangler, reads the R2 copies back, and compares SHA-256 checksums. Each image is limited to 10 MB. It needs no Supabase service key or R2 API secret.

The one-time image downloads count toward Supabase egress. No polling or background activity is added.

## After verification

Confirm phase-1-menu-pilot\generated\r2-copy-report.json shows every image as verified. The R2 bucket stays private by default and these copies are not used by the POS or QR menu yet. Next, configure and test a private Worker image-read route before changing any image URL. Do not delete the Supabase originals.
## Test the private Worker image route

The isolated menu pilot Worker now has the R2 binding and a GET-only image route. It requires the existing PILOT_ACCESS_KEY bearer secret, restricts business IDs to the pilot allowlist, and only serves menu/category image paths with the matching business prefix. It sends private, no-store responses. The POS and D1 image URLs remain unchanged.

Use PowerShell locally, replacing the placeholder with your existing key. Do not paste the key into chat:

    $headers = @{ Authorization = "Bearer YOUR_EXISTING_PILOT_ACCESS_KEY" }
    Invoke-WebRequest -Uri "https://slash-pos-menu-pilot.anshulkashyap6464.workers.dev/v1/image?business_id=18&bucket=cafe-category-images&path=18%2F54%2Ff1294694-0771-42dc-8077-dad9d0d2d541.webp" -Headers $headers -OutFile "$env:TEMP\r2-category-test.webp"

A successful response saves one test image locally. Requests without the key should return HTTP 401. This endpoint is for pilot verification; it is not connected to the customer QR menu.
