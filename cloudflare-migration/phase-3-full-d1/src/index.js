// The variants query binds one business ID plus one ID per menu item. D1
// permits at most 100 bound parameters per query, so cap pages at 99 items.
import { cancelOrder, createOpenOrder, markOrderPrinted, updateOpenOrder } from "./orders.js";
import { settleOrder } from "./settlement.js";
import { buildKotStatements, createKotForOrder } from "./kot.js";
import { handleDashboardStats, handleReports } from "./reports.js";
import { handleInvoices } from "./invoices.js";
import { handleKotTickets, updateKotItem } from "./kot_history.js";
import { createPublicQrOrder } from "./public_qr_orders.js";
import { AUTH_SERVICE_SCOPES, accessPathScope, authPathScope, handleAuthService, handlePublicD1Auth, handleD1Access, deviceAdminPathScope, handleD1DeviceAdmin } from "./access_auth.js";

const MAX_PAGE_SIZE = 99;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function constantTimeEqual(left, right) {
  const encoder = new TextEncoder();
  const a = encoder.encode(String(left || ""));
  const b = encoder.encode(String(right || ""));
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    mismatch |= (a[i % (a.length || 1)] || 0) ^ (b[i % (b.length || 1)] || 0);
  }
  return mismatch === 0;
}

function allowedBusinesses(env) {
  return new Set(
    String(env.STAGING_BUSINESS_IDS || "")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  );
}

async function isBusinessEnabled(env, businessId, configured = allowedBusinesses(env)) {
  const id = Number(businessId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  if (configured.has(id)) return true;
  try {
    const row = await env.DB.prepare(`SELECT 1 AS enabled FROM d1_onboarded_businesses o
      JOIN businesses b ON b.id = o.business_id AND b.active = 1 WHERE o.business_id = ? LIMIT 1`).bind(id).first();
    return Boolean(row?.enabled);
  } catch {
    return false;
  }
}

async function requestedBusinessId(url, env) {
  const value = Number(url.searchParams.get("business_id"));
  if (!Number.isSafeInteger(value) || value <= 0) return { error: "A valid business_id is required" };
  if (!(await isBusinessEnabled(env, value))) return { error: "This business is not enabled for D1 staging", status: 403 };
  return { value };
}

function pageParams(url) {
  const requestedLimit = Number(url.searchParams.get("limit") || 100);
  const requestedOffset = Number(url.searchParams.get("offset") || 0);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) return { error: "limit must be a positive integer" };
  if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0) return { error: "offset must be a non-negative integer" };
  return { limit: Math.min(requestedLimit, MAX_PAGE_SIZE), offset: requestedOffset };
}

function parseJsonField(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeMenuItem(row) {
  return {
    ...row,
    available: Boolean(row.available),
    qr_available: Boolean(row.qr_available),
    is_open_item: Boolean(row.is_open_item),
    channel_prices: parseJsonField(row.channel_prices, {}),
    option_set_ids: parseJsonField(row.option_set_ids, []),
    sales_channels: parseJsonField(row.sales_channels, null),
    tags: parseJsonField(row.tags, []),
    variants: (row.variants || []).map((variant) => ({
      ...variant,
      available: Boolean(variant.available),
      channel_prices: parseJsonField(variant.channel_prices, {}),
      option_set_ids: parseJsonField(variant.option_set_ids, []),
    })),
  };
}

function pagedJson(rows, page, normalize = (row) => row) {
  const hasMore = rows.length > page.limit;
  return json({
    items: rows.slice(0, page.limit).map(normalize),
    limit: page.limit,
    offset: page.offset,
    hasMore,
    nextOffset: hasMore ? page.offset + page.limit : null,
  });
}

function normalizeOrderChild(row) {
  if (Object.prototype.hasOwnProperty.call(row, "options")) {
    return { ...row, options: parseJsonField(row.options, []) };
  }
  return row;
}

function stagingKeyIsValid(request, env) {
  const expected = String(env.STAGING_API_KEY || "");
  const supplied = String(request.headers.get("X-Staging-Key") || "");
  return expected.length >= 32 && supplied.length > 0 && constantTimeEqual(expected, supplied);
}

function decodeBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeBase64UrlJson(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

async function verifyBridgeToken(request, env) {
  const secret = String(env.D1_STAGING_BRIDGE_SECRET || "");
  const token = String(request.headers.get("X-D1-Bridge-Token") || "");
  if (secret.length < 32 || token.length > 4096) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const header = decodeBase64UrlJson(parts[0]);
    const claims = decodeBase64UrlJson(parts[1]);
    if (header.alg !== "HS256" || header.typ !== "JWT") return null;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signatureValid = await crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64Url(parts[2]),
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!signatureValid) return null;

    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== "slash-pos-api" || claims.aud !== "slash-pos-d1-staging") return null;
    const isAuthService = claims.sub === 0 && AUTH_SERVICE_SCOPES.has(String(claims.scope || ""));
    const isPublicAuthService = isAuthService && String(claims.scope || "").startsWith("auth.public.");
    if (!Number.isSafeInteger(claims.sub) || (claims.sub <= 0 && !isAuthService)) return null;
    if (!Number.isSafeInteger(claims.business_id) || (claims.business_id <= 0 && !(isPublicAuthService && claims.business_id === 0))) return null;
    if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) return null;
    if (claims.iat > now + 10 || claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 120) return null;
    if (typeof claims.scope !== "string") return null;
    return claims;
  } catch {
    return null;
  }
}

async function coordinatedWrite(request, env, businessId, bridgeClaims, operation, orderId = null) {
  if (!env.ORDER_COORDINATOR) return json({ error: "D1 order coordination is not configured" }, 503);
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 65536) return json({ error: "Order request is too large" }, 413);
    body = JSON.parse(raw || "{}");
  } catch {
    return json({ error: "Invalid order request JSON" }, 400);
  }
  const id = env.ORDER_COORDINATOR.idFromName("business:" + String(businessId));
  const stub = env.ORDER_COORDINATOR.get(id);
  return stub.fetch(new Request("https://order-coordinator.internal/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operation,
      businessId,
      orderId,
      claims: {
        sub: Number(bridgeClaims?.sub),
        business_id: Number(bridgeClaims?.business_id),
        scope: String(bridgeClaims?.scope || ""),
      },
      body,
    }),
  }));
}

async function updateQrOrderStatus(env, businessId, claims, orderId, body) {
  const nextStatus = String(body?.status || "").trim();
  if (!["Preparing", "Ready"].includes(nextStatus)) return { status: 400, error: "Choose Accept or Mark Ready." };
  const order = await env.DB.prepare(
    "SELECT id, order_number, public_tracking_token, status, sales_channel_key, order_type, updated_at FROM orders WHERE id = ? AND business_id = ? LIMIT 1"
  ).bind(orderId, businessId).first();
  if (!order) return { status: 404, error: "Order not found." };
  if (!order.public_tracking_token && !/^QR-/i.test(String(order.order_number || ""))) return { status: 409, error: "This workflow is only available for QR orders." };
  const settingsRow = await env.DB.prepare("SELECT settings FROM app_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
  const settings = parseJsonField(settingsRow?.settings, {});
  const saleChannel = normalizePosChannels(settings).find((entry) => entry.key === String(order.sales_channel_key || "").toLowerCase());
  const kotPrintMode = saleChannel?.qrMenu ? saleChannel.kotPrintMode : "never";
  const currentStatus = String(order.status || "").trim().toLowerCase();
  const targetStatus = nextStatus.toLowerCase();
  if (currentStatus === targetStatus) return { status: 200, success: true, orderStatus: nextStatus, kotPrintMode };
  const validNext = currentStatus === "pending" ? "preparing" : currentStatus === "preparing" ? "ready" : null;
  if (validNext !== targetStatus) return { status: 409, error: currentStatus === "ready" ? "This QR order is already ready for checkout." : "QR orders must be accepted before they can be marked ready." };

  const statements = [];
  if (currentStatus === "pending" && nextStatus === "Preparing" && settings.kotEnabled !== false) {
    const kotStatements = await buildKotStatements(env, businessId, { orderId }, { queueDevicePrint: kotPrintMode === "accepted", updatedAt: order.updated_at });
    statements.push(...kotStatements.statements);
  }
  statements.push(env.DB.prepare(
    "UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ? AND lower(coalesce(status, '')) = ?"
  ).bind(nextStatus, orderId, businessId, currentStatus));
  statements.push(env.DB.prepare(
    "UPDATE kot SET status = ?, prep_started_at = CASE WHEN ? = 'Preparing' THEN COALESCE(prep_started_at, CURRENT_TIMESTAMP) ELSE prep_started_at END, " +
    "prep_completed_at = CASE WHEN ? IN ('Ready', 'Completed') THEN COALESCE(prep_completed_at, CURRENT_TIMESTAMP) ELSE prep_completed_at END " +
    "WHERE order_id = ? AND business_id = ? AND status IN ('Pending', 'Preparing')"
  ).bind(nextStatus === "Preparing" ? "Preparing" : "Ready", nextStatus, nextStatus, orderId, businessId));
  statements.push(env.DB.prepare(
    "INSERT INTO order_activity (order_id, event_type, description, actor, business_id, actor_user_id) VALUES (?, ?, ?, 'POS', ?, ?)"
  ).bind(orderId, nextStatus === "Preparing" ? "QR order accepted" : "QR order marked ready",
    nextStatus === "Preparing" ? "QR order accepted and sent to preparation." : "QR order marked ready for checkout.", businessId, Number(claims?.sub) || null));
  await env.DB.batch(statements);
  return { status: 200, success: true, orderStatus: nextStatus, kotPrintMode };
}

async function completeOrder(env, businessId, orderId, claims) {
  const order = await env.DB.prepare(
    "SELECT id, order_number, order_type, table_number, total, status, payment_method, non_chargeable_reason FROM orders WHERE id = ? AND business_id = ? LIMIT 1"
  ).bind(orderId, businessId).first();
  if (!order) return { status: 404, error: "Order not found" };
  if (String(order.status || "").toLowerCase() === "completed") return { status: 200, success: true, order };
  if (["cancelled", "canceled"].includes(String(order.status || "").toLowerCase())) return { status: 409, error: "Cancelled orders cannot be completed" };
  const isNonChargeable = String(order.payment_method || "").toLowerCase() === "non-chargeable" && String(order.non_chargeable_reason || "").trim();
  if (!isNonChargeable) {
    const paid = await env.DB.prepare(
      "SELECT COALESCE(SUM(amount), 0) AS amount_paid FROM payments WHERE order_id = ? AND business_id = ? AND payment_status = 'Success'"
    ).bind(orderId, businessId).first();
    if (Number(paid?.amount_paid || 0) + 0.01 < Number(order.total || 0)) return { status: 409, error: "Record the full payment in Orders before closing this order." };
  }
  const actor = await env.DB.prepare("SELECT COALESCE(display_name, username, 'Staff') AS name FROM app_users WHERE id = ? AND business_id = ? LIMIT 1").bind(Number(claims?.sub) || 0, businessId).first();
  const statements = [env.DB.prepare(
    "UPDATE orders SET status = 'Completed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ? AND LOWER(COALESCE(status, '')) NOT IN ('completed', 'cancelled', 'canceled')"
  ).bind(orderId, businessId),
  env.DB.prepare("INSERT INTO order_activity (order_id, event_type, description, actor, business_id, actor_user_id) SELECT ?, 'Order completed', 'Order marked completed.', ?, ?, ? WHERE changes() > 0")
    .bind(orderId, actor?.name || "Staff", businessId, Number(claims?.sub) || null)];
  if (String(order.order_type || "") === "Dine-in" && order.table_number !== null && order.table_number !== undefined) {
    statements.push(env.DB.prepare("UPDATE restaurant_tables SET status = 'Available' WHERE business_id = ? AND CAST(table_number AS TEXT) = ? AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND business_id = ? AND status = 'Completed')")
      .bind(businessId, String(order.table_number), orderId, businessId));
  }
  try {
    const results = await env.DB.batch(statements);
    if (!Number(results?.[0]?.meta?.changes || 0)) return { status: 409, error: "Order status changed. Refresh and try again." };
  } catch {
    return { status: 409, error: "Could not complete this order. Refresh and try again." };
  }
  const saved = await env.DB.prepare("SELECT * FROM orders WHERE id = ? AND business_id = ? LIMIT 1").bind(orderId, businessId).first();
  return { status: 200, success: true, order: saved };
}

async function createManualInvoice(env, businessId, body) {
  const orderId = Number(body?.orderId ?? body?.order_id);
  if (!Number.isSafeInteger(orderId) || orderId <= 0) return { status: 400, error: "Valid order ID is required" };
  const order = await env.DB.prepare("SELECT id, customer_id, total, payment_method, created_at FROM orders WHERE id = ? AND business_id = ? LIMIT 1").bind(orderId, businessId).first();
  if (!order) return { status: 400, error: "Order not found" };
  const existing = await env.DB.prepare("SELECT * FROM invoices WHERE order_id = ? AND business_id = ? LIMIT 1").bind(orderId, businessId).first();
  if (existing) return { status: 200, success: true, alreadyExists: true, invoice: existing };

  const customerSupplied = Object.prototype.hasOwnProperty.call(body || {}, "customerId") || Object.prototype.hasOwnProperty.call(body || {}, "customer_id");
  const rawCustomerId = customerSupplied ? (body.customerId ?? body.customer_id) : order.customer_id;
  let customerId = rawCustomerId === null || rawCustomerId === undefined || rawCustomerId === "" ? null : Number(rawCustomerId);
  if (customerId !== null) {
    if (!Number.isSafeInteger(customerId) || customerId <= 0) {
      customerId = null;
    } else {
      const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ? AND business_id = ? LIMIT 1").bind(customerId, businessId).first();
      if (!customer) customerId = null;
    }
  }
  const paymentSummary = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS collected, MAX(created_at) AS latest_payment_at FROM payments WHERE order_id = ? AND business_id = ? AND payment_status = 'Success'"
  ).bind(orderId, businessId).first();
  const amountCollected = Number(paymentSummary?.collected || 0);
  const orderTotal = Math.max(0, Number(order.total || 0));
  const nonChargeable = /non.?chargeable/i.test(String(order.payment_method || ""));
  const invoiceStatus = nonChargeable ? "Non-chargeable"
    : amountCollected + 0.009 >= orderTotal ? "Paid"
      : amountCollected > 0 ? "Partially Paid" : "Generated";
  const invoiceDate = paymentSummary?.latest_payment_at || order.created_at || null;

  const settingsRow = await env.DB.prepare("SELECT settings FROM app_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
  const settings = parseJsonField(settingsRow?.settings, {});
  const prefix = String(settings.invoicePrefix ?? "INV-").slice(0, 24);
  const padding = Math.max(1, Math.min(12, Math.floor(Number(settings.invoiceNumberPadding) || 6)));
  const start = Math.max(1, Math.floor(Number(settings.invoiceSequenceStart) || 1));
  const suffixStart = prefix.length + 1;
  const maxInvoice = await env.DB.prepare(
    "SELECT MAX(CAST(substr(invoice_number, ?) AS INTEGER)) AS max_number FROM invoices " +
    "WHERE business_id = ? AND substr(invoice_number, 1, ?) = ? AND substr(invoice_number, ?) <> '' AND substr(invoice_number, ?) NOT GLOB '*[^0-9]*'"
  ).bind(suffixStart, businessId, prefix.length, prefix, suffixStart, suffixStart).first();
  const counter = await env.DB.prepare("SELECT next_number FROM invoice_number_counters WHERE business_id = ? LIMIT 1").bind(businessId).first();
  const sequence = Math.max(start, Number(counter?.next_number) || 1, (Number(maxInvoice?.max_number) || 0) + 1);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO invoice_number_counters (business_id, next_number) VALUES (?, ?) ON CONFLICT(business_id) DO UPDATE SET next_number = MAX(invoice_number_counters.next_number, excluded.next_number), updated_at = CURRENT_TIMESTAMP").bind(businessId, sequence + 1),
    env.DB.prepare(
      "INSERT INTO invoices (invoice_number, order_id, customer_id, invoice_date, subtotal, gst, total, payment_method, status, business_id) " +
      "SELECT ? || printf('%0*d', ?, counter.next_number - 1), o.id, ?, COALESCE(?, o.created_at, CURRENT_TIMESTAMP), o.subtotal, o.gst, o.total, o.payment_method, ?, o.business_id " +
      "FROM orders o JOIN invoice_number_counters counter ON counter.business_id = o.business_id " +
      "WHERE o.id = ? AND o.business_id = ? ON CONFLICT(order_id) DO NOTHING"
    ).bind(prefix, padding, customerId, invoiceDate, invoiceStatus, orderId, businessId),
  ]);
  const invoice = await env.DB.prepare("SELECT * FROM invoices WHERE order_id = ? AND business_id = ? LIMIT 1").bind(orderId, businessId).first();
  return invoice ? { status: 201, success: true, alreadyExists: false, invoice } : { status: 500, error: "Could not create invoice" };
}

async function handleBusinessLogo(request, env, businessId) {
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405, { Allow: "PUT" });
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request body" }, 400); }
  if (body.logoUrl !== null && body.logoUrl !== undefined && typeof body.logoUrl !== "string") return json({ error: "Choose a PNG, JPEG or WebP logo image." }, 400);
  const logoUrl = String(body.logoUrl || "").trim();
  const current = await env.DB.prepare("SELECT logo_url FROM businesses WHERE id = ? LIMIT 1").bind(businessId).first();
  if (!current) return json({ error: "Business profile not found." }, 404);
  const previousUrl = current.logo_url || null;
  if (logoUrl && logoUrl === previousUrl) return json({ success: true, logoUrl: previousUrl });
  if (logoUrl) return json({ error: "Upload the logo through secure image storage." }, 400);
  const updated = await env.DB.prepare("UPDATE businesses SET logo_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND logo_url IS ?").bind(businessId, previousUrl).run();
  if (!Number(updated.meta?.changes || 0)) return json({ error: "The logo changed while removing it. Please retry." }, 409);
  return json({ success: true, logoUrl: "" });
}

const R2_IMAGE_BUCKET_NAMES = Object.freeze({
  item: "cafe-menu-items",
  category: "cafe-category-images",
  logo: "cafe-logos",
});
const R2_IMAGE_TYPES = Object.freeze({ jpg: "image/jpeg", png: "image/png", webp: "image/webp" });

function r2ImageObjectKey(entity, businessId, targetId, filename) {
  return `pilot/business-${businessId}/${R2_IMAGE_BUCKET_NAMES[entity]}/${businessId}/${entity === "logo" ? "logo" : targetId}/${filename}`;
}

function matchesImageBytes(bytes, mimeType) {
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") return bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value);
  if (mimeType === "image/webp") return bytes.length >= 12
    && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF"
    && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  return false;
}

async function serveR2Image(request, env, match) {
  if (!env.IMAGES || !env.LOGOS) return json({ error: "Cloudflare image storage is not configured" }, 503);
  const [, entity, rawBusinessId, rawTargetId, filename] = match;
  const businessId = Number(rawBusinessId);
  const targetId = Number(rawTargetId);
  if (!Number.isSafeInteger(businessId) || businessId <= 0 || !Number.isSafeInteger(targetId) || targetId <= 0
      || (entity === "logo" && targetId !== businessId) || !/^[a-f0-9-]{36}\.(?:jpg|png|webp)$/i.test(filename)
      || !(await isBusinessEnabled(env, businessId))) return json({ error: "Image not found" }, 404);
  const bucket = entity === "logo" ? env.LOGOS : env.IMAGES;
  const object = await bucket.get(r2ImageObjectKey(entity, businessId, targetId, filename));
  if (!object) return json({ error: "Image not found" }, 404);
  const headers = new Headers({
    "Content-Type": object.httpMetadata?.contentType || R2_IMAGE_TYPES[filename.split(".").pop().toLowerCase()],
    "Content-Length": String(object.size),
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}

async function handleR2ImageWrite(request, env, claims, directKeyAuthorized, url, match) {
  if (!env.IMAGES || !env.LOGOS) return json({ error: "Cloudflare image storage is not configured" }, 503);
  if (!["PUT", "DELETE"].includes(request.method)) return json({ error: "Method not allowed" }, 405, { Allow: "PUT, DELETE" });
  const [, entity, rawTargetId, filename] = match;
  const targetId = Number(rawTargetId);
  const businessId = Number(url.searchParams.get("business_id"));
  const expectedScope = entity === "logo" ? "settings.edit" : "menu.edit";
  const extension = String(filename.split(".").pop() || "").toLowerCase();
  if (!Number.isSafeInteger(businessId) || businessId <= 0 || !Number.isSafeInteger(targetId) || targetId <= 0
      || (entity === "logo" && targetId !== businessId) || !R2_IMAGE_TYPES[extension]
      || directKeyAuthorized || !claims || Number(claims.business_id) !== businessId
      || Number(claims.sub) <= 0 || claims.scope !== expectedScope
      || !(await isBusinessEnabled(env, businessId))) {
    return json({ error: "Image storage request is not authorized" }, 403);
  }
  const actor = await env.DB.prepare(`SELECT u.active, u.is_blocked,
      COALESCE(u.permissions_override, p.permissions, '{}') AS permissions
    FROM app_users u LEFT JOIN access_profiles p ON p.id = u.profile_id AND p.business_id = u.business_id
    WHERE u.id = ? AND u.business_id = ? LIMIT 1`).bind(Number(claims.sub), businessId).first();
  const permissions = parseJsonField(actor?.permissions, {});
  if (!actor || Number(actor.active) !== 1 || Number(actor.is_blocked) === 1 || permissions?.[expectedScope] !== true) {
    return json({ error: "You do not have permission to change this image" }, 403);
  }
  const entityTable = entity === "item" ? "menu" : entity === "category" ? "menu_categories" : "businesses";
  const owner = await env.DB.prepare(`SELECT id FROM ${entityTable} WHERE id = ?${entity === "logo" ? "" : " AND business_id = ?"} LIMIT 1`)
    .bind(...(entity === "logo" ? [targetId] : [targetId, businessId])).first();
  if (!owner) return json({ error: "The image target was not found for this café" }, 404);
  const bucket = entity === "logo" ? env.LOGOS : env.IMAGES;
  const objectKey = r2ImageObjectKey(entity, businessId, targetId, filename);
  const imageUrl = `${url.origin}/images/${entity}/${businessId}/${targetId}/${filename}`;

  if (request.method === "PUT") {
    const mimeType = String(request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const expectedMime = R2_IMAGE_TYPES[extension];
    const maxBytes = entity === "item" ? 2 * 1024 * 1024 : 200 * 1024;
    if (mimeType !== expectedMime) return json({ error: "Choose a JPEG, PNG or WebP image" }, 415);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length || bytes.length > maxBytes) return json({ error: entity === "item" ? "Choose an image up to 2 MB" : "Café logos and category images must be 200 KB or smaller" }, 413);
    if (!matchesImageBytes(bytes, mimeType)) return json({ error: "The image contents do not match its file type" }, 415);
    await bucket.put(objectKey, bytes, { httpMetadata: { contentType: mimeType, cacheControl: "public, max-age=31536000, immutable" } });
    return json({ success: true, imageUrl, objectPath: objectKey, size: bytes.length, contentType: mimeType }, 201);
  }

  const [itemRef, categoryRef, logoRef, settingsRef, snapshotRef] = await Promise.all([
    env.DB.prepare("SELECT 1 AS found FROM menu WHERE business_id = ? AND image_url = ? LIMIT 1").bind(businessId, imageUrl).first(),
    env.DB.prepare("SELECT 1 AS found FROM menu_categories WHERE business_id = ? AND image_url = ? LIMIT 1").bind(businessId, imageUrl).first(),
    env.DB.prepare("SELECT 1 AS found FROM businesses WHERE id = ? AND logo_url = ? LIMIT 1").bind(businessId, imageUrl).first(),
    env.DB.prepare("SELECT 1 AS found FROM app_settings WHERE business_id = ? AND json_valid(settings) AND json_extract(settings, '$.logoUrl') = ? LIMIT 1").bind(businessId, imageUrl).first(),
    env.DB.prepare("SELECT 1 AS found FROM orders WHERE business_id = ? AND json_valid(billing_settings_snapshot) AND json_extract(billing_settings_snapshot, '$.businessLogoUrl') = ? LIMIT 1").bind(businessId, imageUrl).first(),
  ]);
  if ([itemRef, categoryRef, logoRef, settingsRef, snapshotRef].some(Boolean)) return json({ success: true, deleted: false, reason: "still-referenced" });
  await bucket.delete(objectKey);
  return json({ success: true, deleted: true });
}

async function createBillingCustomer(request, env, businessId) {
  try {
    const raw = await request.text();
    if (raw.length > 16384) return { status: 413, error: "Customer request is too large." };
    const body = JSON.parse(raw || "{}");
    const name = String(body.name || "").trim().slice(0, 160);
    const phone = String(body.phone || "").trim().slice(0, 40);
    if (!name || !phone) return { status: 400, error: "Customer name and phone are required." };
    const email = String(body.email || "").trim().slice(0, 200) || null;
    const gstin = String(body.gstin || "").trim().slice(0, 32) || null;
    const birthDate = String(body.birthDate || body.birth_date || "").trim() || null;
    const address = String(body.address || "").trim().slice(0, 1000) || null;
    const city = String(body.city || "").trim().slice(0, 120) || null;
    const state = String(body.state || "").trim().slice(0, 120) || null;
    const existing = await env.DB.prepare(
      "SELECT id FROM customers WHERE business_id = ? AND phone = ? ORDER BY id LIMIT 1"
    ).bind(businessId, phone).first();
    let customer;
    if (existing) {
      customer = await env.DB.prepare(
        "UPDATE customers SET name = ?, email = ?, gstin = COALESCE(?, gstin), birth_date = COALESCE(?, birth_date), " +
        "address = COALESCE(?, address), city = COALESCE(?, city), state = COALESCE(?, state) " +
        "WHERE id = ? AND business_id = ? RETURNING *"
      ).bind(name, email, gstin, birthDate, address, city, state, Number(existing.id), businessId).first();
    } else {
      customer = await env.DB.prepare(
        "INSERT INTO customers (name, phone, email, business_id, gstin, birth_date, address, city, state) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
      ).bind(name, phone, email, businessId, gstin, birthDate, address, city, state).first();
    }
    return { status: existing ? 200 : 201, success: true, customer };
  } catch (error) {
    if (String(error?.message || "").includes("customers.business_id") || String(error?.message || "").includes("UNIQUE constraint")) {
      return { status: 409, error: "A customer with this phone number already exists." };
    }
    return { status: 400, error: "Could not save customer information." };
  }
}

async function createCustomer(request, env, businessId) {
  try {
    const raw = await request.text();
    if (raw.length > 16384) return { status: 413, error: "Customer request is too large." };
    const body = JSON.parse(raw || "{}");
    const name = String(body.name || "").trim().slice(0, 160);
    const phone = String(body.phone || "").trim().slice(0, 40);
    if (!name || !phone) return { status: 400, error: "Name and phone are required" };
    const row = await env.DB.prepare(
      "INSERT INTO customers (name, phone, email, gstin, birth_date, address, city, state, business_id) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
    ).bind(name, phone, String(body.email || "").trim() || null, String(body.gstin || "").trim() || null,
      String(body.birthDate || body.birth_date || "").trim() || null, String(body.address || "").trim() || null,
      String(body.city || "").trim() || null, String(body.state || "").trim() || null, businessId).first();
    return row ? { status: 201, success: true, customer: row } : { status: 500, error: "Could not save customer information." };
  } catch (error) {
    if (String(error?.message || "").includes("UNIQUE constraint")) return { status: 409, error: "A customer with this phone number already exists." };
    return { status: 400, error: "Could not save customer information." };
  }
}

async function updateCustomer(request, env, businessId, customerId) {
  try {
    const raw = await request.text();
    if (raw.length > 16384) return { status: 413, error: "Customer request is too large." };
    const body = JSON.parse(raw || "{}");
    const name = String(body.name || "").trim().slice(0, 160);
    const phone = String(body.phone || "").trim().slice(0, 40);
    if (!name || !phone) return { status: 400, error: "Name and phone are required" };
    const email = String(body.email || "").trim().slice(0, 200) || null;
    const birthDate = String(body.birthDate ?? body.birth_date ?? "").trim() || null;
    const gstin = String(body.gstin || "").trim().slice(0, 32) || null;
    const address = String(body.address || "").trim().slice(0, 1000) || null;
    const city = String(body.city || "").trim().slice(0, 120) || null;
    const state = String(body.state || "").trim().slice(0, 120) || null;
    const row = await env.DB.prepare(
      "UPDATE customers SET name = ?, phone = ?, email = ?, gstin = COALESCE(?, gstin), birth_date = COALESCE(?, birth_date), " +
      "address = COALESCE(?, address), city = COALESCE(?, city), state = COALESCE(?, state) " +
      "WHERE id = ? AND business_id = ? RETURNING *"
    ).bind(name, phone, email, gstin, birthDate, address, city, state, customerId, businessId).first();
    return row ? { status: 200, success: true, customer: row } : { status: 404, error: "Customer not found" };
  } catch (error) {
    if (String(error?.message || "").includes("UNIQUE constraint")) return { status: 409, error: "A customer with this phone number already exists." };
    return { status: 400, error: "Could not update customer information." };
  }
}

async function getCustomerOrderActivity(env, businessId, customerId) {
  if (!Number.isSafeInteger(customerId) || customerId <= 0) return json({ error: "Invalid customer" }, 400);
  const customer = await env.DB.prepare("SELECT id, name FROM customers WHERE id = ? AND business_id = ? LIMIT 1").bind(customerId, businessId).first();
  if (!customer) return json({ error: "Customer not found" }, 404);
  const count = await env.DB.prepare("SELECT COUNT(*) AS total_orders FROM orders WHERE customer_id = ? AND business_id = ?").bind(customerId, businessId).first();
  const rows = await env.DB.prepare(
    "SELECT id, order_number, total AS order_total FROM orders WHERE customer_id = ? AND business_id = ? ORDER BY created_at DESC, id DESC"
  ).bind(customerId, businessId).all();
  return json({ customer, totalOrders: Number(count?.total_orders || 0), orders: rows.results || [] });
}

function normalizeBillingAdjustment(row) {
  if (!row) return row;
  return { ...row, active: Boolean(row.active), value: Number(row.value || 0) };
}

const DEFAULT_POS_CHANNELS = [
  { key: "dine_in", label: "Dine in", orderType: "Dine-in", qrMenu: false },
  { key: "takeaway", label: "Takeaway", orderType: "Takeaway", qrMenu: false },
  { key: "delivery", label: "Delivery", orderType: "Takeaway", qrMenu: false },
  { key: "online", label: "Slash", orderType: "Takeaway", qrMenu: true },
];

function normalizePosChannels(settings) {
  const source = Array.isArray(settings?.posSalesChannels) ? settings.posSalesChannels : [];
  const defaults = new Map(DEFAULT_POS_CHANNELS.map((channel) => [channel.key, channel]));
  const byKey = new Map(source.map((channel) => [String(channel?.key || "").trim().toLowerCase(), channel]));
  const entries = [
    ...DEFAULT_POS_CHANNELS.map((channel) => ({ ...channel, ...(byKey.get(channel.key) || {}) })),
    ...source.filter((channel) => !defaults.has(String(channel?.key || "").trim().toLowerCase())),
  ].slice(0, 44);
  const seen = new Set();
  return entries.flatMap((entry) => {
    const key = String(entry?.key || "").trim().toLowerCase();
    const fixed = defaults.get(key);
    const label = String(fixed?.label || entry?.label || "").trim().slice(0, 60);
    const orderType = fixed?.orderType || (entry?.orderType === "Dine-in" ? "Dine-in" : entry?.orderType === "Takeaway" ? "Takeaway" : "");
    if (!/^[a-z][a-z0-9_]{1,19}$/.test(key) || !label || !orderType || seen.has(key)) return [];
    seen.add(key);
    const qrMenu = fixed ? fixed.qrMenu : entry?.qrMenu === true;
    const copies = Number(entry?.billCopies ?? (settings?.autoPrint === true ? settings?.billCopies : 0));
    const modes = qrMenu ? ["accepted", "never"] : ["never", "save", "checkout"];
    const fallbackMode = qrMenu ? "accepted" : (modes.includes(String(settings?.kotPrintMode || "")) ? String(settings.kotPrintMode) : "never");
    const requestedMode = String(entry?.kotPrintMode || "");
    return [{ key, label, orderType, qrMenu, billCopies: Number.isFinite(copies) ? Math.min(20, Math.max(0, Math.floor(copies))) : 0,
      kotPrintMode: modes.includes(requestedMode) ? requestedMode : fallbackMode }];
  });
}

function activeChannels(settings) {
  return normalizePosChannels(settings).map(({ key, label, orderType, qrMenu }) => ({ key, label, orderType, qrMenu }));
}

async function handleMenuOptionSets(request, env, businessId) {
  if (request.method === "GET") {
    const row = await env.DB.prepare("SELECT settings FROM app_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
    const settings = parseJsonField(row?.settings, {});
    return json({ optionSets: Array.isArray(settings.menuOptionSets) ? settings.menuOptionSets : [] });
  }
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405, { Allow: "GET, PUT" });
  try {
    const raw = await request.text();
    if (raw.length > 65536) return json({ error: "Option set request is too large" }, 413);
    const body = JSON.parse(raw || "{}");
    const input = body.optionSets;
    if (!Array.isArray(input) || input.length > 200) return json({ error: "Option sets must be a list of up to 200 sets." }, 400);
    const ids = new Set();
    const names = new Set();
    const optionSets = [];
    for (const source of input) {
      const id = String(source?.id || "").trim().slice(0, 80);
      const name = String(source?.name || "").trim().slice(0, 100);
      const options = (Array.isArray(source?.options) ? source.options : []).slice(0, 50).map((option) => ({
        id: String(option?.id || "").trim().slice(0, 80),
        menuItemId: Number.isSafeInteger(Number(option?.menuItemId)) && Number(option.menuItemId) > 0 ? Number(option.menuItemId) : null,
        name: String(option?.name || "").trim().slice(0, 100),
        price: Number(option?.price),
      }));
      const minSelections = Number(source?.minSelections ?? 0);
      const maxSelections = Number(source?.maxSelections ?? 1);
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !name || !options.length || options.some((option) => !option.id || !option.name || !Number.isFinite(option.price) || option.price < 0)) {
        return json({ error: "Each option set needs a name and at least one option with a valid non-negative price." }, 400);
      }
      if (ids.has(id) || names.has(name.toLocaleLowerCase())) return json({ error: "Option set IDs and names must be unique." }, 400);
      if (!Number.isInteger(minSelections) || !Number.isInteger(maxSelections) || minSelections < 0 || maxSelections < 1 || minSelections > maxSelections || maxSelections > options.length) {
        return json({ error: `Selection limits for “${name}” are invalid.` }, 400);
      }
      ids.add(id);
      names.add(name.toLocaleLowerCase());
      optionSets.push({ id, name, minSelections, maxSelections, options });
    }
    const menuItemIds = [...new Set(optionSets.flatMap((set) => set.options.map((option) => option.menuItemId).filter(Boolean)))];
    const menuItemsById = new Map();
    for (let offset = 0; offset < menuItemIds.length; offset += 99) {
      const chunk = menuItemIds.slice(offset, offset + 99);
      const result = await env.DB.prepare("SELECT id, name FROM menu WHERE business_id = ? AND available = 1 AND id IN (" + chunk.map(() => "?").join(",") + ")")
        .bind(businessId, ...chunk).all();
      for (const row of result.results || []) menuItemsById.set(Number(row.id), row);
    }
    for (const set of optionSets) {
      const usedMenuItems = new Set();
      for (const option of set.options) {
        if (!option.menuItemId) continue;
        const menuItem = menuItemsById.get(option.menuItemId);
        if (!menuItem) return json({ error: "Option set choices must reference available menu items for this business." }, 400);
        if (usedMenuItems.has(option.menuItemId)) return json({ error: "A menu item can appear only once in an option set." }, 400);
        usedMenuItems.add(option.menuItemId);
        option.name = String(menuItem.name || "").slice(0, 100);
      }
    }
    const settingsPatch = JSON.stringify({ menuOptionSets: optionSets });
    await env.DB.prepare(
      "INSERT INTO app_settings (business_id, settings, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(business_id) DO UPDATE SET settings = json_patch(COALESCE(app_settings.settings, '{}'), excluded.settings), updated_at = CURRENT_TIMESTAMP"
    ).bind(businessId, settingsPatch).run();
    return json({ success: true, optionSets });
  } catch (error) {
    return json({ error: "Failed to save menu option sets" }, Number(error?.status) || 400);
  }
}

function cleanD1MenuOptionSetIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id || "").trim()).filter((id) => /^[a-zA-Z0-9_-]{1,80}$/.test(id)))].slice(0, 30);
}

function cleanD1MenuTags(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[;,]/);
  const seen = new Set();
  const tags = [];
  for (const entry of source) {
    const tag = String(entry || "").trim().replace(/\s+/g, " ").slice(0, 40);
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= 12) break;
  }
  return tags;
}

function cleanD1MenuChannelPrices(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const prices = {};
  for (const [key, raw] of Object.entries(source)) {
    if (!/^[a-z][a-z0-9_]{1,19}$/.test(key)) continue;
    const price = Number(raw);
    if (Number.isFinite(price) && price >= 0) prices[key] = price;
  }
  return prices;
}

function cleanD1MenuVariants(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((variant) => ({
    name: String(variant?.name || "").trim().slice(0, 120),
    sku: String(variant?.sku || "").trim().slice(0, 80) || null,
    price: Number(variant?.price),
    unit: String(variant?.unit || "ea").trim().slice(0, 30) || "ea",
    channelPrices: cleanD1MenuChannelPrices(variant?.channelPrices ?? variant?.channel_prices),
    optionSetIds: cleanD1MenuOptionSetIds(variant?.optionSetIds ?? variant?.option_set_ids),
    available: variant?.available !== false,
  })).filter((variant) => variant.name && Number.isFinite(variant.price) && variant.price >= 0);
}

function menuSkuIsValid(value) {
  const sku = String(value ?? "").trim();
  return !sku || (sku.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(sku));
}

function cleanD1MenuSalesChannels(value, settings) {
  const allowed = activeChannels(settings).map((channel) => channel.key);
  if (value === undefined || value === null) return allowed;
  const source = Array.isArray(value) ? value : [];
  const selected = [...new Set(source.map((key) => String(key || "").trim().toLowerCase().replace(/[\s-]+/g, "_")).filter(Boolean))];
  if (!selected.length || selected.some((key) => !allowed.includes(key))) {
    throw Object.assign(new Error("Choose one or more currently active sale channels for this item."), { status: 400 });
  }
  return selected;
}

async function readMenuSettings(env, businessId) {
  const row = await env.DB.prepare("SELECT settings FROM app_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
  return parseJsonField(row?.settings, {});
}

function menuSkuConflict(error) {
  return String(error?.message || "").includes("idx_menu_business_sku_unique")
    || String(error?.message || "").includes("menu.business_id, upper(sku)")
    || String(error?.message || "").includes("UNIQUE constraint failed: menu.business_id");
}

async function loadMenuItem(env, businessId, id) {
  const row = await env.DB.prepare(
    "SELECT m.*, kg.name AS kot_group_name, kg.station AS kot_group_station FROM menu AS m " +
    "LEFT JOIN kot_groups AS kg ON kg.id = m.kot_group_id AND kg.business_id = ? WHERE m.id = ? AND m.business_id = ? LIMIT 1"
  ).bind(businessId, id, businessId).first();
  if (!row) return null;
  const variants = await env.DB.prepare(
    "SELECT id, menu_id, name, sku, price, unit, channel_prices, option_set_ids, available FROM menu_variants WHERE business_id = ? AND menu_id = ? ORDER BY id"
  ).bind(businessId, id).all();
  return normalizeMenuItem({ ...row, variants: variants.results || [] });
}

async function handleMenuItemWrite(request, env, businessId, path) {
  const match = path.match(/^\/v1\/pos\/menu\/(\d+)(?:\/(prices|qr-stock|enable|variants))?$/);
  const id = match ? Number(match[1]) : null;
  const resource = match?.[2] || "";
  if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) return json({ error: "Invalid menu item ID" }, 400);

  if (resource === "variants" && request.method === "GET") {
    const item = await loadMenuItem(env, businessId, id);
    return item ? json(item.variants) : json({ error: "Menu item not found" }, 404);
  }
  if (resource === "qr-stock" && request.method === "PATCH") {
    let body;
    try { body = JSON.parse(await request.text() || "{}"); } catch { return json({ error: "Invalid request body" }, 400); }
    if (typeof body.inStock !== "boolean") return json({ error: "Choose whether this item is in stock for the QR menu" }, 400);
    const result = await env.DB.prepare("UPDATE menu SET qr_available = ? WHERE id = ? AND business_id = ? RETURNING id, qr_available")
      .bind(body.inStock ? 1 : 0, id, businessId).first();
    return result ? json({ success: true, item: { ...result, qr_available: Boolean(result.qr_available) } }) : json({ error: "Menu item not found" }, 404);
  }
  if (resource === "enable" && request.method === "PUT") {
    const row = await env.DB.prepare("UPDATE menu SET available = 1 WHERE id = ? AND business_id = ? RETURNING *").bind(id, businessId).first();
    return row ? json({ success: true, menu: normalizeMenuItem(row) }) : json({ error: "Menu item not found" }, 404);
  }
  if (!resource && request.method === "DELETE" && id !== null) {
    const row = await env.DB.prepare("UPDATE menu SET available = 0 WHERE id = ? AND business_id = ? RETURNING *").bind(id, businessId).first();
    return row ? json({ success: true, menu: normalizeMenuItem(row) }) : json({ error: "Menu item not found" }, 404);
  }

  if (resource === "prices" && request.method === "PATCH") {
    let body;
    try { body = JSON.parse(await request.text() || "{}"); } catch { return json({ error: "Invalid request body" }, 400); }
    const price = Number(body.price);
    const variantPrices = Array.isArray(body.variants) ? body.variants : [];
    const channelPrices = cleanD1MenuChannelPrices(body.channelPrices);
    if (!Number.isSafeInteger(id) || !Number.isFinite(price) || price < 0) return json({ error: "Enter a valid item price" }, 400);
    if (variantPrices.length > 98 || variantPrices.some((row) => !Number.isSafeInteger(Number(row?.id)) || Number(row.id) <= 0 || !Number.isFinite(Number(row.price)) || Number(row.price) < 0)) {
      return json({ error: "Enter valid prices for every variant" }, 400);
    }
    const variantIds = [...new Set(variantPrices.map((row) => Number(row.id)))];
    if (variantIds.length !== variantPrices.length) return json({ error: "A variant price was submitted more than once" }, 400);
    const itemExists = await env.DB.prepare("SELECT id FROM menu WHERE id = ? AND business_id = ? LIMIT 1").bind(id, businessId).first();
    if (!itemExists) return json({ error: "Menu item not found" }, 404);
    if (variantIds.length) {
      const found = await env.DB.prepare("SELECT id FROM menu_variants WHERE menu_id = ? AND business_id = ? AND id IN (" + variantIds.map(() => "?").join(",") + ")")
        .bind(id, businessId, ...variantIds).all();
      if ((found.results || []).length !== variantIds.length) return json({ error: "A menu variant could not be found" }, 400);
    }
    const statements = [env.DB.prepare("UPDATE menu SET price = ?, channel_prices = ? WHERE id = ? AND business_id = ?")
      .bind(price, JSON.stringify(channelPrices), id, businessId)];
    for (const variant of variantPrices) {
      const hasChannelPrices = Object.prototype.hasOwnProperty.call(variant, "channelPrices");
      statements.push(hasChannelPrices
        ? env.DB.prepare("UPDATE menu_variants SET price = ?, channel_prices = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND menu_id = ? AND business_id = ?")
          .bind(Number(variant.price), JSON.stringify(cleanD1MenuChannelPrices(variant.channelPrices)), Number(variant.id), id, businessId)
        : env.DB.prepare("UPDATE menu_variants SET price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND menu_id = ? AND business_id = ?")
          .bind(Number(variant.price), Number(variant.id), id, businessId));
    }
    await env.DB.batch(statements);
    const row = await env.DB.prepare("SELECT id, price, channel_prices FROM menu WHERE id = ? AND business_id = ?").bind(id, businessId).first();
    return json({ success: true, menu: row ? { ...row, channel_prices: parseJsonField(row.channel_prices, {}) } : null });
  }

  if ((request.method !== "POST" || path !== "/v1/pos/menu") && !(request.method === "PUT" && id !== null && !resource)) {
    return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST, PUT, PATCH, DELETE" });
  }
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 65536) return json({ error: "Menu item request is too large" }, 413);
    body = JSON.parse(raw || "{}");
  } catch { return json({ error: "Invalid request body" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Menu item must be an object" }, 400);

  try {
    const current = id === null ? null : await env.DB.prepare("SELECT * FROM menu WHERE id = ? AND business_id = ? LIMIT 1").bind(id, businessId).first();
    if (id !== null && !current) return json({ error: "Menu item not found" }, 404);
    const name = String(body.name || "").trim().slice(0, 160);
    const price = Number(body.price);
    const category = String(body.category || "").trim().slice(0, 120);
    if (!name || !Number.isFinite(price) || price < 0 || !category) return json({ error: "Name, price and category are required" }, 400);
    const settings = await readMenuSettings(env, businessId);
    const salesChannels = cleanD1MenuSalesChannels(body.salesChannels === undefined && current
      ? parseJsonField(current.sales_channels, null) : body.salesChannels, settings);
    const isOpenItem = (body.isOpenItem ?? body.is_open_item) === undefined
      ? Boolean(current?.is_open_item) : (body.isOpenItem ?? body.is_open_item) === true;
    const available = body.available === undefined ? (current ? Boolean(current.available) : true) : body.available !== false;
    const variants = isOpenItem ? [] : cleanD1MenuVariants(body.variants);
    const skuInput = body.sku === undefined && current ? String(current.sku || "") : String(body.sku ?? "").trim();
    if (!menuSkuIsValid(skuInput)) return json({ error: "SKU must be up to 80 characters and use letters, numbers, dots, underscores, slashes or hyphens." }, 400);
    const sku = (skuInput || `SKU-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`).toUpperCase();
    const imageUrl = body.imageUrl === undefined ? (current?.image_url || null) : body.imageUrl === null || body.imageUrl === "" ? null : String(body.imageUrl);
    if (imageUrl && imageUrl !== String(current?.image_url || "")) return json({ error: "Menu item images must be uploaded through secure image storage." }, 400);
    const taxRateRaw = Number(body.taxRate ?? body.tax_rate ?? current?.tax_rate ?? 5);
    const taxRate = Number.isFinite(taxRateRaw) ? Math.max(0, taxRateRaw) : 0;
    let cgstRate = Number(body.cgstRate ?? body.cgst_rate ?? current?.cgst_rate ?? 0);
    let sgstRate = Number(body.sgstRate ?? body.sgst_rate ?? current?.sgst_rate ?? 0);
    let igstRate = Number(body.igstRate ?? body.igst_rate ?? current?.igst_rate ?? taxRate);
    if (!cgstRate && !sgstRate && taxRate > 0) { cgstRate = taxRate / 2; sgstRate = taxRate / 2; }
    if (!igstRate && taxRate > 0) igstRate = taxRate;
    cgstRate = Number.isFinite(cgstRate) ? Math.max(0, cgstRate) : 0;
    sgstRate = Number.isFinite(sgstRate) ? Math.max(0, sgstRate) : 0;
    igstRate = Number.isFinite(igstRate) ? Math.max(0, igstRate) : 0;
    const taxLabel = String(body.taxLabel || body.taxProfile || current?.tax_label || `GST ${taxRate}%`).trim().slice(0, 80);
    const taxMode = ["inclusive", "exclusive"].includes(body.taxMode) ? body.taxMode : String(current?.tax_mode || "exclusive");
    const nature = ["Goods", "Service"].includes(body.nature) ? body.nature : String(current?.nature || "Goods");
    const unit = String(body.unit || current?.unit || "ea").trim().slice(0, 30) || "ea";
    const channelPrices = cleanD1MenuChannelPrices(body.channelPrices === undefined ? parseJsonField(current?.channel_prices, {}) : body.channelPrices);
    const optionSetIds = isOpenItem ? [] : cleanD1MenuOptionSetIds(body.optionSetIds === undefined && current ? parseJsonField(current.option_set_ids, []) : body.optionSetIds);
    const tags = cleanD1MenuTags(body.tags === undefined && current ? parseJsonField(current.tags, []) : body.tags);
    const description = String(body.description === undefined ? current?.description || "" : body.description || "").trim().slice(0, 2000);
    const rawKotGroupId = body.kotGroupId === undefined && current ? current.kot_group_id : body.kotGroupId;
    const kotGroupId = rawKotGroupId === null || rawKotGroupId === undefined || rawKotGroupId === "" ? null : Number(rawKotGroupId);
    if (kotGroupId !== null && (!Number.isSafeInteger(kotGroupId) || kotGroupId <= 0)) return json({ error: "Choose a valid kitchen group." }, 400);
    if (kotGroupId !== null && !await env.DB.prepare("SELECT id FROM kot_groups WHERE id = ? AND business_id = ? AND active = 1 LIMIT 1").bind(kotGroupId, businessId).first()) {
      return json({ error: "Choose an active kitchen group for this café." }, 400);
    }
    const values = [name, price, category, available ? 1 : 0, kotGroupId, nature, unit, taxRate, cgstRate, sgstRate, igstRate, taxMode,
      taxLabel, JSON.stringify(channelPrices), imageUrl, JSON.stringify(optionSetIds), sku, description, JSON.stringify(salesChannels), JSON.stringify(tags), isOpenItem ? 1 : 0];
    const statements = [];
    if (current) {
      statements.push(env.DB.prepare(
        "UPDATE menu SET name = ?, price = ?, category = ?, available = ?, kot_group_id = ?, nature = ?, unit = ?, tax_rate = ?, cgst_rate = ?, sgst_rate = ?, igst_rate = ?, tax_mode = ?, tax_label = ?, channel_prices = ?, image_url = ?, option_set_ids = ?, sku = ?, description = ?, sales_channels = ?, tags = ?, is_open_item = ? WHERE id = ? AND business_id = ?"
      ).bind(...values, id, businessId));
      statements.push(env.DB.prepare("DELETE FROM menu_variants WHERE menu_id = ? AND business_id = ?").bind(id, businessId));
      for (const variant of variants) statements.push(env.DB.prepare(
        "INSERT INTO menu_variants (menu_id, name, sku, price, unit, channel_prices, available, business_id, option_set_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(id, variant.name, variant.sku, variant.price, variant.unit, JSON.stringify(variant.channelPrices), variant.available ? 1 : 0, businessId, JSON.stringify(variant.optionSetIds)));
    } else {
      statements.push(env.DB.prepare(
        "INSERT INTO menu (name, price, category, available, kot_group_id, nature, unit, tax_rate, cgst_rate, sgst_rate, igst_rate, tax_mode, tax_label, channel_prices, image_url, option_set_ids, business_id, sku, description, sales_channels, tags, is_open_item) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(name, price, category, available ? 1 : 0, kotGroupId, nature, unit, taxRate, cgstRate, sgstRate, igstRate, taxMode,
        taxLabel, JSON.stringify(channelPrices), imageUrl, JSON.stringify(optionSetIds), businessId, sku, description, JSON.stringify(salesChannels), JSON.stringify(tags), isOpenItem ? 1 : 0));
      for (const variant of variants) statements.push(env.DB.prepare(
        "INSERT INTO menu_variants (menu_id, name, sku, price, unit, channel_prices, available, business_id, option_set_ids) " +
        "SELECT id, ?, ?, ?, ?, ?, ?, ?, ? FROM menu WHERE business_id = ? AND sku = ? LIMIT 1"
      ).bind(variant.name, variant.sku, variant.price, variant.unit, JSON.stringify(variant.channelPrices), variant.available ? 1 : 0,
        businessId, JSON.stringify(variant.optionSetIds), businessId, sku));
    }
    await env.DB.batch(statements);
    const savedId = id ?? Number((await env.DB.prepare("SELECT id FROM menu WHERE business_id = ? AND sku = ? LIMIT 1").bind(businessId, sku).first())?.id);
    const saved = await loadMenuItem(env, businessId, savedId);
    return json({ success: true, menu: saved }, current ? 200 : 201);
  } catch (error) {
    if (menuSkuConflict(error)) return json({ error: "That SKU is already used by another menu item in this café. Choose a different SKU or leave it blank to generate one." }, 409);
    return json({ error: Number(error?.status) ? error.message : "Failed to save menu item" }, Number(error?.status) || 500);
  }
}

async function handleMenuImport(request, env, businessId) {
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 2_500_000) return json({ error: "Menu import is too large. Import up to 500 items at a time." }, 413);
    body = JSON.parse(raw || "{}");
  } catch { return json({ error: "Invalid import request" }, 400); }
  const rows = body?.items;
  if (!Array.isArray(rows) || !rows.length) return json({ error: "Choose at least one valid menu item to import." }, 400);
  if (rows.length > 500) return json({ error: "Import up to 500 menu items at a time." }, 400);
  const mode = ["insert", "update", "upsert"].includes(body.mode) ? body.mode : "insert";
  const settings = await readMenuSettings(env, businessId);
  const optionSets = Array.isArray(settings.menuOptionSets) ? settings.menuOptionSets : [];
  const validOptionSetIds = new Set(optionSets.map((set) => String(set.id)));
  const skipped = [];
  const seenNames = new Set();
  const seenSkus = new Set();
  let imported = 0;
  let updated = 0;
  let categoriesCreated = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const source = rows[index] && typeof rows[index] === "object" ? rows[index] : {};
    const rowNumber = Number(source.rowNumber) || index + 2;
    const name = String(source.name || "").trim().slice(0, 160);
    const category = String(source.category || "").trim().slice(0, 120);
    const price = Number(source.price);
    const skip = (reason) => skipped.push({ row: rowNumber, name, reason });
    const requestedSku = String(source.sku ?? "").trim();
    if (!menuSkuIsValid(requestedSku)) { skip("SKU must be up to 80 characters and use letters, numbers, dots, underscores, slashes or hyphens."); continue; }
    if (!name || !category || !Number.isFinite(price) || price < 0) { skip("Item name, category and a non-negative price are required."); continue; }
    const nameKey = name.toLocaleLowerCase();
    if (seenNames.has(nameKey)) { skip("This item name appears more than once in the spreadsheet."); continue; }
    seenNames.add(nameKey);
    const current = await env.DB.prepare(
      "SELECT * FROM menu WHERE business_id = ? AND lower(name) = lower(?) LIMIT 1"
    ).bind(businessId, name).first();
    if (current && mode === "insert") { skip("An item with this name already exists for this business."); continue; }
    if (!current && mode === "update") { skip("No existing item with this name was found to update."); continue; }
    const skuKey = requestedSku.toLocaleUpperCase();
    if (skuKey && seenSkus.has(skuKey)) { skip("This SKU appears more than once in the spreadsheet."); continue; }
    if (requestedSku) {
      const duplicate = await env.DB.prepare(
        "SELECT id FROM menu WHERE business_id = ? AND upper(sku) = upper(?) AND (? IS NULL OR id <> ?) LIMIT 1"
      ).bind(businessId, requestedSku, current?.id ?? null, current?.id ?? null).first();
      if (duplicate) { skip("This SKU is already assigned to another item in this café."); continue; }
      seenSkus.add(skuKey);
    }
    let optionSetIds = current ? cleanD1MenuOptionSetIds(parseJsonField(current.option_set_ids, [])) : [];
    if (source.optionSetIds !== undefined) {
      if (!Array.isArray(source.optionSetIds)) { skip("Item Options must be a list of saved option set IDs."); continue; }
      optionSetIds = cleanD1MenuOptionSetIds(source.optionSetIds);
      if (optionSetIds.length !== source.optionSetIds.length || optionSetIds.some((id) => !validOptionSetIds.has(id))) {
        skip("One or more item option sets are invalid or no longer available."); continue;
      }
    }
    let variants = null;
    if (source.variants !== undefined) {
      const sourceVariants = source.variants;
      if (!Array.isArray(sourceVariants) || sourceVariants.length > 50 || sourceVariants.some((variant) => !String(variant?.name || "").trim() || !Number.isFinite(Number(variant?.price)) || Number(variant.price) < 0)) {
        skip("Variants need a name and a non-negative price; use up to 50 variants per item."); continue;
      }
      const variantNames = sourceVariants.map((variant) => String(variant.name).trim().toLocaleLowerCase());
      if (new Set(variantNames).size !== variantNames.length) { skip("Variant names must be unique for each item."); continue; }
      if (sourceVariants.some((variant) => !menuSkuIsValid(variant.sku))) { skip("A variant SKU is invalid."); continue; }
      variants = cleanD1MenuVariants(sourceVariants);
    }
    let categoryRow = await env.DB.prepare("SELECT id FROM menu_categories WHERE business_id = ? AND lower(name) = lower(?) LIMIT 1").bind(businessId, category).first();
    if (!categoryRow) {
      const created = await env.DB.prepare("INSERT OR IGNORE INTO menu_categories (name, business_id) VALUES (?, ?)").bind(category, businessId).run();
      if (Number(created?.meta?.changes) > 0) categoriesCreated += 1;
      categoryRow = await env.DB.prepare("SELECT id FROM menu_categories WHERE business_id = ? AND lower(name) = lower(?) LIMIT 1").bind(businessId, category).first();
    }
    const taxRateValue = Number(source.taxRate ?? current?.tax_rate ?? 5);
    const taxRate = Number.isFinite(taxRateValue) ? Math.max(0, taxRateValue) : 0;
    let cgstRate = source.taxRate === undefined && current ? Number(current.cgst_rate) : taxRate / 2;
    let sgstRate = source.taxRate === undefined && current ? Number(current.sgst_rate) : taxRate / 2;
    let igstRate = source.taxRate === undefined && current ? Number(current.igst_rate) : taxRate;
    if (!Number.isFinite(cgstRate)) cgstRate = 0;
    if (!Number.isFinite(sgstRate)) sgstRate = 0;
    if (!Number.isFinite(igstRate)) igstRate = taxRate;
    const taxLabel = String(source.taxLabel || (source.taxRate === undefined ? current?.tax_label : `GST ${taxRate}%`) || `GST ${taxRate}%`).slice(0, 80);
    const taxMode = ["inclusive", "exclusive"].includes(source.taxMode) ? source.taxMode : String(current?.tax_mode || "exclusive");
    const nature = ["Goods", "Service"].includes(source.nature) ? source.nature : String(current?.nature || "Goods");
    const unit = String(source.unit || current?.unit || "ea").trim().slice(0, 20) || "ea";
    let salesChannels;
    try { salesChannels = cleanD1MenuSalesChannels(source.salesChannels == null && current ? parseJsonField(current.sales_channels, null) : source.salesChannels, settings); }
    catch (error) { skip(error.message); continue; }
    const sku = (requestedSku || current?.sku || `SKU-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`).toUpperCase();
    const description = String(source.description || current?.description || "").trim().slice(0, 2000);
    const tags = cleanD1MenuTags(source.tags === undefined && current ? parseJsonField(current.tags, []) : source.tags);
    const channelPrices = cleanD1MenuChannelPrices({ ...parseJsonField(current?.channel_prices, {}), ...cleanD1MenuChannelPrices(source.channelPrices) });
    const available = source.available === undefined || source.available === null ? (current ? Boolean(current.available) : true) : source.available !== false;
    const kotGroupId = current?.kot_group_id ?? null;
    try {
      const statements = [];
      if (current) {
        statements.push(env.DB.prepare(
          "UPDATE menu SET name = ?, price = ?, category = ?, available = ?, kot_group_id = ?, nature = ?, unit = ?, tax_rate = ?, cgst_rate = ?, sgst_rate = ?, igst_rate = ?, tax_mode = ?, tax_label = ?, channel_prices = ?, sku = ?, description = ?, sales_channels = ?, option_set_ids = ?, tags = ? WHERE id = ? AND business_id = ?"
        ).bind(name, price, category, available ? 1 : 0, kotGroupId, nature, unit, taxRate, cgstRate, sgstRate, igstRate, taxMode, taxLabel,
          JSON.stringify(channelPrices), sku, description, JSON.stringify(salesChannels), JSON.stringify(optionSetIds), JSON.stringify(tags), current.id, businessId));
        if (variants !== null) {
          statements.push(env.DB.prepare("DELETE FROM menu_variants WHERE menu_id = ? AND business_id = ?").bind(current.id, businessId));
          for (const variant of variants) statements.push(env.DB.prepare(
            "INSERT INTO menu_variants (menu_id, name, sku, price, unit, channel_prices, available, business_id, option_set_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(current.id, variant.name, variant.sku, variant.price, variant.unit, JSON.stringify(variant.channelPrices), variant.available ? 1 : 0, businessId, JSON.stringify(variant.optionSetIds)));
        }
      } else {
        statements.push(env.DB.prepare(
          "INSERT INTO menu (name, price, category, available, kot_group_id, nature, unit, tax_rate, cgst_rate, sgst_rate, igst_rate, tax_mode, tax_label, channel_prices, business_id, sku, description, sales_channels, option_set_ids, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(name, price, category, available ? 1 : 0, kotGroupId, nature, unit, taxRate, cgstRate, sgstRate, igstRate, taxMode, taxLabel,
          JSON.stringify(channelPrices), businessId, sku, description, JSON.stringify(salesChannels), JSON.stringify(optionSetIds), JSON.stringify(tags)));
        if (variants !== null) for (const variant of variants) statements.push(env.DB.prepare(
          "INSERT INTO menu_variants (menu_id, name, sku, price, unit, channel_prices, available, business_id, option_set_ids) " +
          "SELECT id, ?, ?, ?, ?, ?, ?, ?, ? FROM menu WHERE business_id = ? AND sku = ? LIMIT 1"
        ).bind(variant.name, variant.sku, variant.price, variant.unit, JSON.stringify(variant.channelPrices), variant.available ? 1 : 0,
          businessId, JSON.stringify(variant.optionSetIds), businessId, sku));
      }
      await env.DB.batch(statements);
      if (current) updated += 1; else imported += 1;
    } catch (error) {
      skip(menuSkuConflict(error) ? "This SKU is already assigned to another item in this café." : "The item could not be saved. Check its SKU, category and variant details.");
    }
  }
  return json({ success: true, imported, updated, categoriesCreated, skipped, warnings: [] }, 201);
}

async function handleMenuImageReference(request, env, businessId, path) {
  const match = path.match(/^\/v1\/pos\/image-references\/(item|category|logo)\/(\d+)$/);
  if (!match) return json({ error: "Not found" }, 404);
  const [, entity, rawId] = match;
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0 || (entity === "logo" && id !== businessId)) return json({ error: "Choose a valid image target." }, 400);
  const table = entity === "item" ? "menu" : entity === "category" ? "menu_categories" : "businesses";
  const column = entity === "logo" ? "logo_url" : "image_url";
  if (request.method === "GET") {
    const row = await env.DB.prepare(`SELECT ${column} AS image_url FROM ${table} WHERE id = ? LIMIT 1`).bind(id).first();
    return row ? json({ imageUrl: row.image_url || "" }) : json({ error: "The image target was not found for this café." }, 404);
  }
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405, { Allow: "GET, PUT" });
  let body;
  try { body = JSON.parse(await request.text() || "{}"); } catch { return json({ error: "Invalid request body" }, 400); }
  const imageUrl = body.imageUrl === null || body.imageUrl === "" ? null : String(body.imageUrl || "");
  const expectedImageUrl = body.expectedImageUrl === null || body.expectedImageUrl === "" ? null : String(body.expectedImageUrl || "");
  if (imageUrl && imageUrl.length > 2048) return json({ error: "The image URL is too long." }, 400);
  if (imageUrl) {
    let parsed;
    try { parsed = new URL(imageUrl); } catch { return json({ error: "Choose a valid uploaded image." }, 400); }
    const imagePath = parsed.pathname.match(/^\/images\/(item|category|logo)\/(\d+)\/(\d+)\/([a-f0-9-]{36}\.(?:jpg|png|webp))$/i);
    if (parsed.protocol !== "https:" || parsed.origin !== new URL(request.url).origin || parsed.username || parsed.password || parsed.search || parsed.hash
       || !imagePath || imagePath[1] !== entity || Number(imagePath[2]) !== businessId || Number(imagePath[3]) !== id
       || (entity === "logo" && id !== businessId)) {
      return json({ error: "Menu and category images must be uploaded through secure image storage." }, 400);
    }
  }
  const tenantFilter = entity === "logo" ? "id = ?" : "id = ? AND business_id = ?";
  const row = await env.DB.prepare(
    `UPDATE ${table} SET ${column} = ?${entity !== "item" ? ", updated_at = CURRENT_TIMESTAMP" : ""} ` +
    `WHERE ${tenantFilter} AND (${column} IS ? OR (? IS NULL AND ${column} = '')) RETURNING id, ${column} AS image_url`
  ).bind(...(entity === "logo" ? [imageUrl, id, expectedImageUrl, expectedImageUrl] : [imageUrl, id, businessId, expectedImageUrl, expectedImageUrl])).first();
  if (!row) return json({ error: "The image target changed while uploading. Please retry." }, 409);
  return json({ success: true, imageUrl: row.image_url || "" });
}

function normalizeD1Printer(body = {}, current = {}) {
  const value = (key, fallback = "") => body[key] === undefined ? (current[key] ?? fallback) : body[key];
  const name = String(value("name", "")).trim().slice(0, 120);
  const connectionType = String(value("connectionType", current.connection_type || "local"));
  const host = String(value("host", current.host || "")).trim();
  const port = Number(value("port", current.port || 9100));
  const paperWidth = String(value("paperWidth", current.paper_width || "80"));
  const bluetoothName = String(value("bluetoothName", current.bluetooth_name || "")).trim().slice(0, 120);
  const serviceUuid = String(value("serviceUuid", current.service_uuid || "000018f0-0000-1000-8000-00805f9b34fb")).trim().slice(0, 120);
  const characteristicUuid = String(value("characteristicUuid", current.characteristic_uuid || "00002af1-0000-1000-8000-00805f9b34fb")).trim().slice(0, 120);
  const isDefault = body.isDefault === undefined ? Boolean(current.is_default) : body.isDefault === true;
  if (!name) throw Object.assign(new Error("Printer name is required"), { status: 400 });
  if (!["local", "bluetooth", "network"].includes(connectionType)) throw Object.assign(new Error("Select a supported printer connection type"), { status: 400 });
  if (!["58", "80"].includes(paperWidth)) throw Object.assign(new Error("Paper width must be 58mm or 80mm"), { status: 400 });
  if (connectionType === "network") {
    const parts = host.split(".");
    const validIPv4 = parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
    const [a, b] = parts.map(Number);
    if (!validIPv4 || !(a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || a === 127)) {
      throw Object.assign(new Error("Enter a private LAN IPv4 address for the network printer"), { status: 400 });
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error("Printer port must be between 1 and 65535"), { status: 400 });
  }
  if (connectionType === "bluetooth" && (!serviceUuid || !characteristicUuid)) throw Object.assign(new Error("Bluetooth service and write characteristic UUIDs are required"), { status: 400 });
  return { name, connection_type: connectionType, host: connectionType === "network" ? host : null,
    port: connectionType === "network" ? port : 9100, bluetooth_name: connectionType === "bluetooth" ? (bluetoothName || name) : null,
    service_uuid: serviceUuid, characteristic_uuid: characteristicUuid, paper_width: paperWidth, is_default: isDefault ? 1 : 0 };
}

function normalizeD1PrinterRow(row) {
  return row ? { ...row, is_default: Boolean(row.is_default), active: Boolean(row.active) } : row;
}

async function saveRestaurantTableMetadata(env, businessId, metadata) {
  const current = await readMenuSettings(env, businessId);
  const settings = { ...current, restaurantTableMetadata: metadata };
  await env.DB.prepare(
    "INSERT INTO app_settings (business_id, settings, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) " +
    "ON CONFLICT(business_id) DO UPDATE SET settings = excluded.settings, updated_at = CURRENT_TIMESTAMP"
  ).bind(businessId, JSON.stringify(settings)).run();
}

async function validateTableArea(env, businessId, areaId) {
  const normalized = String(areaId || "").trim().slice(0, 80);
  if (!normalized) return "";
  const settings = await readMenuSettings(env, businessId);
  const areas = Array.isArray(settings.tableAreas) ? settings.tableAreas : [];
  if (!areas.some((area) => String(area?.id || "") === normalized)) {
    throw Object.assign(new Error("Choose a valid table area from Settings."), { status: 400 });
  }
  return normalized;
}

async function handleTables(request, env, businessId, path) {
  const statusMatch = path.match(/^\/v1\/pos\/tables\/(\d+)\/status$/);
  const idMatch = path.match(/^\/v1\/pos\/tables\/(\d+)$/);
  const id = Number(statusMatch?.[1] || idMatch?.[1]);
  if ((statusMatch || idMatch) && (!Number.isSafeInteger(id) || id <= 0)) return json({ error: "Invalid table ID" }, 400);
  if (request.method === "GET" && path === "/v1/pos/tables") {
    const dueReservations = await env.DB.prepare(
      "UPDATE reservations SET status = 'Arrived' WHERE business_id = ? AND status = 'Confirmed' AND table_number IS NOT NULL " +
      "AND datetime(reservation_date || ' ' || reservation_time, '+5 hours', '+30 minutes') <= datetime('now') RETURNING table_number"
    ).bind(businessId).all();
    const dueTables = [...new Set((dueReservations.results || []).map((row) => String(row.table_number || "")).filter(Boolean))];
    for (let offset = 0; offset < dueTables.length; offset += 99) {
      const chunk = dueTables.slice(offset, offset + 99);
      await env.DB.prepare("UPDATE restaurant_tables SET status = 'Occupied' WHERE business_id = ? AND table_number IN (" + chunk.map(() => "?").join(",") + ")")
        .bind(businessId, ...chunk).run();
    }
    await env.DB.prepare(
      "UPDATE restaurant_tables AS t SET status = 'Available' WHERE t.business_id = ? AND lower(coalesce(t.status, '')) = 'occupied' " +
      "AND cast(t.table_number AS TEXT) NOT IN (SELECT cast(value AS TEXT) FROM json_each(?)) " +
      "AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.business_id = t.business_id AND (cast(o.table_number AS TEXT) = cast(t.table_number AS TEXT) OR (t.table_number GLOB '*[^0-9]*' AND cast(o.table_number AS TEXT) = cast(t.id AS TEXT))) AND lower(coalesce(o.status, '')) NOT IN ('completed','cancelled')) " +
      "AND (SELECT lower(coalesce(latest.status, '')) FROM orders latest WHERE latest.business_id = t.business_id AND (cast(latest.table_number AS TEXT) = cast(t.table_number AS TEXT) OR (t.table_number GLOB '*[^0-9]*' AND cast(latest.table_number AS TEXT) = cast(t.id AS TEXT))) ORDER BY latest.updated_at DESC, latest.id DESC LIMIT 1) IN ('completed','cancelled')"
    ).bind(businessId, JSON.stringify(dueTables)).run();
    const [tableResult, settings] = await Promise.all([
      env.DB.prepare("SELECT id, table_number, capacity, status FROM restaurant_tables WHERE business_id = ? ORDER BY id").bind(businessId).all(),
      readMenuSettings(env, businessId),
    ]);
    const metadata = settings.restaurantTableMetadata && typeof settings.restaurantTableMetadata === "object" ? settings.restaurantTableMetadata : {};
    const areas = Array.isArray(settings.tableAreas) ? settings.tableAreas : [];
    return json((tableResult.results || []).map((table) => {
      const saved = metadata[String(table.table_number)] && typeof metadata[String(table.table_number)] === "object" ? metadata[String(table.table_number)] : {};
      const areaId = String(saved.areaId || "");
      const area = areas.find((entry) => String(entry?.id || "") === areaId);
      return { ...table, area_id: areaId, area_name: String(area?.name || ""), is_temporary: saved.isTemporary === true,
        server_name: String(saved.serverName || ""), temporary_created_at: saved.isTemporary === true ? String(saved.createdAt || "") : "" };
    }));
  }
  if (request.method === "POST" && path === "/v1/pos/tables") {
    try {
      const body = JSON.parse(await request.text() || "{}");
      const enteredName = String(body.tableNumber || body.table_number || "").trim();
      const capacity = Number(body.capacity) || 4;
      const isTemporary = body.isTemporary === true;
      const adhocSuffix = enteredName.replace(/^adhoc(?:\s+|$)/i, "").trim();
      const tableNumber = (isTemporary ? `Adhoc ${adhocSuffix}` : enteredName).slice(0, 80);
      if (!enteredName || (isTemporary && !adhocSuffix)) return json({ error: isTemporary ? "Enter a custom name after Adhoc." : "Table number is required" }, 400);
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) return json({ error: "Guest count must be between 1 and 100." }, 400);
      const areaId = await validateTableArea(env, businessId, body.areaId);
      const row = await env.DB.prepare("INSERT INTO restaurant_tables (table_number, capacity, status, business_id) VALUES (?, ?, 'Available', ?) RETURNING *")
        .bind(tableNumber, capacity, businessId).first();
      if (areaId || isTemporary) {
        const settings = await readMenuSettings(env, businessId);
        const metadata = settings.restaurantTableMetadata && typeof settings.restaurantTableMetadata === "object" ? { ...settings.restaurantTableMetadata } : {};
        metadata[tableNumber] = { ...(areaId ? { areaId } : {}), ...(isTemporary ? { isTemporary: true, serverName: String(body.serverName || "SYSTEM").trim().slice(0, 160) || "SYSTEM", createdAt: new Date().toISOString() } : {}) };
        await saveRestaurantTableMetadata(env, businessId, metadata);
      }
      return json({ success: true, table: { ...row, area_id: areaId, is_temporary: isTemporary, server_name: isTemporary ? String(body.serverName || "SYSTEM") : "" } }, 201);
    } catch (error) {
      if (String(error?.message || "").includes("UNIQUE constraint")) return json({ error: "Table number already exists" }, 409);
      return json({ error: Number(error?.status) ? error.message : "Failed to add table" }, Number(error?.status) || 500);
    }
  }
  if (statusMatch && request.method === "PUT") {
    let body;
    try { body = JSON.parse(await request.text() || "{}"); } catch { return json({ error: "Invalid request body" }, 400); }
    if (!["Available", "Occupied", "Reserved"].includes(body.status)) return json({ error: "Invalid table status" }, 400);
    const row = await env.DB.prepare("UPDATE restaurant_tables SET status = ? WHERE id = ? AND business_id = ? RETURNING *").bind(body.status, id, businessId).first();
    return row ? json({ success: true, table: row }) : json({ error: "Table not found" }, 404);
  }
  if (idMatch && request.method === "PUT") {
    let body;
    try { body = JSON.parse(await request.text() || "{}"); } catch { return json({ error: "Invalid request body" }, 400); }
    const tableNumber = String(body.tableNumber || body.table_number || "").trim().slice(0, 80);
    const capacity = Number(body.capacity) || 4;
    if (!tableNumber) return json({ error: "Table number is required" }, 400);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100) return json({ error: "Seating capacity must be between 1 and 100." }, 400);
    const current = await env.DB.prepare("SELECT * FROM restaurant_tables WHERE id = ? AND business_id = ? LIMIT 1").bind(id, businessId).first();
    if (!current) return json({ error: "Table not found" }, 404);
    try {
      const areaId = await validateTableArea(env, businessId, body.areaId);
      const settings = await readMenuSettings(env, businessId);
      const metadata = settings.restaurantTableMetadata && typeof settings.restaurantTableMetadata === "object" ? { ...settings.restaurantTableMetadata } : {};
      const oldMeta = metadata[String(current.table_number)] && typeof metadata[String(current.table_number)] === "object" ? metadata[String(current.table_number)] : {};
      const nextMeta = { ...(areaId ? { areaId } : {}), ...(oldMeta.isTemporary === true ? { isTemporary: true, serverName: String(oldMeta.serverName || "SYSTEM"), createdAt: String(oldMeta.createdAt || new Date().toISOString()) } : {}) };
      const row = await env.DB.prepare("UPDATE restaurant_tables SET table_number = ?, capacity = ? WHERE id = ? AND business_id = ? RETURNING *").bind(tableNumber, capacity, id, businessId).first();
      if (!row) return json({ error: "Table not found" }, 404);
      delete metadata[String(current.table_number)];
      if (Object.keys(nextMeta).length) metadata[tableNumber] = nextMeta;
      await saveRestaurantTableMetadata(env, businessId, metadata);
      return json({ success: true, table: row });
    } catch (error) {
      if (String(error?.message || "").includes("UNIQUE constraint")) return json({ error: "Table number already exists" }, 409);
      return json({ error: Number(error?.status) ? error.message : "Failed to update table" }, Number(error?.status) || 500);
    }
  }
  if (idMatch && request.method === "DELETE") {
    const current = await env.DB.prepare("SELECT * FROM restaurant_tables WHERE id = ? AND business_id = ? LIMIT 1").bind(id, businessId).first();
    if (!current) return json({ error: "Table not found" }, 404);
    if (String(current.status) === "Occupied") return json({ error: `${current.table_number} is currently occupied. Please make it Available before deleting.` }, 400);
    const settings = await readMenuSettings(env, businessId);
    const metadata = settings.restaurantTableMetadata && typeof settings.restaurantTableMetadata === "object" ? { ...settings.restaurantTableMetadata } : {};
    const temporary = metadata[String(current.table_number)]?.isTemporary === true;
    const activeOrder = await env.DB.prepare("SELECT 1 FROM orders WHERE business_id = ? AND cast(table_number AS TEXT) = ? AND lower(coalesce(status, '')) NOT IN ('completed','cancelled') LIMIT 1").bind(businessId, String(current.table_number)).first();
    if (activeOrder && temporary) return json({ error: "This adhoc table still has an active order." }, 400);
    if (!temporary) {
      const order = await env.DB.prepare("SELECT 1 FROM orders WHERE business_id = ? AND cast(table_number AS TEXT) = ? LIMIT 1").bind(businessId, String(current.table_number)).first();
      if (order) return json({ error: `${current.table_number} has existing orders. It cannot be deleted because historical order data must be preserved.` }, 400);
      const reservation = await env.DB.prepare("SELECT 1 FROM reservations WHERE business_id = ? AND cast(table_number AS TEXT) = ? LIMIT 1").bind(businessId, String(current.table_number)).first();
      if (reservation) return json({ error: `${current.table_number} has reservation records. It cannot be deleted.` }, 400);
    }
    await env.DB.prepare("DELETE FROM restaurant_tables WHERE id = ? AND business_id = ?").bind(id, businessId).run();
    delete metadata[String(current.table_number)];
    await saveRestaurantTableMetadata(env, businessId, metadata);
    return json({ success: true, table: current });
  }
  return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST, PUT, DELETE" });
}

async function handleReservations(request, env, businessId, path) {
  const statusMatch = path.match(/^\/v1\/pos\/reservations\/(\d+)\/status$/);
  if (request.method === "GET" && path === "/v1/pos/reservations") {
    await env.DB.prepare(
      "UPDATE reservations SET status = 'Arrived' WHERE business_id = ? AND status = 'Confirmed' AND table_number IS NOT NULL " +
      "AND datetime(reservation_date || ' ' || reservation_time, '+05:30') <= datetime('now')"
    ).bind(businessId).run();
    await env.DB.prepare(
      "UPDATE restaurant_tables SET status = 'Occupied' WHERE business_id = ? AND table_number IN " +
      "(SELECT table_number FROM reservations WHERE business_id = ? AND status = 'Arrived' AND table_number IS NOT NULL " +
      "AND datetime(reservation_date || ' ' || reservation_time, '+05:30') <= datetime('now'))"
    ).bind(businessId, businessId).run();
    const rows = await env.DB.prepare("SELECT * FROM reservations WHERE business_id = ? ORDER BY reservation_date ASC, reservation_time ASC, id ASC").bind(businessId).all();
    return json(rows.results || []);
  }
  if (request.method === "POST" && path === "/v1/pos/reservations") return json({ error: "Reservation creation must be coordinated" }, 405);
  if (request.method === "PUT" && statusMatch) return json({ error: "Reservation updates must be coordinated" }, 405);
  return json({ error: "Not found" }, 404);
}

async function createD1Reservation(env, businessId, body) {
  const name = String(body.customerName || body.customer_name || "").trim().slice(0, 160);
  const phone = String(body.phone || "").trim().slice(0, 40);
  const date = String(body.reservationDate || body.reservation_date || "").trim();
  const time = String(body.reservationTime || body.reservation_time || "").trim();
  const guests = Number(body.guests);
  const table = String(body.tableNumber || body.table_number || "").trim() || null;
  const notes = String(body.notes || "").trim().slice(0, 1000) || null;
  if (!name || !phone || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !Number.isInteger(guests) || guests < 1 || guests > 100) {
    return { status: 400, error: "Required reservation information is missing or invalid" };
  }
  const dateCheck = new Date(date + "T00:00:00.000Z");
  if (Number.isNaN(dateCheck.getTime()) || dateCheck.toISOString().slice(0, 10) !== date) return { status: 400, error: "Choose a valid reservation date" };
  if (table) {
    const exists = await env.DB.prepare("SELECT 1 FROM restaurant_tables WHERE business_id = ? AND table_number = ? LIMIT 1").bind(businessId, table).first();
    if (!exists) return { status: 400, error: "Selected table does not exist" };
    const conflict = await env.DB.prepare(
      "SELECT 1 FROM reservations WHERE business_id = ? AND table_number = ? AND reservation_date = ? AND reservation_time = ? AND status IN ('Reserved','Confirmed') LIMIT 1"
    ).bind(businessId, table, date, time).first();
    if (conflict) return { status: 400, error: "This table is already reserved for that date and time" };
  }
  const requestedStatus = String(body.status || "Reserved");
  if (!["Reserved", "Confirmed"].includes(requestedStatus)) return { status: 400, error: "Invalid reservation status" };
  const row = await env.DB.prepare(
    "INSERT INTO reservations (customer_name, phone, reservation_date, reservation_time, guests, table_number, status, notes, business_id) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
  ).bind(name, phone, date, time, guests, table, requestedStatus, notes, businessId).first();
  return row ? { status: 201, success: true, reservation: row } : { status: 500, error: "Could not save reservation" };
}

async function updateD1ReservationStatus(env, businessId, id, body) {
  const status = String(body.status || "");
  if (!["Reserved", "Confirmed", "Arrived", "Cancelled", "Completed"].includes(status)) return { status: 400, error: "Invalid reservation status" };
  const current = await env.DB.prepare("SELECT * FROM reservations WHERE id = ? AND business_id = ? LIMIT 1").bind(id, businessId).first();
  if (!current) return { status: 400, error: "Reservation not found" };
  const statements = [env.DB.prepare("UPDATE reservations SET status = ? WHERE id = ? AND business_id = ?").bind(status, id, businessId)];
  if (current.table_number && status === "Arrived") statements.push(env.DB.prepare("UPDATE restaurant_tables SET status = 'Occupied' WHERE table_number = ? AND business_id = ?").bind(current.table_number, businessId));
  if (current.table_number && ["Cancelled", "Completed"].includes(status)) statements.push(env.DB.prepare("UPDATE restaurant_tables SET status = 'Available' WHERE table_number = ? AND business_id = ?").bind(current.table_number, businessId));
  await env.DB.batch(statements);
  if (status === "Confirmed") {
    await env.DB.prepare(
      "UPDATE reservations SET status = 'Arrived' WHERE business_id = ? AND status = 'Confirmed' AND table_number IS NOT NULL " +
      "AND datetime(reservation_date || ' ' || reservation_time, '+05:30') <= datetime('now')"
    ).bind(businessId).run();
    await env.DB.prepare(
      "UPDATE restaurant_tables SET status = 'Occupied' WHERE business_id = ? AND table_number IN " +
      "(SELECT table_number FROM reservations WHERE business_id = ? AND status = 'Arrived' AND table_number IS NOT NULL " +
      "AND datetime(reservation_date || ' ' || reservation_time, '+05:30') <= datetime('now'))"
    ).bind(businessId, businessId).run();
  }
  const reservation = await env.DB.prepare("SELECT * FROM reservations WHERE id = ? AND business_id = ? LIMIT 1").bind(id, businessId).first();
  return { status: 200, success: true, reservation };
}

async function handlePrinters(request, env, businessId, path) {
  const idMatch = path.match(/^\/v1\/pos\/printers\/(\d+)$/);
  const id = idMatch ? Number(idMatch[1]) : null;
  if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) return json({ error: "Invalid printer ID" }, 400);
  if (request.method === "GET" && path === "/v1/pos/printers") {
    const rows = await env.DB.prepare(
      "SELECT id, name, connection_type, host, port, bluetooth_name, service_uuid, characteristic_uuid, paper_width, is_default, active, created_at, updated_at " +
      "FROM printers WHERE business_id = ? ORDER BY is_default DESC, name"
    ).bind(businessId).all();
    return json((rows.results || []).map(normalizeD1PrinterRow));
  }
  if (request.method === "POST" && path === "/v1/pos/printers") {
    try {
      const raw = await request.text();
      if (raw.length > 16384) return json({ error: "Printer request is too large" }, 413);
      const body = JSON.parse(raw || "{}");
      const printer = normalizeD1Printer(body);
      const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM printers WHERE business_id = ? AND active = 1").bind(businessId).first();
      if (!printer.is_default && Number(count?.count || 0) === 0) printer.is_default = 1;
      const statements = [];
      if (printer.is_default) statements.push(env.DB.prepare("UPDATE printers SET is_default = 0, updated_at = CURRENT_TIMESTAMP WHERE business_id = ?").bind(businessId));
      statements.push(env.DB.prepare(
        "INSERT INTO printers (business_id, name, connection_type, host, port, bluetooth_name, service_uuid, characteristic_uuid, paper_width, is_default) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
      ).bind(businessId, printer.name, printer.connection_type, printer.host, printer.port, printer.bluetooth_name, printer.service_uuid, printer.characteristic_uuid, printer.paper_width, printer.is_default));
      const result = await env.DB.batch(statements);
      const insertedId = Number(result.at(-1)?.meta?.last_row_id || result.at(-1)?.results?.[0]?.id || 0);
      const row = insertedId ? await env.DB.prepare("SELECT id, name, connection_type, host, port, bluetooth_name, service_uuid, characteristic_uuid, paper_width, is_default, active FROM printers WHERE id = ? AND business_id = ?").bind(insertedId, businessId).first() : null;
      return row ? json({ success: true, printer: normalizeD1PrinterRow(row) }, 201) : json({ error: "Failed to save printer" }, 500);
    } catch (error) { return json({ error: Number(error?.status) ? error.message : "Failed to save printer" }, Number(error?.status) || 500); }
  }
  if (id === null || !["PUT", "DELETE"].includes(request.method)) return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST, PUT, DELETE" });
  const current = await env.DB.prepare("SELECT * FROM printers WHERE id = ? AND business_id = ? LIMIT 1").bind(id, businessId).first();
  if (!current) return json({ error: "Printer not found" }, 404);
  if (request.method === "DELETE") {
    const statements = [env.DB.prepare("DELETE FROM printers WHERE id = ? AND business_id = ?").bind(id, businessId)];
    if (current.is_default) statements.push(env.DB.prepare(
      "UPDATE printers SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT id FROM printers WHERE business_id = ? ORDER BY id LIMIT 1)"
    ).bind(businessId));
    await env.DB.batch(statements);
    return json({ success: true });
  }
  try {
    const raw = await request.text();
    if (raw.length > 16384) return json({ error: "Printer request is too large" }, 413);
    const body = JSON.parse(raw || "{}");
    const printer = normalizeD1Printer(body, current);
    const statements = [];
    if (printer.is_default) statements.push(env.DB.prepare("UPDATE printers SET is_default = 0, updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id <> ?").bind(businessId, id));
    statements.push(env.DB.prepare(
      "UPDATE printers SET name = ?, connection_type = ?, host = ?, port = ?, bluetooth_name = ?, service_uuid = ?, characteristic_uuid = ?, paper_width = ?, is_default = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ?"
    ).bind(printer.name, printer.connection_type, printer.host, printer.port, printer.bluetooth_name, printer.service_uuid, printer.characteristic_uuid, printer.paper_width, printer.is_default, id, businessId));
    await env.DB.batch(statements);
    const row = await env.DB.prepare("SELECT id, name, connection_type, host, port, bluetooth_name, service_uuid, characteristic_uuid, paper_width, is_default, active FROM printers WHERE id = ? AND business_id = ?").bind(id, businessId).first();
    return row ? json({ success: true, printer: normalizeD1PrinterRow(row) }) : json({ error: "Printer not found" }, 404);
  } catch (error) { return json({ error: Number(error?.status) ? error.message : "Failed to update printer" }, Number(error?.status) || 500); }
}

async function handleMenuCategoryWrite(request, env, businessId, path) {
  const idMatch = path.match(/^\/v1\/menu\/categories\/(\d+)$/);
  const id = idMatch ? Number(idMatch[1]) : null;
  if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) return json({ error: "Invalid category ID" }, 400);
  if (request.method === "DELETE" && id !== null) {
    const row = await env.DB.prepare("DELETE FROM menu_categories WHERE id = ? AND business_id = ? RETURNING id").bind(id, businessId).first();
    return row ? json({ success: true }) : json({ error: "Menu category not found" }, 404);
  }
  if ((request.method === "POST" && id !== null) || (request.method === "PUT" && id === null)) return json({ error: "Not found" }, 404);
  try {
    const raw = await request.text();
    if (raw.length > 65536) return json({ error: "Category request is too large" }, 413);
    const body = JSON.parse(raw || "{}");
    const name = String(body.name || "").trim().slice(0, 120);
    const sortValue = Number(body.sortOrder || 0);
    const sortOrder = Number.isFinite(sortValue) ? sortValue : 0;
    const active = body.active !== false ? 1 : 0;
    if (!name) return json({ error: "Category name is required" }, 400);
    if (body.imageUrl && !idMatch) return json({ error: "Category images must be uploaded through secure image storage." }, 400);
    if (request.method === "POST") {
      const row = await env.DB.prepare(
        "INSERT INTO menu_categories (name, sort_order, active, business_id, image_url) VALUES (?, ?, ?, ?, NULL) RETURNING *"
      ).bind(name, sortOrder, active, businessId).first();
      return json({ ...row, active: Boolean(row.active) }, 201);
    }
    const existing = await env.DB.prepare("SELECT image_url FROM menu_categories WHERE id = ? AND business_id = ? LIMIT 1").bind(id, businessId).first();
    if (!existing) return json({ error: "Menu category not found" }, 404);
    const imageUrlProvided = Object.prototype.hasOwnProperty.call(body, "imageUrl");
    const imageUrl = body.imageUrl === null || body.imageUrl === "" ? null : String(body.imageUrl || "");
    if (imageUrlProvided && imageUrl && imageUrl !== String(existing.image_url || "")) return json({ error: "Category images must be uploaded through secure image storage." }, 400);
    const row = await env.DB.prepare(
      "UPDATE menu_categories SET name = ?, sort_order = ?, active = ?, image_url = CASE WHEN ? = 1 THEN ? ELSE image_url END, " +
      "updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ? RETURNING *"
    ).bind(name, sortOrder, active, imageUrlProvided ? 1 : 0, imageUrl, id, businessId).first();
    return row ? json({ ...row, active: Boolean(row.active) }) : json({ error: "Menu category not found" }, 404);
  } catch (error) {
    if (String(error?.message || "").includes("UNIQUE constraint")) return json({ error: "Menu category already exists" }, 409);
    return json({ error: Number(error?.status) ? error.message : "Failed to save menu category" }, Number(error?.status) || 500);
  }
}

function validatePosChannels(input, settings) {
  if (!Array.isArray(input) || input.length < 4 || input.length > 44) {
    throw Object.assign(new Error("Provide the four built-in channels and up to 40 additional sale channels."), { status: 400 });
  }
  for (const builtIn of DEFAULT_POS_CHANNELS) {
    const submitted = input.find((channel) => String(channel?.key || "").trim().toLowerCase() === builtIn.key);
    const label = String(submitted?.label || "").trim();
    const legacyDineLabel = builtIn.key === "dine_in" && label === "Dine";
    if (!submitted || (!legacyDineLabel && label !== builtIn.label) || submitted.orderType !== builtIn.orderType || (submitted.qrMenu === true) !== builtIn.qrMenu) {
      throw Object.assign(new Error(`${builtIn.label} is a built-in sale channel and cannot be edited or removed.`), { status: 400 });
    }
  }
  const channels = normalizePosChannels({ ...settings, posSalesChannels: input });
  const labels = channels.map((channel) => channel.label.toLocaleLowerCase());
  if (channels.length !== input.length || new Set(labels).size !== labels.length
    || !channels.some((channel) => channel.orderType === "Dine-in")
    || !channels.some((channel) => channel.orderType === "Takeaway")
    || !channels.some((channel) => channel.qrMenu)) {
    throw Object.assign(new Error("Channel keys and names must be unique. Keep at least one Dine-in channel, one Takeaway channel, and one QR Menu channel."), { status: 400 });
  }
  return channels;
}

async function handlePosSettings(request, env, businessId) {
  const currentRow = await env.DB.prepare("SELECT settings FROM app_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
  const current = parseJsonField(currentRow?.settings, {});
  if (request.method === "GET") {
    const settings = { ...current };
    delete settings.publicMenuHeroImages;
    delete settings.restaurantTableMetadata;
    settings.posSalesChannels = normalizePosChannels(settings);
    const branding = await env.DB.prepare("SELECT show_powered_by_cafe_pilot FROM support_business_branding WHERE business_id = ? LIMIT 1").bind(businessId).first();
    settings.showPoweredByCafePilot = branding ? Boolean(branding.show_powered_by_cafe_pilot) : true;
    return json(settings);
  }
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405, { Allow: "GET, PUT" });
  const pendingStatements = [];
  try {
    const raw = await request.text();
    if (raw.length > 65536) return json({ error: "Settings request is too large" }, 413);
    const body = JSON.parse(raw || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Settings must be an object" }, 400);
    const settings = { ...body };
    for (const key of ["showPoweredByCafePilot", "marketingDeals", "menuOptionSets", "restaurantTableMetadata", "publicMenuHeroImages"]) delete settings[key];
    if (Object.prototype.hasOwnProperty.call(settings, "posSalesChannels")) {
      settings.posSalesChannels = validatePosChannels(settings.posSalesChannels, { ...current, ...settings });
    }

    const series = [
      { key: "pos_order", prefix: "orderPrefix", start: "orderSequenceStart", padding: "orderNumberPadding", defaults: ["ORD-", 1, 4] },
      { key: "slash_order", prefix: "qrOrderPrefix", start: "qrOrderSequenceStart", padding: "qrOrderNumberPadding", defaults: ["QR-", 1, 4] },
      { key: "invoice", prefix: "invoicePrefix", start: "invoiceSequenceStart", padding: "invoiceNumberPadding", defaults: ["INV-", 1, 6] },
    ];
    for (const item of series) {
      if (![item.prefix, item.start, item.padding].some((key) => Object.prototype.hasOwnProperty.call(settings, key))) continue;
      const [defaultPrefix, defaultStart, defaultPadding] = item.defaults;
      const oldPrefix = String(current[item.prefix] ?? defaultPrefix).trim();
      const oldStart = Math.max(1, Math.floor(Number(current[item.start]) || defaultStart));
      const oldPadding = Math.max(1, Math.min(12, Math.floor(Number(current[item.padding]) || defaultPadding)));
      const prefix = String(settings[item.prefix] ?? oldPrefix).trim();
      const start = Number(settings[item.start] ?? oldStart);
      const padding = Number(settings[item.padding] ?? oldPadding);
      if (prefix.length > 24 || /[\r\n]/.test(prefix)) return json({ error: "Number-series prefixes must be 24 characters or fewer and stay on one line." }, 400);
      if (!Number.isSafeInteger(start) || start < 1) return json({ error: "Starting numbers must be positive whole numbers." }, 400);
      if (!Number.isInteger(padding) || padding < 1 || padding > 12) return json({ error: "Number width must be between 1 and 12 digits." }, 400);
      settings[item.prefix] = prefix;
      settings[item.start] = start;
      settings[item.padding] = padding;
      if (prefix === oldPrefix && start === oldStart) continue;
      const table = item.key === "invoice" ? "invoices" : "orders";
      const column = item.key === "invoice" ? "invoice_number" : "order_number";
      const exists = await env.DB.prepare(
        `SELECT 1 FROM ${table} WHERE business_id = ? AND substr(${column}, 1, ?) = ? AND substr(${column}, ?) <> '' ` +
        `AND substr(${column}, ?) NOT GLOB '*[^0-9]*' AND CAST(substr(${column}, ?) AS INTEGER) >= ? LIMIT 1`
      ).bind(businessId, prefix.length, prefix, prefix.length + 1, prefix.length + 1, prefix.length + 1, start).first();
      if (exists) return json({ error: "That prefix and starting number overlap existing IDs. Choose a new prefix or a higher unused starting number." }, 409);
      if (item.key === "invoice") {
        pendingStatements.push(env.DB.prepare(
          "INSERT INTO invoice_number_counters (business_id, next_number) VALUES (?, ?) " +
          "ON CONFLICT(business_id) DO UPDATE SET next_number = excluded.next_number, updated_at = CURRENT_TIMESTAMP"
        ).bind(businessId, start));
      } else {
        pendingStatements.push(env.DB.prepare(
          "INSERT INTO business_sequence_counters (business_id, series_key, next_number) VALUES (?, ?, ?) " +
          "ON CONFLICT(business_id, series_key) DO UPDATE SET next_number = excluded.next_number, updated_at = CURRENT_TIMESTAMP"
        ).bind(businessId, item.key, start));
      }
    }

    if (Object.prototype.hasOwnProperty.call(settings, "tableAreas")) {
      if (!Array.isArray(settings.tableAreas) || settings.tableAreas.length > 50) return json({ error: "Table areas must be a list of up to 50 areas." }, 400);
      const ids = new Set();
      const names = new Set();
      const areas = settings.tableAreas.map((area) => ({ id: String(area?.id || "").trim().slice(0, 80), name: String(area?.name || "").trim().slice(0, 80) }));
      for (const area of areas) {
        const normalized = area.name.toLocaleLowerCase();
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(area.id) || !area.name || ids.has(area.id) || names.has(normalized)) return json({ error: "Table area names and IDs must be non-empty and unique." }, 400);
        ids.add(area.id); names.add(normalized);
      }
      const metadata = current.restaurantTableMetadata && typeof current.restaurantTableMetadata === "object" ? current.restaurantTableMetadata : {};
      if (Object.values(metadata).some((entry) => entry?.areaId && !ids.has(String(entry.areaId)))) return json({ error: "Move tables out of an area before removing it." }, 400);
      settings.tableAreas = areas;
    }

    if (Object.prototype.hasOwnProperty.call(settings, "menuAccounts")) {
      if (!Array.isArray(settings.menuAccounts) || settings.menuAccounts.length > 100) return json({ error: "Menu accounts must be a list of up to 100 accounts." }, 400);
      const ids = new Set(); const names = new Set(); const assignedCategories = new Set();
      const accounts = settings.menuAccounts.map((account) => ({
        id: String(account?.id || "").trim().slice(0, 80), name: String(account?.name || "").trim().slice(0, 80),
        categoryIds: [...new Set((Array.isArray(account?.categoryIds) ? account.categoryIds : []).map((id) => String(id || "").trim()).filter((id) => /^\d+$/.test(id)))].slice(0, 500),
      }));
      for (const account of accounts) {
        const name = account.name.toLocaleLowerCase();
        if (!/^menu_account_[a-zA-Z0-9_-]{1,64}$/.test(account.id) || !account.name || ids.has(account.id) || names.has(name)) return json({ error: "Menu account names and IDs must be non-empty and unique." }, 400);
        ids.add(account.id); names.add(name);
        for (const categoryId of account.categoryIds) {
          if (assignedCategories.has(categoryId)) return json({ error: "Each menu category can only be assigned to one menu account." }, 409);
          assignedCategories.add(categoryId);
        }
      }
      const categoryIds = [...new Set(accounts.flatMap((account) => account.categoryIds).map(Number))];
      const valid = new Set();
      for (let offset = 0; offset < categoryIds.length; offset += 99) {
        const chunk = categoryIds.slice(offset, offset + 99);
        const result = await env.DB.prepare("SELECT id FROM menu_categories WHERE business_id = ? AND id IN (" + chunk.map(() => "?").join(",") + ")")
          .bind(businessId, ...chunk).all();
        for (const row of result.results || []) valid.add(Number(row.id));
      }
      for (const account of accounts) account.categoryIds = account.categoryIds.filter((id) => valid.has(Number(id)));
      settings.menuAccounts = accounts;
    }

    const settingsJson = JSON.stringify(settings);
    pendingStatements.push(env.DB.prepare(
      "INSERT INTO app_settings (business_id, settings, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(business_id) DO UPDATE SET settings = json_patch(COALESCE(app_settings.settings, '{}'), excluded.settings), updated_at = CURRENT_TIMESTAMP"
    ).bind(businessId, settingsJson));
    const results = await env.DB.batch(pendingStatements);
    if ((results || []).some((result) => result.success === false)) throw new Error("Settings batch was not applied");
    const savedRow = await env.DB.prepare("SELECT settings, updated_at FROM app_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
    const savedSettings = parseJsonField(savedRow?.settings, {});
    delete savedSettings.publicMenuHeroImages;
    delete savedSettings.restaurantTableMetadata;
    const branding = await env.DB.prepare("SELECT show_powered_by_cafe_pilot FROM support_business_branding WHERE business_id = ? LIMIT 1").bind(businessId).first();
    savedSettings.showPoweredByCafePilot = branding ? Boolean(branding.show_powered_by_cafe_pilot) : true;
    return json({ success: true, settings: savedSettings, updated_at: savedRow?.updated_at });
  } catch (error) {
    return json({ error: Number(error?.status) ? error.message : "Failed to save settings" }, Number(error?.status) || 400);
  }
}

async function handleSalesChannels(request, env, businessId) {
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405, { Allow: "PUT" });
  try {
    const raw = await request.text();
    if (raw.length > 65536) return json({ error: "Sales channel request is too large" }, 413);
    const body = JSON.parse(raw || "{}");
    const row = await env.DB.prepare("SELECT settings FROM app_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
    const settings = parseJsonField(row?.settings, {});
    const channels = validatePosChannels(body.channels, settings);
    const nextKeys = new Set(channels.map((channel) => channel.key));
    const previous = normalizePosChannels(settings);
    const removedKeys = previous.map((channel) => channel.key).filter((key) => !nextKeys.has(key));
    const deals = Array.isArray(settings.marketingDeals) ? settings.marketingDeals.map((deal) => {
      if (!Array.isArray(deal?.channels) || !deal.channels.length) return deal;
      const retained = deal.channels.map((value) => String(value).toLowerCase()).filter((key) => nextKeys.has(key));
      return { ...deal, channels: retained, active: retained.length ? deal.active !== false : false };
    }) : settings.marketingDeals;
    const preferences = {};
    for (const [name, orderType] of [["newOrder", "Takeaway"], ["tableView", "Dine-in"]]) {
      const available = channels.filter((channel) => name === "newOrder" || channel.orderType === orderType).map((channel) => channel.key);
      const fallback = name === "newOrder" ? channels.filter((channel) => channel.orderType === orderType).map((channel) => channel.key) : available;
      const current = settings.posChannelPreferences?.[name] || {};
      const selected = Array.isArray(current.channels) ? current.channels.filter((key) => available.includes(key)) : [];
      const selectedChannels = selected.length ? [...new Set(selected)] : fallback;
      preferences[name] = { channels: selectedChannels, defaultChannel: selectedChannels.includes(current.defaultChannel) ? current.defaultChannel : selectedChannels[0] };
    }
    const nextSettings = { ...settings, posSalesChannels: channels, posChannelPreferences: preferences };
    if (Array.isArray(deals)) nextSettings.marketingDeals = deals;
    const statements = [env.DB.prepare(
      "INSERT INTO app_settings (business_id, settings, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(business_id) DO UPDATE SET settings = excluded.settings, updated_at = CURRENT_TIMESTAMP"
    ).bind(businessId, JSON.stringify(nextSettings))];
    if (removedKeys.length) {
      const menuResult = await env.DB.prepare("SELECT id, sales_channels, channel_prices FROM menu WHERE business_id = ?").bind(businessId).all();
      for (const item of menuResult.results || []) {
        const stored = parseJsonField(item.sales_channels, null);
        const available = Array.isArray(stored) ? stored.map(String).filter((key) => nextKeys.has(key)) : channels.map((channel) => channel.key);
        const prices = parseJsonField(item.channel_prices, {});
        for (const key of removedKeys) delete prices[key];
        statements.push(env.DB.prepare("UPDATE menu SET sales_channels = ?, channel_prices = ? WHERE id = ? AND business_id = ?")
          .bind(JSON.stringify(available), JSON.stringify(prices), Number(item.id), businessId));
      }
      const variants = await env.DB.prepare("SELECT id, channel_prices FROM menu_variants WHERE business_id = ?").bind(businessId).all();
      for (const variant of variants.results || []) {
        const prices = parseJsonField(variant.channel_prices, {});
        for (const key of removedKeys) delete prices[key];
        statements.push(env.DB.prepare("UPDATE menu_variants SET channel_prices = ? WHERE id = ? AND business_id = ?")
          .bind(JSON.stringify(prices), Number(variant.id), businessId));
      }
      statements.push(env.DB.prepare(
        "UPDATE billing_adjustments SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE business_id = ? " +
        "AND replace(replace(lower(applies_to), '-', '_'), ' ', '_') IN (" + removedKeys.map(() => "?").join(",") + ")"
      ).bind(businessId, ...removedKeys));
    }
    const qrChannel = channels.find((channel) => channel.qrMenu)?.key;
    const qrChannels = channels.filter((channel) => channel.qrMenu).map((channel) => channel.key);
    if (qrChannel && qrChannels.length) {
      statements.push(env.DB.prepare(
        "UPDATE public_menu_settings SET price_channel = ?, updated_at = CURRENT_TIMESTAMP WHERE business_id = ? " +
        "AND price_channel NOT IN (" + qrChannels.map(() => "?").join(",") + ")"
      ).bind(qrChannel, businessId, ...qrChannels));
    }
    const batchResult = await env.DB.batch(statements);
    if ((batchResult || []).some((result) => result.success === false)) throw new Error("Sales channel update was not applied");
    const responseSettings = { ...nextSettings };
    delete responseSettings.publicMenuHeroImages;
    return json({ success: true, channels, settings: responseSettings, marketingDeals: Array.isArray(nextSettings.marketingDeals) ? nextSettings.marketingDeals : [] });
  } catch (error) {
    return json({ error: Number(error?.status) ? error.message : "Failed to save sales channels" }, Number(error?.status) || 400);
  }
}

function normalizeKotGroup(row) {
  if (!row) return row;
  return { ...row, active: Boolean(row.active), category_names: parseJsonField(row.category_names, []), item_ids: parseJsonField(row.item_ids, []) };
}

async function handleKotGroups(request, env, businessId, path) {
  const printerList = path === "/v1/pos/kot-groups/printers";
  const groupPath = path.match(/^\/v1\/pos\/kot-groups(?:\/(\d+))?$/);
  if (printerList && request.method === "GET") {
    const result = await env.DB.prepare("SELECT id, name, connection_type, paper_width FROM printers WHERE business_id = ? AND active = 1 ORDER BY is_default DESC, name")
      .bind(businessId).all();
    return json(result.results || []);
  }
  if (!groupPath) return json({ error: "Not found" }, 404);
  const id = groupPath[1] ? Number(groupPath[1]) : null;
  if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) return json({ error: "Invalid KOT group ID" }, 400);
  if (request.method === "GET" && id === null) {
    const result = await env.DB.prepare(
      "SELECT kg.*, p.name AS printer_name, p.connection_type AS printer_connection_type FROM kot_groups kg " +
      "LEFT JOIN printers p ON p.id = kg.printer_id AND p.business_id = kg.business_id " +
      "WHERE kg.business_id = ? ORDER BY kg.sort_order ASC, kg.name ASC"
    ).bind(businessId).all();
    return json((result.results || []).map(normalizeKotGroup));
  }
  if (!["POST", "PUT", "DELETE"].includes(request.method)) return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST, PUT, DELETE" });
  if (request.method === "DELETE" && id !== null) {
    const row = await env.DB.prepare("DELETE FROM kot_groups WHERE id = ? AND business_id = ? RETURNING id").bind(id, businessId).first();
    return row ? json({ success: true }) : json({ error: "KOT group not found" }, 404);
  }
  if ((request.method === "POST" && id !== null) || (request.method === "PUT" && id === null)) return json({ error: "Not found" }, 404);
  try {
    const raw = await request.text();
    if (raw.length > 65536) return json({ error: "KOT group request is too large" }, 413);
    const body = JSON.parse(raw || "{}");
    const name = String(body.name || "").trim().slice(0, 120);
    if (!name) return json({ error: "KOT group name is required" }, 400);
    const printerId = Number(body.printerId) || null;
    if (printerId !== null) {
      if (!Number.isSafeInteger(printerId) || printerId <= 0) return json({ error: "Select an active printer for this business." }, 400);
      const printer = await env.DB.prepare("SELECT id FROM printers WHERE id = ? AND business_id = ? AND active = 1 LIMIT 1").bind(printerId, businessId).first();
      if (!printer) return json({ error: "Select an active printer for this business." }, 400);
    }
    const categoryNames = [...new Set((Array.isArray(body.categoryNames) ? body.categoryNames : []).map((value) => String(value || "").trim().slice(0, 120)).filter(Boolean))].slice(0, 100);
    const itemIds = [...new Set((Array.isArray(body.itemIds) ? body.itemIds : []).map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))].slice(0, 1000);
    const description = String(body.description || "").trim().slice(0, 500) || null;
    const station = String(body.station || "Kitchen").trim().slice(0, 60) || "Kitchen";
    const sortOrder = Number(body.sortOrder || 0);
    if (!Number.isSafeInteger(sortOrder)) return json({ error: "KOT group sort order must be a whole number." }, 400);
    const active = body.active !== false ? 1 : 0;
    let row;
    if (request.method === "POST") {
      row = await env.DB.prepare(
        "INSERT INTO kot_groups (name, description, station, sort_order, active, business_id, printer_id, category_names, item_ids) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
      ).bind(name, description, station, sortOrder, active, businessId, printerId, JSON.stringify(categoryNames), JSON.stringify(itemIds)).first();
    } else {
      row = await env.DB.prepare(
        "UPDATE kot_groups SET name = ?, description = ?, station = ?, sort_order = ?, active = ?, printer_id = ?, " +
        "category_names = ?, item_ids = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ? RETURNING *"
      ).bind(name, description, station, sortOrder, active, printerId, JSON.stringify(categoryNames), JSON.stringify(itemIds), id, businessId).first();
      if (!row) return json({ error: "KOT group not found" }, 404);
    }
    return json(normalizeKotGroup(row), request.method === "POST" ? 201 : 200);
  } catch (error) {
    if (String(error?.message || "").includes("UNIQUE constraint")) return json({ error: "KOT group already exists" }, 409);
    return json({ error: Number(error?.status) ? error.message : "Failed to save KOT group" }, Number(error?.status) || 500);
  }
}

function kotHostState(row, deviceId) {
  const active = Boolean(row?.host_active);
  return { enabled: Boolean(row?.enabled), hostActive: active,
    isThisDeviceHost: String(row?.host_device_id || "") === String(deviceId || "") };
}

async function handleKotDeviceSettings(request, env, businessId, deviceId) {
  if (request.method === "GET") {
    const row = await env.DB.prepare(
      "INSERT INTO kot_device_print_hosts (business_id, enabled) VALUES (?, 0) " +
      "ON CONFLICT(business_id) DO UPDATE SET business_id = excluded.business_id " +
      "RETURNING enabled, host_device_id, CASE WHEN host_device_id IS NOT NULL AND last_heartbeat IS NOT NULL " +
      "AND datetime(last_heartbeat) > datetime('now', '-30 seconds') THEN 1 ELSE 0 END AS host_active"
    ).bind(businessId).first();
    return json(kotHostState(row, deviceId));
  }
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405, { Allow: "GET, PUT" });
  try {
    const body = await request.json();
    if (typeof body?.enabled !== "boolean") return json({ error: "Choose whether counter ticket printing is on or off." }, 400);
    const row = await env.DB.prepare(
      "INSERT INTO kot_device_print_hosts (business_id, enabled) VALUES (?, ?) " +
      "ON CONFLICT(business_id) DO UPDATE SET enabled = excluded.enabled, " +
      "host_device_id = CASE WHEN excluded.enabled = 1 THEN kot_device_print_hosts.host_device_id ELSE NULL END, " +
      "last_heartbeat = CASE WHEN excluded.enabled = 1 THEN kot_device_print_hosts.last_heartbeat ELSE NULL END, updated_at = CURRENT_TIMESTAMP " +
      "RETURNING enabled, host_device_id, CASE WHEN host_device_id IS NOT NULL AND last_heartbeat IS NOT NULL " +
      "AND datetime(last_heartbeat) > datetime('now', '-30 seconds') THEN 1 ELSE 0 END AS host_active"
    ).bind(businessId, body.enabled ? 1 : 0).first();
    return json({ success: true, ...kotHostState(row, deviceId) });
  } catch {
    return json({ error: "Could not update counter ticket printing." }, 400);
  }
}

async function handleKotPrintJob(request, env, businessId, deviceId, path) {
  if (!deviceId) return json({ error: "This POS device is not registered for ticket printing." }, 403);
  if (path === "/v1/pos/kot-print-jobs/claim" && request.method === "POST") {
    await env.DB.prepare(
      "UPDATE kot_device_print_hosts SET host_device_id = ?, last_heartbeat = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP " +
      "WHERE business_id = ? AND enabled = 1 AND (host_device_id IS NULL OR host_device_id = ? OR last_heartbeat IS NULL " +
      "OR datetime(last_heartbeat) < datetime('now', '-30 seconds')) AND (COALESCE(host_device_id, '') <> ? " +
      "OR last_heartbeat IS NULL OR datetime(last_heartbeat) < datetime('now', '-15 seconds'))"
    ).bind(deviceId, businessId, deviceId, deviceId).run();
    const host = await env.DB.prepare(
      "SELECT enabled, host_device_id, CASE WHEN last_heartbeat IS NOT NULL AND datetime(last_heartbeat) >= datetime('now', '-30 seconds') THEN 1 ELSE 0 END AS host_active " +
      "FROM kot_device_print_hosts WHERE business_id = ? LIMIT 1"
    ).bind(businessId).first();
    if (!Boolean(host?.enabled) || String(host?.host_device_id || "") !== deviceId || !Boolean(host?.host_active)) return json({ success: true, job: null });
    const job = await env.DB.prepare(
      "UPDATE kot_device_print_jobs SET status = 'claimed', attempts = attempts + 1, claimed_by_device_id = ?, " +
      "lease_until = datetime('now', '+2 minutes'), last_error = NULL WHERE id = (" +
      "SELECT id FROM kot_device_print_jobs WHERE business_id = ? AND attempts < 3 AND datetime(next_attempt_at) <= datetime('now') " +
      "AND (status = 'pending' OR (status = 'claimed' AND lease_until IS NOT NULL AND datetime(lease_until) < datetime('now'))) " +
      "ORDER BY id LIMIT 1) AND business_id = ? RETURNING id, order_id, ticket_number, attempts"
    ).bind(deviceId, businessId, businessId).first();
    return json({ success: true, job: job || null });
  }
  const complete = path.match(/^\/v1\/pos\/kot-print-jobs\/(\d+)\/complete$/);
  if (complete && request.method === "POST") {
    const jobId = Number(complete[1]);
    if (!Number.isSafeInteger(jobId) || jobId <= 0) return json({ error: "Invalid print job." }, 400);
    try {
      const body = await request.json();
      const printed = body?.success === true;
      const error = String(body?.error || "").trim().slice(0, 500) || null;
      const row = await env.DB.prepare(
        "UPDATE kot_device_print_jobs SET status = CASE WHEN ? = 1 THEN 'printed' WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END, " +
        "printed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE printed_at END, " +
        "next_attempt_at = CASE WHEN ? = 1 OR attempts >= 3 THEN next_attempt_at ELSE datetime('now', '+15 seconds') END, " +
        "lease_until = NULL, last_error = CASE WHEN ? = 1 THEN NULL ELSE ? END " +
        "WHERE id = ? AND business_id = ? AND status = 'claimed' AND claimed_by_device_id = ? RETURNING status, attempts"
      ).bind(printed ? 1 : 0, printed ? 1 : 0, printed ? 1 : 0, printed ? 1 : 0, error, jobId, businessId, deviceId).first();
      if (!row) return json({ error: "This print job is no longer assigned to this device." }, 409);
      return json({ success: true, status: row.status, attempts: Number(row.attempts || 0) });
    } catch {
      return json({ error: "Could not record the kitchen ticket print result." }, 400);
    }
  }
  return json({ error: "Not found" }, 404);
}

async function handleKotNotifications(url, env, businessId) {
  const hasKotCursor = url.searchParams.has("afterId");
  const hasActivityCursor = url.searchParams.has("afterActivityId");
  const afterKotId = hasKotCursor ? Number(url.searchParams.get("afterId")) : null;
  const afterActivityId = hasActivityCursor ? Number(url.searchParams.get("afterActivityId")) : null;
  if (hasKotCursor && (!Number.isSafeInteger(afterKotId) || afterKotId < 0)) return json({ error: "Invalid KOT cursor" }, 400);
  if (hasActivityCursor && (!Number.isSafeInteger(afterActivityId) || afterActivityId < 0)) return json({ error: "Invalid kitchen status cursor" }, 400);
  const latest = await env.DB.prepare(
    "SELECT (SELECT COALESCE(MAX(id), 0) FROM kot WHERE business_id = ?) AS latest_kot_id, " +
    "(SELECT COALESCE(MAX(id), 0) FROM order_activity WHERE business_id = ?) AS latest_activity_id"
  ).bind(businessId, businessId).first();
  const kotBatch = hasKotCursor ? (await env.DB.prepare("SELECT id FROM kot WHERE business_id = ? AND id > ? ORDER BY id LIMIT 501").bind(businessId, afterKotId).all()).results || [] : [];
  const activityBatch = hasActivityCursor ? (await env.DB.prepare(
    "SELECT id, order_id FROM order_activity WHERE business_id = ? AND event_type = 'Kitchen status changed' AND id > ? ORDER BY id LIMIT 501"
  ).bind(businessId, afterActivityId).all()).results || [] : [];
  const kotPage = kotBatch.slice(0, 500);
  const activityPage = activityBatch.slice(0, 500);
  const ticketIds = new Set(kotPage.map((row) => Number(row.id)));
  for (let offset = 0; offset < activityPage.length; offset += 90) {
    const chunk = activityPage.slice(offset, offset + 90).map((row) => Number(row.id));
    if (!chunk.length) continue;
    const result = await env.DB.prepare(
      "SELECT DISTINCT k.id FROM kot k JOIN order_activity a ON a.order_id = k.order_id AND a.business_id = k.business_id " +
      "WHERE k.business_id = ? AND a.id IN (" + chunk.map(() => "?").join(",") + ")"
    ).bind(businessId, ...chunk).all();
    for (const row of result.results || []) ticketIds.add(Number(row.id));
  }
  const tickets = [];
  const ids = [...ticketIds];
  for (let offset = 0; offset < ids.length; offset += 90) {
    const chunk = ids.slice(offset, offset + 90);
    const result = await env.DB.prepare(
      "SELECT k.id, k.business_id, k.order_id, k.item_name, k.quantity, k.status, k.created_at, k.kot_group_id, " +
      "k.options, k.cancelled_quantity, k.ticket_number, kg.name AS kot_group_name, kg.station AS kot_group_station, " +
      "o.order_number, o.order_type, o.table_number, o.pax, o.notes AS order_notes, o.status AS order_status, o.public_tracking_token " +
      "FROM kot k JOIN orders o ON o.id = k.order_id AND o.business_id = k.business_id " +
      "LEFT JOIN kot_groups kg ON kg.id = k.kot_group_id AND kg.business_id = k.business_id " +
      "WHERE k.business_id = ? AND k.id IN (" + chunk.map(() => "?").join(",") + ")"
    ).bind(businessId, ...chunk).all();
    tickets.push(...(result.results || []).map((row) => normalizeOrderChild(row)));
  }
  tickets.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) || Number(b.id) - Number(a.id));
  return json({
    latestKotId: Number(latest?.latest_kot_id || 0), latestActivityId: Number(latest?.latest_activity_id || 0),
    cursorKotId: kotBatch.length > 500 ? Number(kotPage.at(-1)?.id || afterKotId || 0) : Number(latest?.latest_kot_id || 0),
    cursorActivityId: activityBatch.length > 500 ? Number(activityPage.at(-1)?.id || afterActivityId || 0) : Number(latest?.latest_activity_id || 0),
    seeded: !hasKotCursor && !hasActivityCursor, items: tickets,
  });
}

async function handleQrOrderNotifications(url, env, businessId) {
  const rawAfterId = url.searchParams.get("afterId");
  const rawAfterActivityId = url.searchParams.get("afterActivityId");
  const afterId = rawAfterId === null ? null : Number(rawAfterId);
  const afterActivityId = rawAfterActivityId === null ? null : Number(rawAfterActivityId);
  if (afterId !== null && (!Number.isSafeInteger(afterId) || afterId < 0)) return json({ error: "Invalid order cursor" }, 400);
  if (afterActivityId !== null && (!Number.isSafeInteger(afterActivityId) || afterActivityId < 0)) return json({ error: "Invalid order update cursor" }, 400);
  const latest = await env.DB.prepare(
    "SELECT (SELECT COALESCE(MAX(id), 0) FROM orders WHERE business_id = ?) AS latest_order_id, " +
    "(SELECT COALESCE(MAX(id), 0) FROM order_activity WHERE business_id = ?) AS latest_activity_id"
  ).bind(businessId, businessId).first();
  const newOrders = (await env.DB.prepare(
    "SELECT id, order_number, table_number, total, created_at FROM orders WHERE business_id = ? " +
    "AND (public_tracking_token IS NOT NULL OR order_number LIKE 'QR-%') " +
    "AND ((? IS NOT NULL AND id > ?) OR (? IS NULL AND LOWER(COALESCE(status, '')) IN ('pending', 'preparing'))) ORDER BY id"
  ).bind(businessId, afterId, afterId, afterId).all()).results || [];
  const activityRows = afterActivityId === null ? [] : (await env.DB.prepare(
    "SELECT a.id AS activity_id, a.event_type, o.id, o.order_number, o.table_number, o.total, o.status, o.updated_at, o.public_tracking_token " +
    "FROM order_activity a JOIN orders o ON o.id = a.order_id AND o.business_id = a.business_id " +
    "WHERE a.business_id = ? AND a.id > ? AND a.event_type IN " +
    "('QR items added', 'QR order accepted', 'QR order marked ready', 'Payment recorded', 'Order completed', 'Order cancelled', 'Order updated', 'Item cancelled', 'Closed bill edited', 'Kitchen status changed') " +
    "AND (o.public_tracking_token IS NOT NULL OR o.order_number LIKE 'QR-%') ORDER BY a.id"
  ).bind(businessId, afterActivityId).all()).results || [];
  const updatesByOrder = new Map();
  const statusByOrder = new Map();
  const acceptedOrders = [];
  const statusEvents = new Set(["QR order marked ready", "Payment recorded", "Order completed", "Order cancelled", "Order updated", "Item cancelled", "Closed bill edited", "Kitchen status changed"]);
  const slim = (row) => ({ id: Number(row.id), activity_id: Number(row.activity_id), order_number: row.order_number,
    table_number: row.table_number, total: Number(row.total || 0), status: row.status, updated_at: row.updated_at });
  for (const row of activityRows) {
    if (row.event_type === "QR items added") updatesByOrder.set(Number(row.id), slim(row));
    else if (row.event_type === "QR order accepted") acceptedOrders.push(slim(row));
    else if (statusEvents.has(row.event_type)) statusByOrder.set(Number(row.id), { ...slim(row), event_type: row.event_type });
  }
  const byActivity = (a, b) => a.activity_id - b.activity_id;
  return json({ latestOrderId: Number(latest?.latest_order_id || 0), latestActivityId: Number(latest?.latest_activity_id || 0),
    orders: newOrders.map((row) => ({ ...row, id: Number(row.id), total: Number(row.total || 0) })),
    updates: [...updatesByOrder.values()].sort(byActivity), acceptedOrders: acceptedOrders.sort(byActivity),
    statusChanges: [...statusByOrder.values()].sort(byActivity) });
}

function qrOrderingState(publication, businessName) {
  const outletOpen = publication?.outlet_open === undefined ? true : Boolean(publication.outlet_open);
  const hoursEnabled = Boolean(publication?.hours_enabled);
  const normalizeTime = (value, fallback) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "")) ? String(value) : fallback;
  const openTime = normalizeTime(publication?.open_time, "09:00");
  const closeTime = normalizeTime(publication?.close_time, "22:00");
  let withinHours = true;
  if (hoursEnabled) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const current = Number(values.hour || 0) * 60 + Number(values.minute || 0);
    const [openHour, openMinute] = openTime.split(":").map(Number);
    const [closeHour, closeMinute] = closeTime.split(":").map(Number);
    const start = openHour * 60 + openMinute;
    const end = closeHour * 60 + closeMinute;
    withinHours = start === end || (start < end ? current >= start && current < end : current >= start || current < end);
  }
  const orderingOpen = outletOpen && withinHours;
  const hours = hoursEnabled ? ` We’re back ${openTime}–${closeTime} IST.` : "";
  return { orderingOpen, outletOpen, hoursEnabled, openTime, closeTime,
    closedMessage: orderingOpen ? "" : `${String(businessName || "The cafe")} is closed rn 😴 — the kitchen’s on a lil break.${hours} Catch us during open hours for the good stuff.` };
}

async function handleQrServiceRequests(url, env, businessId) {
  const cursorProvided = url.searchParams.has("afterId");
  const afterId = cursorProvided ? Number(url.searchParams.get("afterId")) : null;
  if (cursorProvided && (!Number.isSafeInteger(afterId) || afterId < 0)) return json({ error: "Invalid service request cursor" }, 400);
  const latestId = Number((await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM qr_service_requests WHERE business_id = ?").bind(businessId).first())?.id || 0);
  const rows = cursorProvided ? (await env.DB.prepare(
    "SELECT id, table_number, request_type, created_at FROM qr_service_requests WHERE business_id = ? AND id > ? ORDER BY id LIMIT 101"
  ).bind(businessId, afterId).all()).results || [] : [];
  const requests = rows.slice(0, 100);
  const cursorId = rows.length > 100 ? Number(requests.at(-1)?.id || afterId || 0) : latestId;
  const publication = await env.DB.prepare(
    "SELECT s.outlet_open, s.hours_enabled, s.open_time, s.close_time, b.business_name " +
    "FROM public_menu_settings s LEFT JOIN businesses b ON b.id = s.business_id WHERE s.business_id = ? LIMIT 1"
  ).bind(businessId).first();
  const ordering = qrOrderingState(publication || {}, publication?.business_name);
  return json({ latestId, cursorId, requests, orderingOpen: ordering.orderingOpen });
}

function newPublicMenuToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function validPublicMenuTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

async function handlePublicMenuSettings(request, env, businessId, path) {
  const categoryOrderPath = path === "/v1/pos/menu/public-settings/category-order";
  const qrPath = path === "/v1/pos/menu/public-settings/qr";
  if (request.method === "GET" && !categoryOrderPath && !qrPath) {
    let row = await env.DB.prepare("SELECT * FROM public_menu_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
    if (!row) {
      await env.DB.prepare("INSERT INTO public_menu_settings (business_id, token) VALUES (?, ?) ON CONFLICT(business_id) DO NOTHING")
        .bind(businessId, newPublicMenuToken()).run();
      row = await env.DB.prepare("SELECT * FROM public_menu_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
    }
    const settingsRow = await env.DB.prepare("SELECT settings FROM app_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
    const settings = parseJsonField(settingsRow?.settings, {});
    const channels = normalizePosChannels(settings).filter((channel) => channel.qrMenu);
    const priceChannel = channels.find((channel) => channel.key === row?.price_channel)?.key || channels.find((channel) => channel.key === "online")?.key || channels[0]?.key || "online";
    return json({
      enabled: Boolean(row?.enabled), outletOpen: row?.outlet_open !== 0 && row?.outlet_open !== false,
      hoursEnabled: Boolean(row?.hours_enabled), openTime: validPublicMenuTime(row?.open_time) ? row.open_time : "09:00",
      closeTime: validPublicMenuTime(row?.close_time) ? row.close_time : "22:00", priceChannel,
      priceChannelLabel: channels.find((channel) => channel.key === priceChannel)?.label || "Slash",
      qrMenuChannels: channels, token: row?.token || "", publicBaseUrl: row?.public_base_url || "",
      categoryOrder: parseJsonField(row?.category_order, []),
      heroImages: Array.isArray(settings.publicMenuHeroImages) ? settings.publicMenuHeroImages : [],
    });
  }

  if (request.method === "PUT" && categoryOrderPath) {
    try {
      const body = await request.json();
      const requested = body?.categoryOrder;
      if (!Array.isArray(requested) || requested.length > 300) return json({ error: "Choose a valid QR menu category order." }, 400);
      const categories = await env.DB.prepare("SELECT name FROM menu_categories WHERE business_id = ? AND active = 1 ORDER BY sort_order, name, id").bind(businessId).all();
      const available = new Map((categories.results || []).map((row) => [String(row.name || "").trim().toLocaleLowerCase(), String(row.name || "").trim()]));
      const seen = new Set();
      const categoryOrder = [];
      for (const value of requested) {
        const key = String(value || "").trim().toLocaleLowerCase();
        const canonical = available.get(key);
        if (!canonical) return json({ error: `“${String(value || "").slice(0, 100)}” is not an active menu category.` }, 400);
        if (seen.has(key)) return json({ error: `“${canonical}” appears more than once in the category order.` }, 400);
        seen.add(key); categoryOrder.push(canonical);
      }
      for (const [key, name] of available) if (!seen.has(key)) categoryOrder.push(name);
      let current = await env.DB.prepare("SELECT token FROM public_menu_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
      const token = current?.token || newPublicMenuToken();
      await env.DB.prepare(
        "INSERT INTO public_menu_settings (business_id, token, category_order) VALUES (?, ?, ?) " +
        "ON CONFLICT(business_id) DO UPDATE SET category_order = excluded.category_order, updated_at = CURRENT_TIMESTAMP"
      ).bind(businessId, token, JSON.stringify(categoryOrder)).run();
      return json({ success: true, categoryOrder });
    } catch {
      return json({ error: "Could not save the QR menu category order." }, 400);
    }
  }

  if (request.method === "PUT" && !categoryOrderPath && !qrPath) {
    try {
      const raw = await request.text();
      if (raw.length > 2_000_000) return json({ error: "QR menu settings request is too large." }, 413);
      const body = JSON.parse(raw || "{}");
      const enabled = body.enabled === true;
      const priceChannel = String(body.priceChannel || "online").trim().toLowerCase();
      const outletOpen = body.outletOpen !== false;
      const hoursEnabled = body.hoursEnabled === true;
      const openTime = String(body.openTime || "09:00").trim();
      const closeTime = String(body.closeTime || "22:00").trim();
      if (!validPublicMenuTime(openTime) || !validPublicMenuTime(closeTime)) return json({ error: "Choose valid QR menu operating hours." }, 400);
      const settingsRow = await env.DB.prepare("SELECT settings FROM app_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
      const appSettings = parseJsonField(settingsRow?.settings, {});
      const qrMenuChannels = normalizePosChannels(appSettings).filter((channel) => channel.qrMenu);
      if (!qrMenuChannels.some((channel) => channel.key === priceChannel)) return json({ error: "Choose an active QR Menu sale channel." }, 400);
      const hasPublicBaseUrl = Object.prototype.hasOwnProperty.call(body, "publicBaseUrl");
      let publicBaseUrl = null;
      if (hasPublicBaseUrl) {
        const rawBaseUrl = String(body.publicBaseUrl || "").trim();
        if (rawBaseUrl) {
          let parsed;
          try { parsed = new URL(rawBaseUrl); } catch { return json({ error: "Enter a valid website address, such as https://your-cafe-domain.com" }, 400); }
          if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
            return json({ error: "Enter only the website address, such as https://your-cafe-domain.com" }, 400);
          }
          publicBaseUrl = parsed.origin;
        }
      }
      const hasHeroImages = Object.prototype.hasOwnProperty.call(body, "heroImages");
      let heroImages;
      if (hasHeroImages) {
        if (!Array.isArray(body.heroImages) || body.heroImages.length > 6) return json({ error: "Add up to 6 QR menu hero images." }, 400);
        heroImages = [];
        for (const value of body.heroImages) {
          const image = String(value || "");
          const match = image.match(/^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
          if (!match) return json({ error: "Choose JPG, PNG or WebP images for the QR menu hero." }, 400);
          if (atob(match[1]).length > 200 * 1024) return json({ error: "Each QR menu hero image must be 200 KB or smaller after compression." }, 413);
          heroImages.push(image);
        }
      }
      const current = await env.DB.prepare("SELECT token FROM public_menu_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
      const token = current?.token || newPublicMenuToken();
      const statements = [env.DB.prepare(
        "INSERT INTO public_menu_settings (business_id, token, enabled, price_channel, public_base_url, outlet_open, hours_enabled, open_time, close_time) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(business_id) DO UPDATE SET enabled = excluded.enabled, price_channel = excluded.price_channel, " +
        "public_base_url = CASE WHEN ? = 1 THEN excluded.public_base_url ELSE public_menu_settings.public_base_url END, " +
        "outlet_open = excluded.outlet_open, hours_enabled = excluded.hours_enabled, open_time = excluded.open_time, close_time = excluded.close_time, updated_at = CURRENT_TIMESTAMP"
      ).bind(businessId, token, enabled ? 1 : 0, priceChannel, hasPublicBaseUrl ? publicBaseUrl : null, outletOpen ? 1 : 0, hoursEnabled ? 1 : 0, openTime, closeTime, hasPublicBaseUrl ? 1 : 0)];
      if (hasHeroImages) statements.push(env.DB.prepare(
        "INSERT INTO app_settings (business_id, settings, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) " +
        "ON CONFLICT(business_id) DO UPDATE SET settings = json_patch(COALESCE(app_settings.settings, '{}'), excluded.settings), updated_at = CURRENT_TIMESTAMP"
      ).bind(businessId, JSON.stringify({ publicMenuHeroImages: heroImages })));
      await env.DB.batch(statements);
      const saved = await env.DB.prepare("SELECT token, public_base_url FROM public_menu_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
      return json({ success: true, enabled, outletOpen, hoursEnabled, openTime, closeTime, priceChannel,
        priceChannelLabel: qrMenuChannels.find((channel) => channel.key === priceChannel)?.label || "Slash",
        qrMenuChannels, token: saved?.token || token, publicBaseUrl: saved?.public_base_url || "" });
    } catch (error) {
      return json({ error: Number(error?.status) ? error.message : "Could not save restaurant menu settings." }, Number(error?.status) || 400);
    }
  }

  if (request.method === "POST" && qrPath) {
    try {
      const body = await request.json();
      const targetUrl = new URL(String(body?.url || ""));
      const row = await env.DB.prepare("SELECT token FROM public_menu_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
      if (!row?.token) return json({ error: "Guest menu link not found" }, 404);
      const entries = [...targetUrl.searchParams.entries()];
      if (!["http:", "https:"].includes(targetUrl.protocol) || targetUrl.username || targetUrl.password || targetUrl.hash || targetUrl.pathname !== `/restaurant/${row.token}` || entries.length > 1 || entries.some(([key, value]) => key !== "table" || !value.trim() || value.length > 60 || /[\u0000-\u001f\u007f]/.test(value))) {
        return json({ error: "Choose the guest menu link for this POS account" }, 400);
      }
      if (entries.length) {
        const table = await env.DB.prepare("SELECT id FROM restaurant_tables WHERE business_id = ? AND CAST(table_number AS TEXT) = ? LIMIT 1").bind(businessId, entries[0][1].trim()).first();
        if (!table) return json({ error: "Choose a table configured in this POS account" }, 400);
      }
      return json({ token: row.token });
    } catch {
      return json({ error: "The guest menu link is not valid" }, 400);
    }
  }

  return json({ error: "Method not allowed" }, 405, { Allow: "GET, PUT, POST" });
}

async function publicMenuLicenseEnabled(env, businessId) {
  const row = await env.DB.prepare(
    "SELECT add_on FROM business_licenses WHERE business_id = ? AND status = 'active' " +
    "AND datetime(CASE WHEN substr(starts_at, -3, 1) IN ('+', '-') AND substr(starts_at, -2, 2) NOT GLOB '*[^0-9]*' THEN substr(starts_at, 1, length(starts_at) - 3) || substr(starts_at, -3, 3) || ':00' ELSE starts_at END) <= datetime('now') AND datetime(CASE WHEN substr(expires_at, -3, 1) IN ('+', '-') AND substr(expires_at, -2, 2) NOT GLOB '*[^0-9]*' THEN substr(expires_at, 1, length(expires_at) - 3) || substr(expires_at, -3, 3) || ':00' ELSE expires_at END) >= datetime('now') " +
    "ORDER BY created_at DESC, id DESC LIMIT 1"
  ).bind(businessId).first();
  if (!row) return false;
  let addOns = parseJsonField(row.add_on, null);
  if (!Array.isArray(addOns)) addOns = String(row.add_on || "").split(/[;,]/);
  return addOns.some((value) => String(value || "").trim().toLowerCase() === "table qr");
}

async function publicMenuMarketingEnabled(env, businessId) {
  const row = await env.DB.prepare(
    "SELECT add_on FROM business_licenses WHERE business_id = ? AND status = 'active' " +
    "AND datetime(CASE WHEN substr(starts_at, -3, 1) IN ('+', '-') AND substr(starts_at, -2, 2) NOT GLOB '*[^0-9]*' THEN substr(starts_at, 1, length(starts_at) - 3) || substr(starts_at, -3, 3) || ':00' ELSE starts_at END) <= datetime('now') AND datetime(CASE WHEN substr(expires_at, -3, 1) IN ('+', '-') AND substr(expires_at, -2, 2) NOT GLOB '*[^0-9]*' THEN substr(expires_at, 1, length(expires_at) - 3) || substr(expires_at, -3, 3) || ':00' ELSE expires_at END) >= datetime('now') " +
    "ORDER BY created_at DESC, id DESC LIMIT 1"
  ).bind(businessId).first();
  if (!row) return false;
  let addOns = parseJsonField(row.add_on, null);
  if (!Array.isArray(addOns)) addOns = String(row.add_on || "").split(/[;,]/);
  return addOns.some((value) => String(value || "").trim().toLowerCase() === "marketing");
}

function qrPublicOptionSets(settings, ids) {
  const sets = Array.isArray(settings?.menuOptionSets) ? settings.menuOptionSets : [];
  const byId = new Map(sets.map((set) => [String(set?.id), set]));
  return (Array.isArray(ids) ? ids : []).map((id) => byId.get(String(id))).filter(Boolean).map((set) => ({
    id: String(set.id), name: String(set.name || "Options"), minSelections: Math.max(0, Number(set.minSelections) || 0),
    maxSelections: Math.max(1, Number(set.maxSelections) || 1),
    options: (Array.isArray(set.options) ? set.options : []).map((option) => ({
      id: String(option.id), name: String(option.name || "Choice"), price: Math.max(0, Number(option.price) || 0),
    })),
  }));
}

function qrPublicPromotions(settings, channelKey) {
  return (Array.isArray(settings?.marketingDeals) ? settings.marketingDeals : []).filter((deal) => {
    const channels = Array.isArray(deal?.channels) ? deal.channels.map((value) => String(value).toLowerCase().replace(/[\s-]+/g, "_")) : [];
    return String(deal?.id || "").trim() && deal?.active !== false && (!channels.length || channels.includes(String(channelKey).toLowerCase()));
  }).map((deal) => ({
    id: `marketing:${String(deal.id)}`, source: "marketing", sourceId: String(deal.id),
    name: String(deal.name || "QR Menu offer").slice(0, 120), description: String(deal.description || "").slice(0, 240),
    type: String(deal.type || "Deal").slice(0, 80), valueType: String(deal.valueType || "amount"),
    value: Number.isFinite(Number(deal.value)) ? Number(deal.value) : 0,
    bundlePrice: Number.isFinite(Number(deal.bundlePrice)) && Number(deal.bundlePrice) > 0 ? Number(deal.bundlePrice) : null,
    buyQuantity: Math.max(1, Number(deal.buyQuantity) || 1), getQuantity: Math.max(1, Number(deal.getQuantity) || 1),
    rewardItemName: String(deal.rewardItemName || "").slice(0, 120), category: String(deal.category || ""),
    categories: Array.isArray(deal.categories) ? deal.categories.map((value) => String(value || "").slice(0, 120)) : [],
    itemId: deal.itemId || null, itemIds: Array.isArray(deal.itemIds) ? deal.itemIds.map(String) : [],
    startDate: deal.startDate || null, endDate: deal.endDate || null,
    days: Array.isArray(deal.days) ? deal.days.map((day) => String(day).toLowerCase()) : [],
    startTime: deal.startTime || null, endTime: deal.endTime || null,
  }));
}

async function handlePublicMenuRequest(request, env, token, suffix = "") {
  const headers = { "X-D1-Staging-Token": "known" };
  if (!/^[a-f0-9]{48}$/i.test(token)) return json({ error: "Menu not found" }, 404);
  const publication = await env.DB.prepare(
    "SELECT s.business_id, s.enabled, s.price_channel, s.category_order, s.outlet_open, s.hours_enabled, s.open_time, s.close_time, " +
    "b.business_name FROM public_menu_settings s JOIN businesses b ON b.id = s.business_id WHERE s.token = ? LIMIT 1"
  ).bind(token).first();
  if (!publication) return json({ error: "Menu not found" }, 404);
  const businessId = Number(publication.business_id);
  if (!(await isBusinessEnabled(env, businessId))) return json({ error: "Menu not found" }, 404, headers);
  if (!Boolean(publication.enabled) || !(await publicMenuLicenseEnabled(env, businessId))) return json({ error: "This QR menu is not currently available" }, 404, headers);

  if (suffix === "route-status" && request.method === "GET") return new Response(null, { status: 204, headers });

  if (suffix === "manifest" && request.method === "GET") {
    const name = String(publication.business_name || "Cafe & Restaurant").slice(0, 80);
    return json({
      id: `/restaurant/${token}`,
      name: `${name} · Slash QR Menu`,
      short_name: name.slice(0, 30),
      description: `Browse the menu at ${name}, powered by Slash.`,
      start_url: `/restaurant/${token}`,
      scope: "/",
      display: "standalone",
      background_color: "#f5f3ec",
      theme_color: "#25222f",
      icons: [
        { src: "/qr-menu-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/qr-menu-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        { src: "/qr-menu-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      ],
    }, 200, { ...headers, "Cache-Control": "public, max-age=0, must-revalidate" });
  }

  if (suffix === "push-config" && request.method === "GET") {
    return json({ marketingEnabled: await publicMenuMarketingEnabled(env, businessId) }, 200, headers);
  }

  if (suffix === "push-subscriptions" && request.method === "POST") {
    if (!(await publicMenuMarketingEnabled(env, businessId))) return json({ error: "Promotional messages are not enabled for this cafe" }, 403, headers);
    try {
      const raw = await request.text();
      if (raw.length > 16384) return json({ error: "Invalid push subscription" }, 400, headers);
      const body = JSON.parse(raw || "{}");
      const subscription = body.subscription;
      const endpoint = String(subscription?.endpoint || "");
      let endpointUrl;
      try { endpointUrl = new URL(endpoint); } catch { return json({ error: "Invalid push subscription" }, 400, headers); }
      const host = endpointUrl.hostname.toLowerCase();
      const allowedHost = host === "fcm.googleapis.com" || host.endsWith(".fcm.googleapis.com")
        || host === "updates.push.services.mozilla.com" || host.endsWith(".push.services.mozilla.com")
        || host === "web.push.apple.com" || host.endsWith(".web.push.apple.com") || host.endsWith(".notify.windows.com");
      if (endpointUrl.protocol !== "https:" || !allowedHost || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        return json({ error: "Invalid push subscription" }, 400, headers);
      }
      await env.DB.prepare(
        "INSERT INTO public_menu_push_subscriptions (business_id, endpoint, subscription) VALUES (?, ?, ?) " +
        "ON CONFLICT(business_id, endpoint) DO UPDATE SET subscription = excluded.subscription, updated_at = CURRENT_TIMESTAMP"
      ).bind(businessId, endpoint, JSON.stringify(subscription)).run();
      return json({ success: true }, 201, headers);
    } catch {
      return json({ error: "Could not save notification preference" }, 400, headers);
    }
  }

  if (suffix === "orders/statuses" && request.method === "POST") {
    try {
      const raw = await request.text();
      if (raw.length > 16384) return json({ error: "Invalid order status request" }, 400, headers);
      const body = JSON.parse(raw || "{}");
      const submitted = body.orders;
      if (!Array.isArray(submitted) || submitted.length > 30) return json({ error: "Invalid order status request" }, 400, headers);
      const orders = [];
      for (const item of submitted) {
        const orderId = Number(item?.orderId);
        const trackingToken = String(item?.trackingToken || "");
        if (!Number.isSafeInteger(orderId) || orderId <= 0 || !/^[a-f0-9]{48}$/i.test(trackingToken)) return json({ error: "Invalid order status request" }, 400, headers);
        orders.push({ orderId, trackingToken });
      }
      if (!orders.length) return json({ orders: [] }, 200, headers);
      const clauses = orders.map(() => "(id = ? AND public_tracking_token = ?)").join(" OR ");
      const binds = orders.flatMap((order) => [order.orderId, order.trackingToken]);
      const result = await env.DB.prepare(
        "SELECT id, order_number, order_type, table_number, status, total, created_at FROM orders " +
        "WHERE business_id = ? AND (" + clauses + ") ORDER BY created_at DESC, id DESC"
      ).bind(businessId, ...binds).all();
      return json({ orders: result.results || [] }, 200, headers);
    } catch {
      return json({ error: "Could not refresh order statuses" }, 400, headers);
    }
  }

  if (suffix === "orders" && request.method === "POST") {
    try {
      const raw = await request.text();
      if (raw.length > 65536) return json({ error: "Invalid order request" }, 400, headers);
      const body = JSON.parse(raw || "{}");
      const url = new URL(request.url);
      const result = await createPublicQrOrder(env, businessId, token, {
        ...body,
        linkTableNumber: String(url.searchParams.get("table") || "").trim(),
      });
      const status = Number(result?.status) || 200;
      const { status: _status, ...payload } = result || {};
      return json(payload, status, headers);
    } catch {
      return json({ error: "Could not place the QR order." }, 400, headers);
    }
  }

  const publicOrderMatch = suffix.match(/^orders\/(\d+)$/);
  if (publicOrderMatch && request.method === "GET") {
    const orderId = Number(publicOrderMatch[1]);
    const trackingToken = String(new URL(request.url).searchParams.get("tracking") || "");
    if (!Number.isSafeInteger(orderId) || orderId <= 0 || !/^[a-f0-9]{48}$/i.test(trackingToken)) return json({ error: "Order not found" }, 404, headers);
    const order = await env.DB.prepare(
      "SELECT o.id, o.order_number, o.order_type, o.table_number, o.status, o.subtotal, o.gst, o.total, o.created_at, " +
      "COALESCE(paid.amount_collected, 0) AS amount_collected, MAX(o.total - COALESCE(paid.amount_collected, 0), 0) AS amount_due, " +
      "CASE WHEN COALESCE(paid.amount_collected, 0) >= o.total THEN 1 ELSE 0 END AS is_paid " +
      "FROM orders o LEFT JOIN (SELECT order_id, business_id, SUM(amount) AS amount_collected FROM payments WHERE payment_status = 'Success' GROUP BY order_id, business_id) paid " +
      "ON paid.order_id = o.id AND paid.business_id = o.business_id " +
      "WHERE o.business_id = ? AND o.id = ? AND o.public_tracking_token = ? LIMIT 1"
    ).bind(businessId, orderId, trackingToken).first();
    if (!order) return json({ error: "Order not found" }, 404, headers);
    const items = await env.DB.prepare("SELECT item_name, quantity, price, line_total, options FROM order_items WHERE business_id = ? AND order_id = ? ORDER BY id").bind(businessId, orderId).all();
    return json({ order: { ...order, is_paid: Boolean(order.is_paid), items: (items.results || []).map((item) => ({ ...item, options: parseJsonField(item.options, []) })) } }, 200, headers);
  }

  if (suffix === "analytics" && request.method === "POST") {
    try {
      const body = await request.json();
      const sessionId = String(body?.sessionId || "").trim();
      const eventType = String(body?.eventType || "").trim();
      if (!/^[a-f0-9]{32,64}$/i.test(sessionId) || !["menu_view", "cart_updated", "checkout_started"].includes(eventType)) return json({ error: "Invalid menu analytics event" }, 400, headers);
      const itemCount = eventType === "cart_updated" ? Math.max(0, Math.min(100, Math.floor(Number(body.itemCount) || 0))) : 0;
      const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${businessId}:${token}:${sessionId}`));
      const sessionKey = Array.from(new Uint8Array(keyBytes), (value) => value.toString(16).padStart(2, "0")).join("");
      await env.DB.prepare("INSERT INTO qr_menu_events (business_id, session_key, event_type, item_count) VALUES (?, ?, ?, ?)").bind(businessId, sessionKey, eventType, itemCount).run();
      return new Response(null, { status: 204, headers: { ...headers, "Cache-Control": "no-store" } });
    } catch {
      return json({ error: "Could not record menu activity" }, 400, headers);
    }
  }

  if (suffix === "service-requests" && request.method === "POST") {
    try {
      const body = await request.json();
      const tableNumber = String(body?.tableNumber || "").trim();
      const requestType = String(body?.requestType || "").trim();
      if (!tableNumber || tableNumber.length > 60 || !["clean_table", "call_waiter"].includes(requestType)) return json({ error: "Choose a valid table and service request." }, 400, headers);
      const table = await env.DB.prepare("SELECT table_number FROM restaurant_tables WHERE business_id = ? AND CAST(table_number AS TEXT) = ? LIMIT 1").bind(businessId, tableNumber).first();
      if (!table) return json({ error: "This table QR is no longer active. Please ask the team for help." }, 409, headers);
      const result = await env.DB.prepare(
        "INSERT INTO qr_service_requests (business_id, table_number, request_type) VALUES (?, ?, ?) RETURNING id, table_number, request_type, status, created_at"
      ).bind(businessId, String(table.table_number), requestType).first();
      return json({ success: true, request: result }, 201, headers);
    } catch {
      return json({ error: "Could not notify the cafe team" }, 400, headers);
    }
  }

  if (!suffix && request.method === "GET") {
    const [business, settingsRow, categoriesResult, menuResult, variantsResult, tablesResult] = await Promise.all([
      env.DB.prepare("SELECT business_name, logo_url, currency FROM businesses WHERE id = ? LIMIT 1").bind(businessId).first(),
      env.DB.prepare("SELECT settings FROM app_settings WHERE business_id = ? LIMIT 1").bind(businessId).first(),
      env.DB.prepare("SELECT id, name, image_url FROM menu_categories WHERE business_id = ? AND active = 1 ORDER BY sort_order, name, id").bind(businessId).all(),
      env.DB.prepare("SELECT id, name, description, tags, category, price, channel_prices, sales_channels, image_url, qr_available, tax_rate, tax_mode, option_set_ids FROM menu WHERE business_id = ? AND available = 1 ORDER BY category, name, id").bind(businessId).all(),
      env.DB.prepare("SELECT id, menu_id, name, price, unit, channel_prices, option_set_ids FROM menu_variants WHERE business_id = ? AND available = 1 ORDER BY menu_id, id").bind(businessId).all(),
      env.DB.prepare("SELECT table_number FROM restaurant_tables WHERE business_id = ? ORDER BY table_number").bind(businessId).all(),
    ]);
    const settings = parseJsonField(settingsRow?.settings, {});
    const categories = categoriesResult.results || [];
    const categoryByKey = new Map(categories.map((row) => [String(row.name || "").toLocaleLowerCase(), row]));
    const order = parseJsonField(publication.category_order, []);
    const orderedNames = (Array.isArray(order) ? order : []).map((name) => categoryByKey.get(String(name || "").trim().toLocaleLowerCase())?.name).filter(Boolean);
    for (const row of categories) if (!orderedNames.some((name) => String(name).toLocaleLowerCase() === String(row.name).toLocaleLowerCase())) orderedNames.push(row.name);
    const channels = normalizePosChannels(settings).filter((channel) => channel.qrMenu);
    const priceChannel = channels.find((channel) => channel.key === publication.price_channel)?.key || channels.find((channel) => channel.key === "online")?.key || channels[0]?.key || "online";
    const itemById = new Map();
    const items = (menuResult.results || []).flatMap((row) => {
      const availableChannels = parseJsonField(row.sales_channels, null);
      if (Array.isArray(availableChannels) && !availableChannels.map(String).includes(priceChannel)) return [];
      const prices = parseJsonField(row.channel_prices, {});
      const optionSets = qrPublicOptionSets(settings, parseJsonField(row.option_set_ids, []));
      const item = { id: String(row.id), name: row.name, description: String(row.description || ""), tags: parseJsonField(row.tags, []),
        category: row.category || "Menu", price: Number(prices?.[priceChannel] ?? row.price ?? 0), imageUrl: row.image_url || "",
        inStock: row.qr_available !== 0 && row.qr_available !== false, taxRate: Number(row.tax_rate || 0),
        taxMode: row.tax_mode === "inclusive" ? "inclusive" : "exclusive", optionSets, variants: [] };
      itemById.set(Number(row.id), item);
      return [item];
    });
    for (const row of variantsResult.results || []) {
      const item = itemById.get(Number(row.menu_id));
      if (!item) continue;
      const prices = parseJsonField(row.channel_prices, {});
      const ownSets = parseJsonField(row.option_set_ids, []);
      const mergedIds = [...new Set([...(item.optionSets || []).map((set) => String(set.id)), ...(Array.isArray(ownSets) ? ownSets.map(String) : [])])];
      item.variants.push({ id: String(row.id), name: row.name, unit: row.unit || "", price: Number(prices?.[priceChannel] ?? row.price ?? item.price), optionSets: qrPublicOptionSets(settings, mergedIds) });
    }
    let heroImages = Array.isArray(settings.publicMenuHeroImages) ? settings.publicMenuHeroImages.filter((image) => typeof image === "string" && image.startsWith("data:image/")) : [];
    heroImages = heroImages.slice(0, 6);
    const ordering = qrOrderingState(publication, settings.restaurantName || business?.business_name);
    return json({
      restaurantName: String(settings.restaurantName || business?.business_name || "Cafe & Restaurant"),
      logoUrl: String(business?.logo_url || settings.logoUrl || ""), heroImages,
      currency: String(settings.currency || business?.currency || "₹"), priceChannel,
      priceChannelLabel: channels.find((channel) => channel.key === priceChannel)?.label || "Slash",
      gstCalculationEnabled: settings.gstCalculationEnabled !== false,
      onlinePromotions: qrPublicPromotions(settings, priceChannel),
      categories: orderedNames.map((name) => ({ name, imageUrl: String(categoryByKey.get(String(name).toLocaleLowerCase())?.image_url || "") })),
      items, ...ordering, tables: (tablesResult.results || []).map((row) => String(row.table_number)),
    }, 200, headers);
  }
  return json({ error: "Not found" }, 404, headers);
}

function normalizeLoyaltySettings(row) {
  return row ? { ...row, enabled: Boolean(row.enabled) } : {
    points_per_currency: 1, currency_per_point: 1, min_redeem_points: 100, welcome_points: 0, enabled: true,
  };
}

async function handleLoyalty(request, env, businessId, path, bridgeClaims) {
  if (path === "/v1/pos/loyalty/settings" && request.method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM loyalty_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
    return json(normalizeLoyaltySettings(row));
  }
  if (path === "/v1/pos/loyalty/settings" && request.method === "PUT") {
    try {
      const body = await request.json();
      const ppc = Number(body.pointsPerCurrency ?? 1);
      const cpp = Number(body.currencyPerPoint ?? 1);
      const min = Math.floor(Number(body.minRedeemPoints ?? 100));
      const welcome = Math.floor(Number(body.welcomePoints ?? 0));
      if (![ppc, cpp, min, welcome].every(Number.isFinite) || ppc < 0 || cpp < 0 || min < 0 || welcome < 0) return json({ error: "Loyalty values must be non-negative numbers." }, 400);
      const row = await env.DB.prepare(
        "INSERT INTO loyalty_settings (business_id, points_per_currency, currency_per_point, min_redeem_points, welcome_points, enabled, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(business_id) DO UPDATE SET " +
        "points_per_currency = excluded.points_per_currency, currency_per_point = excluded.currency_per_point, " +
        "min_redeem_points = excluded.min_redeem_points, welcome_points = excluded.welcome_points, enabled = excluded.enabled, " +
        "updated_at = CURRENT_TIMESTAMP RETURNING *"
      ).bind(businessId, ppc, cpp, min, welcome, body.enabled !== false ? 1 : 0).first();
      return json(normalizeLoyaltySettings(row));
    } catch {
      return json({ error: "Failed to save loyalty settings" }, 400);
    }
  }
  const customerMatch = path.match(/^\/v1\/pos\/loyalty\/customers\/(\d+)$/);
  if (customerMatch && request.method === "GET") {
    const customerId = Number(customerMatch[1]);
    if (!Number.isSafeInteger(customerId) || customerId <= 0) return json({ error: "Invalid customer ID" }, 400);
    const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ? AND business_id = ? LIMIT 1").bind(customerId, businessId).first();
    if (!customer) return json({ error: "Customer not found" }, 404);
    const balance = await env.DB.prepare("SELECT COALESCE(SUM(points), 0) AS points FROM loyalty_transactions WHERE customer_id = ? AND business_id = ?").bind(customerId, businessId).first();
    const history = await env.DB.prepare("SELECT * FROM loyalty_transactions WHERE customer_id = ? AND business_id = ? ORDER BY created_at DESC LIMIT 100").bind(customerId, businessId).all();
    return json({ customer, balance: Number(balance?.points || 0), history: history.results || [] });
  }
  if (path === "/v1/pos/loyalty/adjust" && request.method === "POST") {
    try {
      const body = await request.json();
      const customerId = Number(body.customerId);
      const points = Math.trunc(Number(body.points || 0));
      if (!Number.isSafeInteger(customerId) || customerId <= 0 || !Number.isSafeInteger(points) || points === 0) return json({ error: "Customer and non-zero points required" }, 400);
      const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ? AND business_id = ? LIMIT 1").bind(customerId, businessId).first();
      if (!customer) return json({ error: "Customer not found" }, 404);
      const row = await env.DB.prepare(
        "INSERT INTO loyalty_transactions (customer_id, points, transaction_type, reference_type, note, business_id) " +
        "VALUES (?, ?, 'Adjustment', 'Manual', ?, ?) RETURNING *"
      ).bind(customerId, points, String(body.note || "Manual adjustment").trim().slice(0, 500), businessId).first();
      return json(row, 201);
    } catch {
      return json({ error: "Failed to adjust loyalty points" }, 400);
    }
  }
  return json({ error: "Not found" }, 404);
}

async function handleExpenses(request, env, businessId, path, bridgeClaims) {
  if (path === "/v1/pos/expenses/categories" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM expense_categories WHERE active = 1 AND business_id = ? ORDER BY name").bind(businessId).all();
    return json(rows.results || []);
  }
  if (path === "/v1/pos/expenses/categories" && request.method === "POST") {
    try {
      const body = await request.json();
      const name = String(body.name || "").trim().slice(0, 120);
      if (!name) return json({ error: "Category name is required" }, 400);
      const row = await env.DB.prepare("INSERT INTO expense_categories (name, business_id) VALUES (?, ?) RETURNING *").bind(name, businessId).first();
      return json({ ...row, active: Boolean(row.active) }, 201);
    } catch (error) {
      return json({ error: String(error?.message || "").includes("UNIQUE constraint") ? "Category already exists" : "Failed to create category" }, String(error?.message || "").includes("UNIQUE constraint") ? 409 : 400);
    }
  }
  if (path === "/v1/pos/expenses" && request.method === "GET") {
    const from = String(new URL(request.url).searchParams.get("from") || "").trim();
    const to = String(new URL(request.url).searchParams.get("to") || "").trim();
    if ([from, to].some((value) => value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) || (from && to && from > to)) return json({ error: "Choose a valid expense date range" }, 400);
    const rows = await env.DB.prepare(
      "SELECT e.*, c.name AS category_name, u.display_name AS created_by_name FROM expenses e " +
      "LEFT JOIN expense_categories c ON c.id = e.category_id AND c.business_id = e.business_id " +
      "LEFT JOIN app_users u ON u.id = e.created_by AND u.business_id = e.business_id " +
      "WHERE e.business_id = ? AND (? = '' OR date(e.expense_date) >= date(?)) AND (? = '' OR date(e.expense_date) <= date(?)) " +
      "ORDER BY e.expense_date DESC, e.id DESC"
    ).bind(businessId, from, from, to, to).all();
    return json(rows.results || []);
  }
  if (path === "/v1/pos/expenses" && request.method === "POST") {
    try {
      const body = await request.json();
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount < 0) return json({ error: "Invalid expense amount" }, 400);
      const categoryId = body.categoryId ? Number(body.categoryId) : null;
      if (categoryId !== null) {
        if (!Number.isSafeInteger(categoryId) || categoryId <= 0) return json({ error: "Invalid expense category" }, 400);
        const category = await env.DB.prepare("SELECT id FROM expense_categories WHERE id = ? AND business_id = ? LIMIT 1").bind(categoryId, businessId).first();
        if (!category) return json({ error: "Expense category not found" }, 404);
      }
      const expenseDate = String(body.expenseDate || "").trim();
      if (expenseDate && !/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) return json({ error: "Invalid expense date" }, 400);
      const row = await env.DB.prepare(
        "INSERT INTO expenses (category_id, amount, payment_method, expense_date, note, created_by, business_id) " +
        "VALUES (?, ?, ?, COALESCE(?, date(datetime('now', '+05:30'))), ?, ?, ?) RETURNING *"
      ).bind(categoryId, amount, String(body.paymentMethod || "Cash").trim().slice(0, 60) || "Cash", expenseDate || null,
        body.note ? String(body.note).slice(0, 1000) : null, Number(bridgeClaims?.sub) || null, businessId).first();
      return json({ success: true, expense: row }, 201);
    } catch {
      return json({ error: "Failed to save expense" }, 400);
    }
  }
  const expenseIdMatch = path.match(/^\/v1\/pos\/expenses\/(\d+)$/);
  if (expenseIdMatch && request.method === "DELETE") {
    const id = Number(expenseIdMatch[1]);
    if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "Invalid expense ID" }, 400);
    await env.DB.prepare("DELETE FROM expenses WHERE id = ? AND business_id = ?").bind(id, businessId).run();
    return json({ success: true });
  }
  if (path === "/v1/pos/expenses/summary" && request.method === "GET") {
    const url = new URL(request.url);
    const from = String(url.searchParams.get("from") || "").trim();
    const to = String(url.searchParams.get("to") || "").trim();
    if ([from, to].some((value) => value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) || (from && to && from > to)) return json({ error: "Choose a valid expense date range" }, 400);
    const total = await env.DB.prepare(
      "SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM expenses WHERE business_id = ? " +
      "AND (? = '' OR date(expense_date) >= date(?)) AND (? = '' OR date(expense_date) <= date(?))"
    ).bind(businessId, from, from, to, to).first();
    const categories = await env.DB.prepare(
      "SELECT COALESCE(c.name, 'Uncategorised') AS category, COALESCE(SUM(e.amount), 0) AS amount FROM expenses e " +
      "LEFT JOIN expense_categories c ON c.id = e.category_id AND c.business_id = e.business_id " +
      "WHERE e.business_id = ? AND (? = '' OR date(e.expense_date) >= date(?)) AND (? = '' OR date(e.expense_date) <= date(?)) " +
      "GROUP BY c.name ORDER BY amount DESC"
    ).bind(businessId, from, from, to, to).all();
    return json({ total, count: Number(total?.count || 0), categories: categories.results || [] });
  }
  return json({ error: "Not found" }, 404);
}

async function handleMarketingDeals(request, env, businessId) {
  if (request.method === "GET") {
    const row = await env.DB.prepare("SELECT settings FROM app_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
    const settings = parseJsonField(row?.settings, {});
    const deals = Array.isArray(settings.marketingDeals) ? settings.marketingDeals : [];
    return json({ deals });
  }
  if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405, { Allow: "GET, PUT" });
  try {
    const raw = await request.text();
    if (raw.length > 65536) return json({ error: "Marketing deal request is too large" }, 413);
    const body = JSON.parse(raw || "{}");
    if (!Array.isArray(body.deals) || body.deals.length > 200) return json({ error: "Deals must be a list of at most 200 entries" }, 400);
    const settingsPatch = JSON.stringify({ marketingDeals: body.deals });
    await env.DB.prepare(
      "INSERT INTO app_settings (business_id, settings, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(business_id) DO UPDATE SET settings = json_patch(COALESCE(app_settings.settings, '{}'), excluded.settings), updated_at = CURRENT_TIMESTAMP"
    ).bind(businessId, settingsPatch).run();
    return json({ success: true, deals: body.deals });
  } catch (error) {
    if (Number(error?.status)) return json({ error: error.message }, Number(error.status));
    return json({ error: "Could not save marketing deals" }, 400);
  }
}

async function handleMarketingPush(request, env, businessId, path, bridgeClaims) {
  if (path === "/v1/pos/marketing/push-settings" && request.method === "GET") {
    const [count, menu] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS count FROM public_menu_push_subscriptions WHERE business_id = ?").bind(businessId).first(),
      env.DB.prepare("SELECT token, enabled FROM public_menu_settings WHERE business_id = ? LIMIT 1").bind(businessId).first(),
    ]);
    return json({ subscriberCount: Number(count?.count || 0), menuEnabled: Boolean(menu?.enabled), menuUrl: menu?.token ? `/restaurant/${menu.token}` : null });
  }
  if (path === "/v1/pos/marketing/push-campaigns" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT id,title,message,target_url,status,subscriber_count,sent_count,failed_count,created_at,sent_at FROM marketing_push_campaigns WHERE business_id = ? ORDER BY created_at DESC,id DESC LIMIT 50").bind(businessId).all();
    return json({ campaigns: rows.results || [] });
  }
  if (path === "/v1/pos/marketing/push-campaigns" && request.method === "POST") {
    try {
      const body = await request.json();
      const title = String(body.title || "").trim().slice(0, 120);
      const message = String(body.message || "").trim().slice(0, 500);
      if (!title || !message) return json({ error: "Add a title and message" }, 400);
      const menu = await env.DB.prepare("SELECT token,enabled FROM public_menu_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
      if (!menu?.enabled || !menu?.token) return json({ error: "Publish the Table QR Menu before sending a promotion" }, 400);
      const subscriberCount = Number((await env.DB.prepare("SELECT COUNT(*) AS count FROM public_menu_push_subscriptions WHERE business_id = ?").bind(businessId).first())?.count || 0);
      const campaign = await env.DB.prepare(
        "INSERT INTO marketing_push_campaigns (business_id,title,message,target_url,status,subscriber_count,created_by) VALUES (?,?,?,?,'sending',?,?) RETURNING id,title,message,target_url,status,subscriber_count,sent_count,failed_count,created_at,sent_at"
      ).bind(businessId,title,message,`/restaurant/${menu.token}`,subscriberCount,Number(bridgeClaims?.sub)||null).first();
      return json({ campaign, targetUrl: `/restaurant/${menu.token}` }, 201);
    } catch {
      return json({ error: "Could not create notification campaign" }, 400);
    }
  }
  if (path === "/v1/pos/marketing/push-subscriptions" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT id,endpoint,subscription FROM public_menu_push_subscriptions WHERE business_id = ? ORDER BY id").bind(businessId).all();
    return json({ subscriptions: (rows.results || []).map((row) => ({ ...row, subscription: parseJsonField(row.subscription, {}) })) });
  }
  if (path === "/v1/pos/marketing/push-subscriptions/expired" && request.method === "DELETE") {
    try {
      const body = await request.json();
      const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 500);
      if (!ids.length) return json({ success: true, deleted: 0 });
      const result = await env.DB.prepare("DELETE FROM public_menu_push_subscriptions WHERE business_id = ? AND id IN (" + ids.map(() => "?").join(",") + ")")
        .bind(businessId, ...ids).run();
      return json({ success: true, deleted: Number(result.meta?.changes || 0) });
    } catch {
      return json({ error: "Could not remove expired subscribers" }, 400);
    }
  }
  const finalizeMatch = path.match(/^\/v1\/pos\/marketing\/push-campaigns\/(\d+)\/finalize$/);
  if (finalizeMatch && request.method === "PUT") {
    try {
      const id = Number(finalizeMatch[1]);
      const body = await request.json();
      const status = String(body.status || "");
      const sent = Math.max(0, Math.floor(Number(body.sentCount) || 0));
      const failed = Math.max(0, Math.floor(Number(body.failedCount) || 0));
      if (!["sent", "partial", "failed"].includes(status) || sent + failed > 1000000) return json({ error: "Invalid campaign result" }, 400);
      const row = await env.DB.prepare(
        "UPDATE marketing_push_campaigns SET status = ?,sent_count = ?,failed_count = ?,sent_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ? AND status = 'sending' RETURNING id,title,message,target_url,status,subscriber_count,sent_count,failed_count,created_at,sent_at"
      ).bind(status,sent,failed,id,businessId).first();
      return row ? json({ campaign: row }) : json({ error: "Notification campaign not found" }, 404);
    } catch {
      return json({ error: "Could not save campaign delivery result" }, 400);
    }
  }
  const campaignMatch = path.match(/^\/v1\/pos\/marketing\/push-campaigns\/(\d+)$/);
  if (campaignMatch && request.method === "DELETE") {
    const row = await env.DB.prepare("DELETE FROM marketing_push_campaigns WHERE id = ? AND business_id = ? RETURNING id").bind(Number(campaignMatch[1]),businessId).first();
    return row ? json({ success: true }) : json({ error: "Notification message not found" }, 404);
  }
  return json({ error: "Not found" }, 404);
}

async function handleBillingAdjustments(request, env, businessId, path) {
  const adjustmentMatch = path.match(/^\/v1\/pos\/billing-adjustments(?:\/(\d+)(?:\/(toggle))?)?$/);
  if (!adjustmentMatch) return json({ error: "Not found" }, 404);
  const id = adjustmentMatch[1] ? Number(adjustmentMatch[1]) : null;
  const toggle = adjustmentMatch[2] === "toggle";
  if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) return json({ error: "Invalid adjustment ID" }, 400);
  if (request.method === "GET" && id === null) {
    const result = await env.DB.prepare(
      "SELECT * FROM billing_adjustments WHERE business_id = ? ORDER BY active DESC, name ASC, id ASC"
    ).bind(businessId).all();
    return json((result.results || []).map(normalizeBillingAdjustment));
  }
  if (request.method === "POST" && id === null) {
    try {
      const raw = await request.text();
      if (raw.length > 16384) return json({ error: "Billing adjustment request is too large" }, 413);
      const body = JSON.parse(raw || "{}");
      const validated = await validateBillingAdjustment(body, env, businessId);
      const row = await env.DB.prepare(
        "INSERT INTO billing_adjustments (name, kind, calculation, value, applies_to, description, active, business_id, application_level) " +
        "VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING *"
      ).bind(validated.name, validated.kind, validated.calculation, validated.value, validated.appliesTo, validated.description,
        businessId, validated.applicationLevel).first();
      return json(normalizeBillingAdjustment(row), 201);
    } catch (error) {
      const message = String(error?.message || "");
      if (message.includes("UNIQUE constraint")) return json({ error: "Billing adjustment already exists" }, 409);
      return json({ error: error?.status ? error.message : "Failed to create billing adjustment" }, Number(error?.status) || 400);
    }
  }
  if (request.method === "PUT" && id !== null && toggle) {
    const row = await env.DB.prepare(
      "UPDATE billing_adjustments SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP " +
      "WHERE id = ? AND business_id = ? RETURNING *"
    ).bind(id, businessId).first();
    return row ? json(normalizeBillingAdjustment(row)) : json({ error: "Billing adjustment not found" }, 404);
  }
  if (request.method === "PUT" && id !== null && !toggle) {
    try {
      const raw = await request.text();
      if (raw.length > 16384) return json({ error: "Billing adjustment request is too large" }, 413);
      const body = JSON.parse(raw || "{}");
      const validated = await validateBillingAdjustment(body, env, businessId);
      const row = await env.DB.prepare(
        "UPDATE billing_adjustments SET name = ?, kind = ?, calculation = ?, value = ?, applies_to = ?, description = ?, " +
        "application_level = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ? RETURNING *"
      ).bind(validated.name, validated.kind, validated.calculation, validated.value, validated.appliesTo, validated.description,
        validated.applicationLevel, id, businessId).first();
      return row ? json(normalizeBillingAdjustment(row)) : json({ error: "Billing adjustment not found" }, 404);
    } catch (error) {
      const message = String(error?.message || "");
      if (message.includes("UNIQUE constraint")) return json({ error: "Billing adjustment already exists" }, 409);
      return json({ error: error?.status ? error.message : "Failed to update billing adjustment" }, Number(error?.status) || 400);
    }
  }
  if (request.method === "DELETE" && id !== null && !toggle) {
    const row = await env.DB.prepare("DELETE FROM billing_adjustments WHERE id = ? AND business_id = ? RETURNING id").bind(id, businessId).first();
    return row ? json({ success: true }) : json({ error: "Billing adjustment not found" }, 404);
  }
  return json({ error: "Method not allowed" }, 405, { Allow: id === null ? "GET, POST" : "PUT, DELETE" });
}

async function validateBillingAdjustment(body, env, businessId) {
  const name = String(body.name || "").trim().slice(0, 120);
  const kindInput = String(body.type || body.kind || "discount").toLowerCase();
  const kind = ["discount", "charge"].includes(kindInput) ? kindInput : "discount";
  const applicationLevel = kind === "discount" && String(body.applicationLevel || "order").toLowerCase() === "item" ? "item" : "order";
  const calculationInput = String(body.valueType || body.calculation || "amount").toLowerCase();
  const calculation = calculationInput === "percent" ? "percent" : "fixed";
  const value = Number(body.value);
  const appliesTo = String(body.appliesTo || "all").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const settingsRow = await env.DB.prepare("SELECT settings FROM app_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
  const settings = parseJsonField(settingsRow?.settings, {});
  if (!name) throw Object.assign(new Error("Adjustment name is required"), { status: 400 });
  if (!Number.isFinite(value) || value < 0) throw Object.assign(new Error("Adjustment value must be a valid non-negative number"), { status: 400 });
  if (calculation === "percent" && value > 100) throw Object.assign(new Error("Percentage cannot exceed 100"), { status: 400 });
  if (appliesTo !== "all" && !activeChannels(settings).some((channel) => channel.key === appliesTo)) {
    throw Object.assign(new Error("Choose an active sale channel for this discount or charge"), { status: 400 });
  }
  return { name, kind, calculation, value, appliesTo, description: String(body.description || "").trim().slice(0, 500) || null, applicationLevel };
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "GET" && path === "/health") {
    return json({
      ok: true,
      mode: "D1 staging",
      orderWritePilot: String(env.D1_STAGING_ORDER_WRITES_ENABLED || "").toLowerCase() === "true",
      paymentWritePilot: String(env.D1_STAGING_PAYMENT_WRITES_ENABLED || "").toLowerCase() === "true",
      orderCoordinatorConfigured: Boolean(env.ORDER_COORDINATOR),
    });
  }

  const publicImageMatch = path.match(/^\/images\/(item|category|logo)\/(\d+)\/(\d+)\/([a-f0-9-]{36}\.(?:jpg|png|webp))$/i);
  if (publicImageMatch && request.method === "GET") return serveR2Image(request, env, publicImageMatch);

  if (!env.DB) return json({ error: "D1 database binding is not configured" }, 503);
  const publicMenuMatch = path.match(/^\/public-menu\/([a-f0-9]{48})(?:\/(analytics|manifest|service-requests|route-status|push-config|push-subscriptions|orders|orders\/statuses|orders\/\d+))?$/i);
  if (publicMenuMatch) return handlePublicMenuRequest(request, env, publicMenuMatch[1], publicMenuMatch[2] || "");
  if (!path.startsWith("/v1/")) return json({ error: "Not found" }, 404);
  const directKeyAuthorized = stagingKeyIsValid(request, env);
  const bridgeClaims = directKeyAuthorized ? null : await verifyBridgeToken(request, env);
  if (!directKeyAuthorized && !bridgeClaims) {
    const bridgeConfigured = String(env.D1_STAGING_BRIDGE_SECRET || "").length >= 32;
    const keyConfigured = String(env.STAGING_API_KEY || "").length >= 32;
    if (!bridgeConfigured && !keyConfigured) return json({ error: "Staging API is locked until its secrets are configured" }, 503);
    return json({ error: "Unauthorized" }, 401);
  }
  if (path.startsWith("/v1/auth/public/")) {
    const requiredScope = authPathScope(path, request.method.toUpperCase());
    if (!requiredScope || directKeyAuthorized || !bridgeClaims || bridgeClaims.sub !== 0
      || Number(bridgeClaims.business_id) !== 0 || bridgeClaims.scope !== requiredScope) {
      return json({ error: "Unauthorized public D1 onboarding request" }, 403);
    }
    return handlePublicD1Auth(request, env, bridgeClaims, path, url, allowedBusinesses(env));
  }
  const imageWriteMatch = path.match(/^\/v1\/images\/(item|category|logo)\/(\d+)\/([a-f0-9-]{36}\.(?:jpg|png|webp))$/i);
  if (imageWriteMatch) return handleR2ImageWrite(request, env, bridgeClaims, directKeyAuthorized, url, imageWriteMatch);
  const isOrderCreate = request.method === "POST" && ["/v1/orders", "/v1/pos/orders"].includes(path);
  const authServicePath = path.startsWith("/v1/auth/");
  const authServiceWrite = authServicePath && ["POST", "PATCH", "DELETE"].includes(request.method);
  const staffAccessPath = path === "/v1/pos/access" || path.startsWith("/v1/pos/access/");
  const staffAccessWrite = staffAccessPath && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
  const deviceAdminPath = path === "/v1/pos/devices" || path.startsWith("/v1/pos/devices/") || path === "/v1/pos/license/status";
  const deviceAdminWrite = deviceAdminPath && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
  const orderUpdateMatch = path.match(/^\/v1\/pos\/orders\/(\d+)$/);
  const isOrderUpdate = request.method === "PUT" && Boolean(orderUpdateMatch);
  const orderCompleteMatch = path.match(/^\/v1\/pos\/orders\/(\d+)\/complete$/);
  const isOrderComplete = request.method === "PUT" && Boolean(orderCompleteMatch);
  const settlementMatch = path.match(/^\/v1\/(?:pos\/)?orders\/(\d+)\/settle$/);
  const isSettlement = request.method === "POST" && Boolean(settlementMatch);
  const kotMatch = path.match(/^\/v1\/pos\/orders\/(\d+)\/kot$/);
  const isKotCreate = request.method === "POST" && Boolean(kotMatch);
  const kotTicketsPath = path === "/v1/pos/kot" && request.method === "GET";
  const kotUpdateMatch = path.match(/^\/v1\/pos\/kot\/(\d+)$/);
  const kotUpdate = request.method === "PUT" && Boolean(kotUpdateMatch);
  const cancelMatch = path.match(/^\/v1\/pos\/orders\/(\d+)\/cancel$/);
  const isCancel = request.method === "PUT" && Boolean(cancelMatch);
  const printedMatch = path.match(/^\/v1\/pos\/orders\/(\d+)\/printed$/);
  const isPrinted = request.method === "POST" && Boolean(printedMatch);
  const customerBilling = request.method === "POST" && path === "/v1/pos/customers/billing";
  const customerCreate = request.method === "POST" && path === "/v1/pos/customers";
  const customerUpdateMatch = path.match(/^\/v1\/pos\/customers\/(\d+)$/);
  const customerUpdate = request.method === "PUT" && Boolean(customerUpdateMatch);
  const customerDelete = request.method === "DELETE" && Boolean(customerUpdateMatch);
  const customerActivityMatch = path.match(/^\/v1\/pos\/customers\/(\d+)\/order-activity$/);
  const customerActivity = request.method === "GET" && Boolean(customerActivityMatch);
  const menuImportPath = path === "/v1/pos/menu/import";
  const menuImportWrite = menuImportPath && request.method === "POST";
  const menuItemPath = path === "/v1/pos/menu" || /^\/v1\/pos\/menu\/\d+(?:\/(?:prices|qr-stock|enable|variants))?$/.test(path);
  const menuItemWrite = menuItemPath && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
  const menuItemScope = request.method === "POST" ? "menu.create"
    : request.method === "DELETE" ? "menu.delete"
      : request.method === "GET" ? "menu.view" : "menu.edit";
  const menuImageReferenceMatch = path.match(/^\/v1\/pos\/image-references\/(item|category|logo)\/(\d+)$/);
  const menuImageReferencePath = Boolean(menuImageReferenceMatch);
  const menuImageReferenceWrite = menuImageReferencePath && request.method === "PUT";
  const tablesPath = path === "/v1/pos/tables" || /^\/v1\/pos\/tables\/\d+(?:\/status)?$/.test(path);
  const tablesWrite = tablesPath && ["POST", "PUT", "DELETE"].includes(request.method);
  const tableScope = request.method === "POST" ? "tables.create" : request.method === "DELETE" ? "tables.delete" : request.method === "GET" ? "tables.view" : "tables.edit";
  const printersPath = path === "/v1/pos/printers" || /^\/v1\/pos\/printers\/\d+$/.test(path);
  const printersWrite = printersPath && ["POST", "PUT", "DELETE"].includes(request.method);
  const printerScope = request.method === "POST" ? "printer.create"
    : request.method === "PUT" ? "printer.edit"
      : request.method === "DELETE" ? "printer.delete"
        : url.searchParams.get("source") === "order" ? "orders.print_open" : "printer.view";
  const paymentsPath = path === "/v1/pos/payments";
  const businessLogoPath = path === "/v1/pos/business/logo";
  const businessLogoWrite = businessLogoPath && request.method === "PUT";
  const posSettingsPath = path === "/v1/pos/settings";
  const posSettingsWrite = posSettingsPath && request.method === "PUT";
  const qrMenuSettingsPath = ["/v1/pos/menu/public-settings", "/v1/pos/menu/public-settings/category-order", "/v1/pos/menu/public-settings/qr"].includes(path);
  const qrMenuSettingsWrite = qrMenuSettingsPath && (request.method === "PUT" || request.method === "POST");
  const salesChannelsPath = path === "/v1/pos/settings/sales-channels";
  const salesChannelsWrite = salesChannelsPath && request.method === "PUT";
  const marketingDealsPath = path === "/v1/pos/marketing/deals";
  const marketingDealsWrite = marketingDealsPath && request.method === "PUT";
  const marketingPushPath = path === "/v1/pos/marketing/push-settings"
    || path === "/v1/pos/marketing/push-campaigns"
    || /^\/v1\/pos\/marketing\/push-campaigns\/\d+(?:\/finalize)?$/.test(path)
    || path === "/v1/pos/marketing/push-subscriptions"
    || path === "/v1/pos/marketing/push-subscriptions/expired";
  const marketingPushWrite = marketingPushPath && request.method !== "GET";
  const menuOptionSetsPath = path === "/v1/pos/menu-option-sets";
  const menuOptionSetsWrite = menuOptionSetsPath && request.method === "PUT";
  const menuCategoriesPath = path === "/v1/menu/categories" || /^\/v1\/menu\/categories\/\d+$/.test(path);
  const menuCategoryWrite = menuCategoriesPath && ["POST", "PUT", "DELETE"].includes(request.method);
  const kotGroupsPath = path === "/v1/pos/kot-groups" || /^\/v1\/pos\/kot-groups\/\d+$/.test(path);
  const kotGroupPrintersPath = path === "/v1/pos/kot-groups/printers";
  const kotGroupsWrite = kotGroupsPath && ["POST", "PUT", "DELETE"].includes(request.method);
  const kotDeviceSettingsPath = path === "/v1/pos/kot-device-print-settings";
  const kotDeviceSettingsWrite = kotDeviceSettingsPath && request.method === "PUT";
  const kotPrintingModePath = path === "/v1/pos/kot-printing-mode";
  const kotPrintJobsPath = path === "/v1/pos/kot-print-jobs/claim" || /^\/v1\/pos\/kot-print-jobs\/\d+\/complete$/.test(path);
  const kotPrintJobsWrite = kotPrintJobsPath && request.method === "POST";
  const kotNotificationsPath = path === "/v1/pos/kot/notifications";
  const qrOrderNotificationsPath = path === "/v1/pos/orders/qr-notifications";
  const qrStatusMatch = path.match(/^\/v1\/pos\/orders\/(\d+)\/qr-status$/);
  const qrStatusWrite = Boolean(qrStatusMatch) && request.method === "PUT";
  const qrServiceRequestsPath = path === "/v1/pos/qr-service-requests";
  const reservationsPath = path === "/v1/pos/reservations" || /^\/v1\/pos\/reservations\/\d+\/status$/.test(path);
  const reservationsWrite = reservationsPath && ["POST", "PUT"].includes(request.method);
  const reservationScope = request.method === "POST" ? "reservations.create" : request.method === "PUT" ? "reservations.edit" : "reservations.view";
  const reportsPath = /^\/v1\/pos\/reports\/(?:summary|payments|best-items|category|order-type|daily|gst|sale-items-by-transaction|qr-menu-analytics|order-activity|kitchen-prep-times|sales-audit|order-categories|sales-summary|advanced)$/.test(path);
  const dashboardPath = path === "/v1/pos/dashboard/stats" && request.method === "GET";
  const invoicesPath = path === "/v1/pos/invoices" || /^\/v1\/pos\/invoices\/(?:order\/)?\d+$/.test(path);
  const invoicesCreate = path === "/v1/pos/invoices" && request.method === "POST";
  const expensesPath = path === "/v1/pos/expenses" || path.startsWith("/v1/pos/expenses/");
  const loyaltyPath = path === "/v1/pos/loyalty" || path.startsWith("/v1/pos/loyalty/");
  const expensesWrite = expensesPath && (request.method === "POST" || request.method === "DELETE");
  const loyaltyWrite = loyaltyPath && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method);
  const billingAdjustmentPath = /^\/v1\/pos\/billing-adjustments(?:\/\d+(?:\/toggle)?)?$/.test(path);
  const billingAdjustmentWrite = billingAdjustmentPath && request.method !== "GET";
  if (request.method !== "GET" && !isOrderCreate && !isOrderUpdate && !isOrderComplete && !isSettlement && !isKotCreate && !isCancel && !isPrinted
     && !customerBilling && !customerCreate && !customerDelete && !kotUpdate && !(posSettingsPath && request.method === "PUT") && !(salesChannelsPath && request.method === "PUT")
      && !(marketingDealsPath && request.method === "PUT") && !marketingPushWrite && !(menuOptionSetsPath && request.method === "PUT")
    && !(menuCategoryWrite)
     && !menuImportWrite
     && !menuItemWrite
     && !menuImageReferenceWrite
     && !tablesWrite
     && !printersWrite
     && !qrMenuSettingsWrite
      && !qrStatusWrite && !invoicesCreate && !businessLogoWrite && !reservationsWrite
    && !(kotGroupsPath && ["POST", "PUT", "DELETE"].includes(request.method))
    && !(kotDeviceSettingsPath && request.method === "PUT") && !kotPrintJobsWrite && !expensesWrite && !loyaltyWrite && !customerUpdate
     && !(billingAdjustmentPath && ["POST", "PUT", "DELETE"].includes(request.method))
      && !authServiceWrite && !staffAccessWrite && !deviceAdminWrite) {
    return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST, PATCH, PUT, DELETE" });
  }
  if (isOrderCreate && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "new_order.create")) {
    return json({ error: "A signed order-creation permission is required" }, 403);
  }
  if (isOrderUpdate && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "orders.edit_open")) {
    return json({ error: "A signed open-order edit permission is required" }, 403);
  }
  if (isOrderComplete && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "orders.edit_open")) {
    return json({ error: "A signed order-completion permission is required" }, 403);
  }
  if (isSettlement && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "payments.create")) {
    return json({ error: "A signed payment permission is required" }, 403);
  }
  if (isKotCreate && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "kitchen.print")) {
    return json({ error: "A signed kitchen-print permission is required" }, 403);
  }
  if (kotUpdate && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "kitchen.edit")) {
    return json({ error: "A signed kitchen-edit permission is required" }, 403);
  }
  if (isCancel && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "orders.cancel")) {
    return json({ error: "A signed order-cancellation permission is required" }, 403);
  }
  if (isPrinted && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "orders.print_open")) {
    return json({ error: "A signed bill-print permission is required" }, 403);
  }
  if (qrStatusWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "orders.edit_open")) {
    return json({ error: "A signed order-edit permission is required" }, 403);
  }
  if (invoicesCreate && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "payments.create")) {
    return json({ error: "A signed payment permission is required" }, 403);
  }
  if (businessLogoWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "settings.edit")) {
    return json({ error: "A signed settings permission is required" }, 403);
  }
  if (reservationsWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== reservationScope)) {
    return json({ error: "A signed reservation permission is required" }, 403);
  }
  if (customerBilling && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "customers.create")) {
    return json({ error: "A signed customer permission is required" }, 403);
  }
  if (customerCreate && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "customers.create")) {
    return json({ error: "A signed customer permission is required" }, 403);
  }
  if (customerDelete && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "customers.delete")) {
    return json({ error: "A signed customer-deletion permission is required" }, 403);
  }
  if (marketingDealsWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "marketing.edit")) {
    return json({ error: "A signed marketing-edit permission is required" }, 403);
  }
  const marketingPushScope = path === "/v1/pos/marketing/push-subscriptions" ? "marketing.create"
    : request.method === "GET" ? "marketing.view"
    : request.method === "DELETE" && path.match(/\/push-campaigns\/\d+$/) ? "marketing.delete" : "marketing.create";
  if (marketingPushWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== marketingPushScope)) {
    return json({ error: "A signed marketing permission is required" }, 403);
  }
  if (billingAdjustmentWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "settings.edit")) {
    return json({ error: "A signed settings-edit permission is required" }, 403);
  }
  if (menuOptionSetsWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "menu.edit")) {
    return json({ error: "A signed menu-edit permission is required" }, 403);
  }
  if (menuItemWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== menuItemScope)) {
    return json({ error: "A signed menu permission is required" }, 403);
  }
  if (menuImportWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "menu.create")) {
    return json({ error: "A signed menu-import permission is required" }, 403);
  }
  const menuImageReferenceScope = menuImageReferenceMatch?.[1] === "logo"
    ? request.method === "PUT" ? "settings.edit" : "settings.view"
    : request.method === "PUT" ? "menu.edit" : "menu.view";
  if (menuImageReferenceWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== menuImageReferenceScope)) {
    return json({ error: "A signed menu-edit permission is required" }, 403);
  }
  if (tablesWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== tableScope)) {
    return json({ error: "A signed table permission is required" }, 403);
  }
  if (printersWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== printerScope)) {
    return json({ error: "A signed printer permission is required" }, 403);
  }
  const expectedMenuCategoryScope = request.method === "POST" ? "menu.create" : request.method === "PUT" ? "menu.edit" : request.method === "DELETE" ? "menu.delete" : "menu.view";
  if (menuCategoryWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== expectedMenuCategoryScope)) {
    return json({ error: "A signed menu permission is required" }, 403);
  }
  if (posSettingsWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "settings.edit")) {
    return json({ error: "A signed settings-edit permission is required" }, 403);
  }
  const qrMenuSettingsScope = request.method === "GET" || path.endsWith("/qr") ? "menu.view" : "menu.edit";
  if (qrMenuSettingsPath && !directKeyAuthorized && bridgeClaims && bridgeClaims.scope !== qrMenuSettingsScope) {
    return json({ error: "Bridge token does not allow QR menu settings" }, 403);
  }
  if (qrMenuSettingsWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== qrMenuSettingsScope)) {
    return json({ error: "A signed QR menu permission is required" }, 403);
  }
  const kotGroupIdPath = path.match(/^\/v1\/pos\/kot-groups\/(\d+)$/);
  const expectedKotGroupScope = request.method === "POST" ? "kot_groups.create" : request.method === "PUT" ? "kot_groups.edit" : request.method === "DELETE" ? "kot_groups.delete" : "kot_groups.view";
  if (kotGroupsWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== expectedKotGroupScope)) {
    return json({ error: "A signed KOT-group permission is required" }, 403);
  }
  if (kotGroupPrintersPath && !directKeyAuthorized && (!bridgeClaims || bridgeClaims.scope !== "kot_groups.view")) {
    return json({ error: "A signed KOT-group view permission is required" }, 403);
  }
  if (kotDeviceSettingsWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "kot_groups.edit")) {
    return json({ error: "A signed KOT-group permission is required" }, 403);
  }
  if (kotPrintJobsWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "kitchen.print")) {
    return json({ error: "A signed kitchen-print permission is required" }, 403);
  }
  if (customerUpdate && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "customers.edit")) {
    return json({ error: "A signed customer-edit permission is required" }, 403);
  }
  const expectedExpenseScope = request.method === "DELETE" ? "expenses.delete" : "expenses.create";
  const expectedLoyaltyScope = request.method === "GET" ? "loyalty.view" : request.method === "PUT" ? "loyalty.edit" : "loyalty.create";
  if (expensesWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== expectedExpenseScope)) {
    return json({ error: "A signed expense permission is required" }, 403);
  }
  if (loyaltyWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== expectedLoyaltyScope)) {
    return json({ error: "A signed loyalty permission is required" }, 403);
  }
  if (salesChannelsWrite && (!bridgeClaims || directKeyAuthorized || bridgeClaims.scope !== "settings.edit")) {
    return json({ error: "A signed settings-edit permission is required" }, 403);
  }

  const posOrderDetailMatch = path.match(/^\/v1\/pos\/orders\/(\d+)$/);
  const posPaymentSummaryMatch = path.match(/^\/v1\/pos\/orders\/(\d+)\/payment-summary$/);
  const posActivityMatch = path.match(/^\/v1\/pos\/orders\/(\d+)\/activity$/);
  const appPath = path.replace(/^\/v1\/pos(?=\/)/, "/v1");
  const orderDetailMatch = appPath.match(/^\/v1\/orders\/(\d+)$/);
  const orderChildMatch = appPath.match(/^\/v1\/orders\/(\d+)\/(items|payments|kot)$/);

  const business = await requestedBusinessId(url, env);
  if (business.error) return json({ error: business.error }, business.status || 400);
  if (authServicePath) {
    const requiredScope = authPathScope(path, request.method.toUpperCase());
    if (!requiredScope || directKeyAuthorized || !bridgeClaims || bridgeClaims.sub !== 0
      || bridgeClaims.scope !== requiredScope || Number(bridgeClaims.business_id) !== business.value) {
      return json({ error: "Unauthorized staging authentication request" }, 403);
    }
    if (!(await isBusinessEnabled(env, business.value))) return json({ error: "Business is not enabled for D1 staging" }, 403);
    return handleAuthService(request, env, business.value, bridgeClaims, path, url);
  }
  if (staffAccessPath) {
    if (directKeyAuthorized || !bridgeClaims || Number(bridgeClaims.sub) <= 0) return json({ error: "Signed staff access is required" }, 403);
    if (!(await isBusinessEnabled(env, business.value))) return json({ error: "Business is not enabled for D1 staging" }, 403);
    return handleD1Access(request, env, business.value, bridgeClaims, path);
  }
  if (deviceAdminPath) {
    if (directKeyAuthorized || !bridgeClaims || Number(bridgeClaims.sub) <= 0) return json({ error: "Signed business access is required" }, 403);
    if (Number(bridgeClaims.business_id) !== business.value) return json({ error: "Bridge token business does not match the requested business" }, 403);
    if (!(await isBusinessEnabled(env, business.value))) return json({ error: "Business is not enabled for D1 staging" }, 403);
    return handleD1DeviceAdmin(request, env, business.value, bridgeClaims, path);
  }
  if (bridgeClaims) {
    if (Number(bridgeClaims.business_id) !== business.value) return json({ error: "Bridge token business does not match the requested business" }, 403);
    let requiredScope = "menu.view";
    if (isSettlement) requiredScope = "payments.create";
    else if (isOrderCreate) requiredScope = "new_order.create";
    else if (isOrderUpdate) requiredScope = "orders.edit_open";
    else if (isOrderComplete) requiredScope = "orders.edit_open";
    else if (isKotCreate) requiredScope = "kitchen.print";
    else if (kotUpdate) requiredScope = "kitchen.edit";
    else if (isCancel) requiredScope = "orders.cancel";
    else if (isPrinted) requiredScope = "orders.print_open";
    else if (qrStatusWrite) requiredScope = "orders.edit_open";
    else if (invoicesCreate) requiredScope = "payments.create";
    else if (businessLogoWrite) requiredScope = "settings.edit";
    else if (reservationsPath) requiredScope = reservationScope;
    else if (customerBilling) requiredScope = "customers.create";
    else if (customerCreate) requiredScope = "customers.create";
    else if (customerUpdate) requiredScope = "customers.edit";
    else if (customerDelete) requiredScope = "customers.delete";
    else if (customerActivity) requiredScope = "customers.view";
    else if (dashboardPath) requiredScope = "reports.view";
    else if (qrMenuSettingsPath) requiredScope = qrMenuSettingsScope;
    else if (marketingDealsWrite) requiredScope = "marketing.edit";
    else if (marketingDealsPath) requiredScope = "marketing.view";
    else if (marketingPushPath) requiredScope = marketingPushScope;
    else if (menuOptionSetsWrite) requiredScope = "menu.edit";
    else if (menuOptionSetsPath) requiredScope = "menu.view";
    else if (menuImportWrite) requiredScope = "menu.create";
    else if (menuItemWrite) requiredScope = menuItemScope;
    else if (menuItemPath) requiredScope = "menu.view";
    else if (menuImageReferencePath) requiredScope = menuImageReferenceScope;
    else if (tablesPath) requiredScope = tableScope;
    else if (printersPath) requiredScope = printerScope;
    else if (paymentsPath) requiredScope = "payments.view";
    else if (menuCategoryWrite) requiredScope = expectedMenuCategoryScope;
    else if (menuCategoriesPath) requiredScope = "menu.view";
    else if (posSettingsWrite) requiredScope = "settings.edit";
    else if (posSettingsPath) requiredScope = "settings.view";
    else if (salesChannelsWrite) requiredScope = "settings.edit";
    else if (kotGroupsWrite) requiredScope = expectedKotGroupScope;
    else if (kotGroupsPath || kotDeviceSettingsPath) requiredScope = request.method === "PUT" ? "kot_groups.edit" : "kot_groups.view";
    else if (kotGroupPrintersPath) requiredScope = "kot_groups.view";
    else if (kotPrintJobsWrite) requiredScope = "kitchen.print";
    else if (kotNotificationsPath) requiredScope = "kitchen.view";
    else if (kotTicketsPath) requiredScope = "kitchen.view";
    else if (qrOrderNotificationsPath) requiredScope = ["orders.view", "kitchen.view"].includes(bridgeClaims.scope) ? bridgeClaims.scope : "orders.view";
    else if (qrServiceRequestsPath) requiredScope = "qr_service_requests.view";
    else if (reportsPath) requiredScope = "reports.view";
    else if (invoicesCreate) requiredScope = "payments.create";
    else if (invoicesPath) requiredScope = "payments.view";
    else if (expensesPath) requiredScope = expensesWrite ? expectedExpenseScope : "expenses.view";
    else if (loyaltyPath) requiredScope = expectedLoyaltyScope;
    else if (kotPrintingModePath) requiredScope = bridgeClaims.scope;
    else if (billingAdjustmentWrite) requiredScope = "settings.edit";
    else if (billingAdjustmentPath) requiredScope = "settings.view";
    else if (posPaymentSummaryMatch) requiredScope = "payments.view";
    else if (path === "/v1/business" || path.includes("/settings")) requiredScope = "settings.view";
    else if (path.includes("/orders")) requiredScope = "orders.view";
    else if (path.includes("/customers")) requiredScope = "customers.view";
    else if (path.includes("/tables")) requiredScope = "tables.view";
    if (bridgeClaims.scope !== requiredScope) return json({ error: "Bridge token does not allow this staging data" }, 403);
  }
  if (isOrderCreate) {
    return coordinatedWrite(request, env, business.value, bridgeClaims, "create-order");
  }
  if (isOrderUpdate) {
    const orderId = Number(orderUpdateMatch[1]);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return json({ error: "A valid order ID is required" }, 400);
    return coordinatedWrite(request, env, business.value, bridgeClaims, "update-order", orderId);
  }
  if (isOrderComplete) {
    const orderId = Number(orderCompleteMatch[1]);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return json({ error: "A valid order ID is required" }, 400);
    return coordinatedWrite(request, env, business.value, bridgeClaims, "complete-order", orderId);
  }
  if (isSettlement) {
    const orderId = Number(settlementMatch[1]);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return json({ error: "A valid order ID is required" }, 400);
    return coordinatedWrite(request, env, business.value, bridgeClaims, "settle-order", orderId);
  }
  if (isKotCreate) {
    const orderId = Number(kotMatch[1]);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return json({ error: "A valid order ID is required" }, 400);
    return coordinatedWrite(request, env, business.value, bridgeClaims, "create-kot", orderId);
  }
  if (kotUpdate) {
    const kotId = Number(kotUpdateMatch[1]);
    if (!Number.isSafeInteger(kotId) || kotId <= 0) return json({ error: "Invalid KOT ID" }, 400);
    return coordinatedWrite(request, env, business.value, bridgeClaims, "update-kot-status", kotId);
  }
  if (isCancel) {
    const orderId = Number(cancelMatch[1]);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return json({ error: "A valid order ID is required" }, 400);
    return coordinatedWrite(request, env, business.value, bridgeClaims, "cancel-order", orderId);
  }
  if (isPrinted) {
    const orderId = Number(printedMatch[1]);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return json({ error: "A valid order ID is required" }, 400);
    return coordinatedWrite(request, env, business.value, bridgeClaims, "mark-printed", orderId);
  }
  if (qrStatusWrite) {
    const orderId = Number(qrStatusMatch[1]);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return json({ error: "Invalid order ID." }, 400);
    return coordinatedWrite(request, env, business.value, bridgeClaims, "update-qr-status", orderId);
  }
  if (invoicesCreate) return coordinatedWrite(request, env, business.value, bridgeClaims, "create-invoice");
  if (businessLogoPath) return handleBusinessLogo(request, env, business.value);
  if (reservationsPath) {
    if (request.method === "GET") return handleReservations(request, env, business.value, path);
    const reservationIdMatch = path.match(/^\/v1\/pos\/reservations\/(\d+)\/status$/);
    if (request.method === "POST") return coordinatedWrite(request, env, business.value, bridgeClaims, "create-reservation");
    if (request.method === "PUT" && reservationIdMatch) return coordinatedWrite(request, env, business.value, bridgeClaims, "update-reservation-status", Number(reservationIdMatch[1]));
  }
  if (customerBilling) {
    const result = await createBillingCustomer(request, env, business.value);
    const { status, ...body } = result;
    return json(body, status);
  }
  if (customerCreate) {
    const result = await createCustomer(request, env, business.value);
    const { status, ...body } = result;
    return json(body, status);
  }
  if (customerUpdate) {
    const result = await updateCustomer(request, env, business.value, Number(customerUpdateMatch[1]));
    const { status, ...body } = result;
    return json(body, status);
  }
  if (customerDelete) {
    const customerId = Number(customerUpdateMatch[1]);
    if (!Number.isSafeInteger(customerId) || customerId <= 0) return json({ error: "Invalid customer" }, 400);
    try {
      const customer = await env.DB.prepare("DELETE FROM customers WHERE id = ? AND business_id = ? RETURNING *").bind(customerId, business.value).first();
      return customer ? json({ success: true, customer }) : json({ error: "Customer not found" }, 404);
    } catch {
      return json({ error: "Customer has linked records and cannot be deleted" }, 409);
    }
  }
  if (customerActivity) return getCustomerOrderActivity(env, business.value, Number(customerActivityMatch[1]));
  if (qrMenuSettingsPath) return handlePublicMenuSettings(request, env, business.value, path);
  if (menuImportWrite) return handleMenuImport(request, env, business.value);
  if (menuItemPath) return handleMenuItemWrite(request, env, business.value, path);
  if (menuImageReferencePath) return handleMenuImageReference(request, env, business.value, path);
  if (printersPath) return handlePrinters(request, env, business.value, path);
  if (tablesPath) return handleTables(request, env, business.value, path);
  if (paymentsPath && request.method === "GET") {
    const paymentPage = pageParams(url);
    if (paymentPage.error) return json({ error: paymentPage.error }, 400);
    const result = await env.DB.prepare(
      "SELECT id, order_id, order_number, amount, payment_method, payment_status, transaction_id, created_at " +
      "FROM payments WHERE business_id = ? ORDER BY id DESC LIMIT ? OFFSET ?"
    ).bind(business.value, paymentPage.limit + 1, paymentPage.offset).all();
    return pagedJson(result.results || [], paymentPage);
  }
  if (posSettingsPath) return handlePosSettings(request, env, business.value);
  if (salesChannelsPath) return handleSalesChannels(request, env, business.value);
  if (marketingDealsPath) return handleMarketingDeals(request, env, business.value);
  if (marketingPushPath) return handleMarketingPush(request, env, business.value, path, bridgeClaims);
  if (menuOptionSetsPath) return handleMenuOptionSets(request, env, business.value);
  if (menuCategoryWrite) return handleMenuCategoryWrite(request, env, business.value, path);
  if (kotGroupsPath || kotGroupPrintersPath) return handleKotGroups(request, env, business.value, path);
  if (kotDeviceSettingsPath) return handleKotDeviceSettings(request, env, business.value, bridgeClaims?.device_id);
  if (kotPrintingModePath && request.method === "GET") {
    if (bridgeClaims && !["new_order.create", "kitchen.print", "orders.view"].includes(bridgeClaims.scope)) return json({ error: "Bridge token does not allow kitchen printing mode" }, 403);
    const row = await env.DB.prepare("SELECT enabled FROM kot_device_print_hosts WHERE business_id = ? LIMIT 1").bind(business.value).first();
    return json({ printAllTicketsFromDevice: Boolean(row?.enabled) });
  }
  if (kotPrintJobsPath) return handleKotPrintJob(request, env, business.value, bridgeClaims?.device_id, path);
  if (kotNotificationsPath && request.method === "GET") return handleKotNotifications(url, env, business.value);
  if (kotTicketsPath) return handleKotTickets(env, business.value, url);
  if (qrOrderNotificationsPath && request.method === "GET") return handleQrOrderNotifications(url, env, business.value);
  if (qrServiceRequestsPath && request.method === "GET") return handleQrServiceRequests(url, env, business.value);
  if (reportsPath && request.method === "GET") return handleReports(env, business.value, path, url);
  if (dashboardPath) return handleDashboardStats(env, business.value);
  if (invoicesPath && request.method === "GET") return handleInvoices(env, business.value, path, url);
  if (expensesPath) return handleExpenses(request, env, business.value, path, bridgeClaims);
  if (loyaltyPath) return handleLoyalty(request, env, business.value, path, bridgeClaims);
  if (billingAdjustmentPath) return handleBillingAdjustments(request, env, business.value, path);
  const page = pageParams(url);
  if (page.error) return json({ error: page.error }, 400);
  const businessId = business.value;

  if (path === "/v1/pos/tables") {
    const result = await env.DB.prepare(
      "SELECT * FROM restaurant_tables WHERE business_id = ? ORDER BY CAST(table_number AS INTEGER), table_number, id"
    ).bind(businessId).all();
    return json(result.results || []);
  }

  if (path === "/v1/pos/customers") {
    const result = await env.DB.prepare(
      "SELECT * FROM customers WHERE business_id = ? ORDER BY id DESC LIMIT ? OFFSET ?"
    ).bind(businessId, page.limit + 1, page.offset).all();
    return pagedJson(result.results || [], page);
  }

  if (path === "/v1/pos/orders") {
    const scope = String(url.searchParams.get("scope") || "all");
    if (!["all", "my-orders", "table"].includes(scope)) return json({ error: "Invalid order list scope" }, 400);
    let fromDate = String(url.searchParams.get("from") || "").trim();
    const toDate = String(url.searchParams.get("to") || "").trim();
    const updatedAfter = String(url.searchParams.get("updatedAfter") || "").trim();
    if ((fromDate && !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) || (toDate && !/^\d{4}-\d{2}-\d{2}$/.test(toDate))) {
      return json({ error: "Choose a valid order date range" }, 400);
    }
    if (fromDate && toDate && fromDate > toDate) return json({ error: "Choose a valid order date range" }, 400);
    if (updatedAfter && !Number.isFinite(Date.parse(updatedAfter))) return json({ error: "Choose a valid order update cursor" }, 400);
    if (scope === "my-orders" && !fromDate && !toDate) {
      fromDate = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    }
    const result = await env.DB.prepare(
      "SELECT o.id, o.business_id, o.order_number, o.order_type, o.table_number, o.subtotal, o.gst, o.total, " +
      "o.payment_method, o.status, o.created_at, o.updated_at, o.customer_id, o.discount, o.service_charge, " +
      "o.pax, o.sales_channel_key, o.sales_channel_name, o.bill_printed_at, o.notes, o.non_chargeable_reason, " +
      "o.cancellation_reason, o.cancelled_at, c.name AS customer_name, c.phone AS customer_phone, " +
      "COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id = o.id AND p.business_id = o.business_id AND p.payment_status = 'Success'), 0) AS amount_collected, " +
      "CASE WHEN LOWER(COALESCE(o.payment_method, '')) LIKE '%non-chargeable%' THEN 0 " +
      "ELSE MAX(0, o.total - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id = o.id AND p.business_id = o.business_id AND p.payment_status = 'Success'), 0)) END AS amount_due " +
      "FROM orders o LEFT JOIN customers c ON c.id = o.customer_id AND c.business_id = o.business_id " +
      "WHERE o.business_id = ? " +
      "AND (? <> 'table' OR LOWER(COALESCE(o.status, '')) NOT IN ('completed', 'cancelled')) " +
      "AND (? = '' OR date(datetime(o.created_at, '+05:30')) >= date(?)) " +
      "AND (? = '' OR date(datetime(o.created_at, '+05:30')) <= date(?)) " +
      "AND (? = '' OR datetime(COALESCE(o.updated_at, o.created_at)) >= datetime(?)) " +
      "ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?"
    ).bind(businessId, scope, fromDate, fromDate, toDate, toDate, updatedAfter, updatedAfter, page.limit + 1, page.offset).all();
    return pagedJson(result.results || [], page, (row) => {
      const amountCollected = Number(row.amount_collected || 0);
      const amountDue = Number(row.amount_due || 0);
      return { ...row, amount_collected: amountCollected, amount_due: amountDue, is_paid: amountDue <= 0.009 };
    });
  }

  if (posOrderDetailMatch) {
    const orderId = Number(posOrderDetailMatch[1]);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return json({ error: "A valid order ID is required" }, 400);
    const order = await env.DB.prepare(
      "SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, c.gstin AS customer_gstin, " +
      "c.birth_date AS customer_birth_date, c.address AS customer_address, c.city AS customer_city, c.state AS customer_state " +
      "FROM orders o LEFT JOIN customers c ON c.id = o.customer_id AND c.business_id = o.business_id " +
      "WHERE o.business_id = ? AND o.id = ? LIMIT 1"
    ).bind(businessId, orderId).first();
    if (!order) return json({ error: "Order not found" }, 404);
    order.adjustment_meta = parseJsonField(order.adjustment_meta, {});
    order.billing_settings_snapshot = parseJsonField(order.billing_settings_snapshot, {});
    const items = await env.DB.prepare(
      "SELECT * FROM order_items WHERE business_id = ? AND order_id = ? ORDER BY id"
    ).bind(businessId, orderId).all();
    const normalizedItems = (items.results || []).map((item) => normalizeOrderChild(item));
    return json({ order, items: normalizedItems });
  }

  if (posPaymentSummaryMatch) {
    const orderId = Number(posPaymentSummaryMatch[1]);
    const order = await env.DB.prepare(
      "SELECT total, payment_method FROM orders WHERE business_id = ? AND id = ? LIMIT 1"
    ).bind(businessId, orderId).first();
    if (!order) return json({ error: "Order not found" }, 404);
    const allocationResult = await env.DB.prepare(
      "SELECT payment_method AS method, SUM(amount) AS amount FROM payments " +
      "WHERE business_id = ? AND order_id = ? AND payment_status = 'Success' GROUP BY payment_method ORDER BY payment_method"
    ).bind(businessId, orderId).all();
    const allocations = (allocationResult.results || []).map((row) => ({ method: row.method, amount: Number(row.amount || 0) }));
    const amountCollected = allocations.reduce((sum, row) => sum + row.amount, 0);
    const total = Number(order.total || 0);
    const nonChargeable = /non.?chargeable/i.test(String(order.payment_method || ""));
    return json({ total, amountCollected, amountDue: nonChargeable ? 0 : Math.max(0, total - amountCollected), allocations });
  }

  if (posActivityMatch) {
    const orderId = Number(posActivityMatch[1]);
    const result = await env.DB.prepare(
      "SELECT id, event_type, description, actor, created_at FROM order_activity " +
      "WHERE business_id = ? AND order_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
    ).bind(businessId, orderId, page.limit, page.offset).all();
    return json({ activities: result.results || [] });
  }

  if (path === "/v1/business") {
    const result = await env.DB.prepare(`
      SELECT id, business_code, business_name, business_type, owner_name, phone, email,
             address, city, state, gstin, logo_url, currency, active
      FROM businesses WHERE id = ? LIMIT 1
    `).bind(businessId).all();
    const row = result.results?.[0];
    if (!row || !Boolean(row.active)) return json({ error: "Business not found or inactive" }, 404);
    return json({ ...row, active: Boolean(row.active) });
  }

  if (path === "/v1/orders") {
    const result = await env.DB.prepare(`
      SELECT id, business_id, order_number, order_type, table_number,
             subtotal, gst, total, payment_method, status,
             created_at, updated_at, customer_id, discount, service_charge,
             pax, sales_channel_key, sales_channel_name, bill_printed_at
      FROM orders
      WHERE business_id = ?
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `).bind(businessId, page.limit + 1, page.offset).all();
    return pagedJson(result.results || [], page);
  }

  if (orderDetailMatch) {
    const orderId = Number(orderDetailMatch[1]);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return json({ error: "A valid order ID is required" }, 400);
    const result = await env.DB.prepare(`
      SELECT id, business_id, order_number, order_type, table_number,
             subtotal, gst, total, payment_method, status,
             created_at, updated_at, customer_id, discount, service_charge,
             adjustment_meta, discount_adjustment_id, charge_adjustment_id,
             discount_adjustment_name, charge_adjustment_name, pax,
             non_chargeable_reason, cancellation_reason, cancelled_by_user_id,
             cancelled_at, sales_channel_key, sales_channel_name, bill_printed_at,
             marketing_deal_id, marketing_deal_name,
             CASE WHEN public_tracking_token IS NOT NULL OR order_number LIKE 'QR-%' THEN 1 ELSE 0 END AS is_qr_order
      FROM orders
      WHERE business_id = ? AND id = ?
      LIMIT 1
    `).bind(businessId, orderId).all();
    const row = result.results?.[0];
    if (!row) return json({ error: "Order not found" }, 404);
    return json({ ...row, adjustment_meta: parseJsonField(row.adjustment_meta, {}) });
  }

  if (orderChildMatch) {
    const orderId = Number(orderChildMatch[1]);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return json({ error: "A valid order ID is required" }, 400);
    const childResource = orderChildMatch[2];
    let query;
    let normalize = (row) => row;

    if (childResource === "items") {
      query = `
        SELECT i.id, i.order_id, i.business_id, i.menu_id, i.item_name,
               i.price, i.quantity, i.line_total, i.variant_id, i.unit,
               i.tax_rate, i.tax_mode, i.options, i.item_discount_rule_id,
               i.item_discount_amount, i.item_discount_name
        FROM order_items AS i
        JOIN orders AS o ON o.id = i.order_id AND o.business_id = ?
        WHERE i.business_id = ? AND i.order_id = ?
        ORDER BY i.id ASC
        LIMIT ? OFFSET ?
      `;
      normalize = normalizeOrderChild;
    } else if (childResource === "payments") {
      query = `
        SELECT p.id, p.order_id, p.order_number, p.amount,
               p.payment_method, p.payment_status, p.created_at, p.updated_at
        FROM payments AS p
        JOIN orders AS o ON o.id = p.order_id AND o.business_id = ?
        WHERE p.business_id = ? AND p.order_id = ?
        ORDER BY p.id ASC
        LIMIT ? OFFSET ?
      `;
    } else {
      query = `
        SELECT k.id, k.order_id, k.business_id, k.item_name, k.quantity,
               k.status, k.created_at, k.kot_group_id, k.options,
               k.order_item_id, k.cancelled_quantity, k.ticket_number,
               k.prep_started_at, k.prep_completed_at
        FROM kot AS k
        JOIN orders AS o ON o.id = k.order_id AND o.business_id = ?
        WHERE k.business_id = ? AND k.order_id = ?
        ORDER BY k.id ASC
        LIMIT ? OFFSET ?
      `;
      normalize = normalizeOrderChild;
    }

    const result = await env.DB.prepare(query)
      .bind(businessId, businessId, orderId, page.limit + 1, page.offset)
      .all();
    return pagedJson(result.results || [], page, normalize);
  }

  if (path === "/v1/menu/categories") {
    const result = await env.DB.prepare(`
      SELECT id, name, image_url, sort_order, active, created_at, updated_at
      FROM menu_categories
      WHERE business_id = ?
      ORDER BY sort_order ASC, name ASC, id ASC
      LIMIT ? OFFSET ?
    `).bind(businessId, page.limit, page.offset).all();
    return json((result.results || []).map((row) => ({ ...row, active: Boolean(row.active) })));
  }

  if (path === "/v1/menu") {
    const result = await env.DB.prepare(`
      SELECT m.*, kg.name AS kot_group_name, kg.station AS kot_group_station
      FROM menu AS m
      LEFT JOIN kot_groups AS kg ON kg.id = m.kot_group_id AND kg.business_id = ?
      WHERE m.business_id = ?
      ORDER BY m.category, m.name, m.id
      LIMIT ? OFFSET ?
    `).bind(businessId, businessId, page.limit, page.offset).all();

    const items = result.results || [];
    if (items.length === 0) return json([]);
    const ids = items.map((item) => Number(item.id)).filter(Number.isSafeInteger);
    const placeholders = ids.map(() => "?").join(",");
    const variantsResult = await env.DB.prepare(`
      SELECT id, menu_id, name, sku, price, unit, channel_prices, option_set_ids, available
      FROM menu_variants
      WHERE business_id = ? AND menu_id IN (${placeholders})
      ORDER BY menu_id, id
    `).bind(businessId, ...ids).all();

    const variantsByMenu = new Map();
    for (const variant of variantsResult.results || []) {
      const key = Number(variant.menu_id);
      if (!variantsByMenu.has(key)) variantsByMenu.set(key, []);
      variantsByMenu.get(key).push(variant);
    }
    return json(items.map((item) => normalizeMenuItem({
      ...item,
      variants: variantsByMenu.get(Number(item.id)) || [],
    })));
  }

  return json({ error: "Not found" }, 404);
}

export class OrderCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.pending = Promise.resolve();
  }

  fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run") {
      return json({ error: "Not found" }, 404);
    }
    const task = this.pending.then(() => this.process(request), () => this.process(request));
    this.pending = task.then(() => undefined, () => undefined);
    return task;
  }

  async process(request) {
    let payload;
    try {
      const raw = await request.text();
      if (raw.length > 70000) return json({ error: "Order coordination request is too large" }, 413);
      payload = JSON.parse(raw || "{}");
    } catch {
      return json({ error: "Invalid order coordination request" }, 400);
    }

    const businessId = Number(payload.businessId);
    const orderId = Number(payload.orderId);
    const claims = payload.claims && typeof payload.claims === "object" ? payload.claims : {};
    const operation = String(payload.operation || "");
    const requiredScope = operation === "create-order" ? "new_order.create"
      : operation === "settle-order" ? "payments.create"
      : operation === "create-kot" ? "kitchen.print"
      : operation === "cancel-order" ? "orders.cancel"
      : operation === "update-order" ? "orders.edit_open"
      : operation === "complete-order" ? "orders.edit_open"
      : operation === "mark-printed" ? "orders.print_open"
      : operation === "update-qr-status" ? "orders.edit_open"
      : operation === "update-kot-status" ? "kitchen.edit"
      : operation === "create-invoice" ? "payments.create"
      : operation === "create-reservation" ? "reservations.create"
      : operation === "update-reservation-status" ? "reservations.edit" : "";
    if (!requiredScope || claims.scope !== requiredScope
      || Number(claims.business_id) !== businessId
      || !Number.isSafeInteger(Number(claims.sub)) || Number(claims.sub) <= 0
      || !(await isBusinessEnabled(this.env, businessId))) {
      return json({ error: "Order coordination is not authorized" }, 403);
    }
    if (!['create-order', 'create-invoice', 'create-reservation'].includes(operation) && (!Number.isSafeInteger(orderId) || orderId <= 0)) {
      return json({ error: "A valid order ID is required" }, 400);
    }

    const actionRequest = new Request("https://order-coordinator.internal/v1/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload.body && typeof payload.body === "object" ? payload.body : {}),
    });
    const result = operation === "create-order"
      ? await createOpenOrder(actionRequest, this.env, businessId, claims)
      : operation === "create-invoice"
        ? await createManualInvoice(this.env, businessId, payload.body && typeof payload.body === "object" ? payload.body : {})
      : operation === "create-reservation"
        ? await createD1Reservation(this.env, businessId, payload.body && typeof payload.body === "object" ? payload.body : {})
      : operation === "settle-order"
        ? await settleOrder(actionRequest, this.env, businessId, claims, orderId)
        : operation === "update-order"
          ? await updateOpenOrder(actionRequest, this.env, businessId, claims, orderId)
      : operation === "complete-order"
        ? await completeOrder(this.env, businessId, orderId, claims)
        : operation === "create-kot"
          ? { status: 200, success: true, ...(await createKotForOrder(this.env, businessId, orderId)) }
        : operation === "update-qr-status"
          ? await updateQrOrderStatus(this.env, businessId, claims, orderId, payload.body)
        : operation === "update-kot-status"
          ? await updateKotItem(this.env, businessId, orderId, payload.body?.status, Number(claims.sub))
        : operation === "update-reservation-status"
          ? await updateD1ReservationStatus(this.env, businessId, orderId, payload.body && typeof payload.body === "object" ? payload.body : {})
          : operation === "cancel-order"
            ? await cancelOrder(actionRequest, this.env, businessId, claims, orderId)
            : await markOrderPrinted(this.env, businessId, claims, orderId);
    const { status, ...responseBody } = result;
    return json(responseBody, Number(status) || 500);
  }
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      console.error("D1 staging request failed", error?.name || "Error", error?.message || "");
      return json({ error: "Staging request failed" }, 500);
    }
  },
};
