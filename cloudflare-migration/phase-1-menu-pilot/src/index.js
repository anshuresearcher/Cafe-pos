const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, max)
    : fallback;
}

async function secretMatches(supplied, expected) {
  const encoder = new TextEncoder();
  const [suppliedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const a = new Uint8Array(suppliedHash);
  const b = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function requirePilotAccess(request, env) {
  const expected = String(env.PILOT_ACCESS_KEY || "");
  const authorization = request.headers.get("authorization") || "";
  const supplied = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  if (!expected || !supplied || !(await secretMatches(supplied, expected))) {
    return json({ error: "Unauthorized" }, 401);
  }
  return null;
}

function getAllowedBusinessIds(env) {
  const rawIds = String(env.PILOT_BUSINESS_IDS || "").split(",").map(value => value.trim()).filter(Boolean);
  const ids = rawIds.map(Number);
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("PILOT_BUSINESS_IDS is not configured with valid IDs.");
  }
  return new Set(ids);
}

function selectBusinessId(url, env) {
  const allowedIds = getAllowedBusinessIds(env);
  const value = url.searchParams.get("business_id");
  if (!value) {
    return { response: json({ error: "Choose business_id=1 or business_id=18 for this pilot." }, 400) };
  }
  const businessId = Number(value);
  if (!Number.isSafeInteger(businessId) || !allowedIds.has(businessId)) {
    return { response: json({ error: "That business ID is not enabled in this pilot." }, 403) };
  }
  return { businessId };
}

const PILOT_IMAGE_BUCKETS = new Set(["cafe-menu-items", "cafe-category-images"]);
const PILOT_IMAGE_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp"
};

async function getPilotImage(url, env) {
  const selection = selectBusinessId(url, env);
  if (selection.response) return selection.response;

  const bucket = url.searchParams.get("bucket") || "";
  const objectPath = url.searchParams.get("path") || "";
  if (!PILOT_IMAGE_BUCKETS.has(bucket)) {
    return json({ error: "That image bucket is not enabled in this pilot." }, 400);
  }

  const parts = objectPath.split("/");
  if (
    parts.length !== 3 ||
    parts[0] !== String(selection.businessId) ||
    !/^\d+$/.test(parts[1]) ||
    parts.some(part => !part || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part))
  ) {
    return json({ error: "Choose a valid image path for the selected business." }, 400);
  }

  const extension = parts[2].split(".").pop().toLowerCase();
  const contentType = PILOT_IMAGE_TYPES[extension];
  if (!contentType) return json({ error: "That image format is not enabled in this pilot." }, 415);

  const key = "pilot/business-" + selection.businessId + "/" + bucket + "/" + objectPath;
  const object = await env.IMAGES.get(key);
  if (!object) return json({ error: "Image not found in the R2 pilot." }, 404);

  const headers = new Headers({
    "content-type": contentType,
    "content-length": String(object.size),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff"
  });
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}
function parseJsonColumns(row, columns) {
  const result = { ...row };
  for (const column of columns) {
    if (typeof result[column] !== "string") continue;
    try {
      result[column] = JSON.parse(result[column]);
    } catch {
      // Keep invalid legacy JSON visible for comparison rather than failing the endpoint.
    }
  }
  return result;
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET") {
      return json({ error: "Only GET is supported by this read-only pilot." }, 405);
    }

    const denied = await requirePilotAccess(request, env);
    if (denied) return denied;

    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") {
        await env.DB.prepare("SELECT 1 AS ok").first();
        return json({ ok: true, mode: "read-only D1 pilot" });
      }

      if (url.pathname === "/v1/image") return await getPilotImage(url, env);

      const variantsMatch = url.pathname.match(/^\/v1\/menu\/(\d+)\/variants$/);
      if (url.pathname !== "/v1/menu" && !variantsMatch) {
        return json({ error: "Not found" }, 404);
      }

      const selection = selectBusinessId(url, env);
      if (selection.response) return selection.response;
      const businessId = selection.businessId;
      const limit = parsePositiveInt(url.searchParams.get("limit"), 100, 200);

      if (url.pathname === "/v1/menu") {
        const afterId = Math.max(
          0,
          Number.parseInt(url.searchParams.get("after_id") || "0", 10) || 0
        );

        const categoryResult = await env.DB.prepare(
          "SELECT id, name, icon, active, sort_order, image_url " +
          "FROM menu_categories WHERE business_id = ? AND active = 1 " +
          "ORDER BY sort_order, name LIMIT 200"
        ).bind(businessId).all();

        const itemResult = await env.DB.prepare(
          "SELECT id, name, price, category, available, nature, unit, " +
          "tax_rate, cgst_rate, sgst_rate, igst_rate, tax_mode, tax_label, " +
          "channel_prices, category_id, image_url, option_set_ids, qr_available, " +
          "sku, description, sales_channels, tags, is_open_item " +
          "FROM menu WHERE business_id = ? AND available = 1 AND id > ? " +
          "ORDER BY id LIMIT ?"
        ).bind(businessId, afterId, limit + 1).all();

        const rows = itemResult.results || [];
        const hasMore = rows.length > limit;
        const items = rows.slice(0, limit).map(row =>
          parseJsonColumns(row, ["channel_prices", "option_set_ids", "sales_channels", "tags"])
        );

        return json({
          businessId,
          categories: categoryResult.results || [],
          items,
          nextAfterId: hasMore ? items[items.length - 1].id : null
        });
      }

      const menuId = Number(variantsMatch[1]);
      const afterId = Math.max(
        0,
        Number.parseInt(url.searchParams.get("after_id") || "0", 10) || 0
      );
      const result = await env.DB.prepare(
        "SELECT id, menu_id, name, sku, price, unit, channel_prices, available, " +
        "created_at, updated_at, option_set_ids " +
        "FROM menu_variants " +
        "WHERE business_id = ? AND menu_id = ? AND available = 1 AND id > ? " +
        "ORDER BY id LIMIT ?"
      ).bind(businessId, menuId, afterId, limit + 1).all();

      const rows = result.results || [];
      const hasMore = rows.length > limit;
      const variants = rows.slice(0, limit).map(row =>
        parseJsonColumns(row, ["channel_prices", "option_set_ids"])
      );
      return json({
        businessId,
        menuId,
        variants,
        nextAfterId: hasMore ? variants[variants.length - 1].id : null
      });
    } catch {
      return json({ error: "The D1/R2 pilot request failed. Check the pilot configuration, schema, and R2 binding." }, 503);
    }
  }
};
