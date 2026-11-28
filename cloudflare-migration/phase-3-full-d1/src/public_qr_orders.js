// Public QR orders keep a browser-scoped guest session; phone numbers are contact details and are not OTP-verified.
import { activeChannels, money, normalizeOptions, receiptSnapshot, storedChannels } from "./orders.js";
import { buildKotStatements } from "./kot.js";

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
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
  return { orderingOpen, closedMessage: orderingOpen ? "" : `${String(businessName || "The cafe")} is closed rn 😴 — the kitchen’s on a lil break.${hours} Catch us during open hours for the good stuff.` };
}

function normalizeGuestCustomer(value) {
  const source = value && typeof value === "object" ? value : {};
  const name = String(source.name || "").trim();
  const rawPhone = String(source.phone || "").trim();
  const digits = rawPhone.replace(/\D/g, "");
  const phone = (rawPhone.startsWith("+") ? "+" : "") + digits;
  const email = String(source.email || "").trim();
  const birthDate = String(source.birthDate || source.birth_date || "").trim();
  if (!name || name.length > 100) throw fail(400, "Enter your name (up to 100 characters).");
  if (!/^\+?[\d\s().-]+$/.test(rawPhone) || digits.length < 6 || digits.length > 15) throw fail(400, "Enter a valid phone or WhatsApp number.");
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw fail(400, "Enter a valid email address or leave it blank.");
  if (birthDate) {
    const parsed = new Date(birthDate + "T00:00:00.000Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== birthDate || parsed.getTime() > Date.now()) {
      throw fail(400, "Enter a valid birthday or leave it blank.");
    }
  }
  return { name, phone, email: email || null, birthDate: birthDate || null, digits };
}

function sessionKeyFor(businessId, token, sessionId) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${Number(businessId)}:${String(token)}:${String(sessionId)}`))
    .then((digest) => Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(""));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value || "")));
  return Array.from(new Uint8Array(digest), (entry) => entry.toString(16).padStart(2, "0")).join("");
}

export async function checkQrGuestSession(env, businessId, token, tableNumber, phone, rawSessionToken) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!/^[0-9]{10}$/.test(digits) || !String(tableNumber || "").trim() || !/^[a-f0-9]{64}$/i.test(String(rawSessionToken || ""))) return null;
  const tokenHash = await sha256Hex(token);
  const sessionHash = await sha256Hex(rawSessionToken);
  const row = await env.DB.prepare(
    "SELECT id, customer_id FROM qr_guest_sessions WHERE business_id = ? AND menu_token_hash = ? AND table_number = ? " +
    "AND phone = ? AND session_token_hash = ? AND datetime(expires_at) > datetime('now') ORDER BY id DESC LIMIT 1"
  ).bind(businessId, tokenHash, String(tableNumber).trim(), digits, sessionHash).first();
  if (!row) return null;
  await env.DB.prepare("UPDATE qr_guest_sessions SET last_activity_at = CURRENT_TIMESTAMP, expires_at = datetime('now', '+2 hours') WHERE id = ? AND business_id = ?").bind(Number(row.id), businessId).run();
  return { customerId: Number(row.customer_id) || null };
}

export async function reserveQrGuestOtp(env, businessId, token, tableNumber, phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  const tableText = String(tableNumber || "").trim();
  if (!/^[0-9]{10}$/.test(digits)) throw fail(400, "Enter a valid 10-digit Indian mobile number.");
  if (!tableText || tableText.length > 60) throw fail(400, "Choose a valid table before verifying your number.");
  const table = await env.DB.prepare("SELECT 1 FROM restaurant_tables WHERE business_id = ? AND CAST(table_number AS TEXT) = ? LIMIT 1").bind(businessId, tableText).first();
  if (!table) throw fail(400, "This QR link does not match an active table.");
  const menuHash = await sha256Hex(token);
  const existing = await env.DB.prepare(
    "SELECT id FROM qr_guest_otp_challenges WHERE business_id = ? AND menu_token_hash = ? AND table_number = ? " +
    "AND phone = ? AND verified_at IS NULL AND datetime(expires_at) > datetime('now') AND datetime(resend_after) > datetime('now') ORDER BY created_at DESC LIMIT 1"
  ).bind(businessId, menuHash, tableText, digits).first();
  if (existing) throw fail(429, "Please wait 60 seconds before requesting another OTP.");
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM qr_guest_otp_challenges WHERE business_id = ? AND phone = ? AND datetime(created_at) > datetime('now', '-1 hour')"
  ).bind(businessId, digits).first();
  if (Number(recent?.count || 0) >= 5) throw fail(429, "Too many OTP requests for this number. Please try again later.");
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO qr_guest_otp_challenges (id, business_id, menu_token_hash, table_number, phone, provider_request_id, attempts, expires_at, resend_after) " +
    "VALUES (?, ?, ?, ?, ?, NULL, 0, datetime('now', '+10 minutes'), datetime('now', '+60 seconds'))"
  ).bind(id, businessId, menuHash, tableText, digits).run();
  return { challengeId: id, expiresInSeconds: 600, resendInSeconds: 60 };
}

export async function recordQrGuestOtpProvider(env, businessId, token, body) {
  const challengeId = String(body?.challengeId || "");
  const tableNumber = String(body?.tableNumber || "").trim();
  const digits = String(body?.phone || "").replace(/\D/g, "");
  const providerRequestId = String(body?.providerRequestId || "").slice(0, 200) || null;
  if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !tableNumber || !/^[0-9]{10}$/.test(digits)) throw fail(400, "Invalid OTP challenge.");
  const menuHash = await sha256Hex(token);
  const result = await env.DB.prepare(
    "UPDATE qr_guest_otp_challenges SET provider_request_id = ? WHERE id = ? AND business_id = ? AND menu_token_hash = ? " +
    "AND table_number = ? AND phone = ? AND verified_at IS NULL AND datetime(expires_at) > datetime('now')"
  ).bind(providerRequestId, challengeId, businessId, menuHash, tableNumber, digits).run();
  if (!Number(result?.meta?.changes || 0)) throw fail(404, "OTP challenge not found.");
  return { success: true };
}

export async function cancelQrGuestOtp(env, businessId, token, body) {
  const challengeId = String(body?.challengeId || "");
  const menuHash = await sha256Hex(token);
  await env.DB.prepare("DELETE FROM qr_guest_otp_challenges WHERE id = ? AND business_id = ? AND menu_token_hash = ? AND verified_at IS NULL")
    .bind(challengeId, businessId, menuHash).run();
  return { success: true };
}

export async function prepareQrGuestOtpVerification(env, businessId, token, body) {
  const challengeId = String(body?.challengeId || "");
  const tableNumber = String(body?.tableNumber || "").trim();
  const digits = String(body?.phone || "").replace(/\D/g, "");
  if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !tableNumber || !/^[0-9]{10}$/.test(digits)) throw fail(400, "Invalid OTP challenge.");
  const menuHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "UPDATE qr_guest_otp_challenges SET attempts = attempts + 1 WHERE id = ? AND business_id = ? AND menu_token_hash = ? " +
    "AND table_number = ? AND phone = ? AND verified_at IS NULL AND attempts < 5 AND datetime(expires_at) > datetime('now') " +
    "RETURNING id, attempts, provider_request_id"
  ).bind(challengeId, businessId, menuHash, tableNumber, digits).first();
  if (!row) throw fail(400, "This OTP has expired or reached its attempt limit. Request a new one.");
  return { challengeId: String(row.id), attempts: Number(row.attempts), providerRequestId: row.provider_request_id || null };
}

export async function completeQrGuestSession(env, businessId, token, body) {
  const challengeId = String(body?.challengeId || "");
  const tableNumber = String(body?.tableNumber || "").trim();
  const customer = normalizeGuestCustomer(body?.customer);
  const rawSessionToken = String(body?.sessionToken || "");
  if (!/^[0-9a-f-]{36}$/i.test(challengeId) || !/^[a-f0-9]{64}$/i.test(rawSessionToken)) throw fail(400, "Invalid guest verification session.");
  const publication = await env.DB.prepare("SELECT business_id, enabled FROM public_menu_settings WHERE token = ? LIMIT 1").bind(String(token)).first();
  if (!publication || Number(publication.business_id) !== businessId || !Number(publication.enabled) || !(await tableQrLicensed(env, businessId))) throw fail(404, "This QR menu is not currently accepting orders.");
  const menuHash = await sha256Hex(token);
  const challenge = await env.DB.prepare(
    "SELECT id, phone FROM qr_guest_otp_challenges WHERE id = ? AND business_id = ? AND menu_token_hash = ? AND table_number = ? " +
    "AND verified_at IS NULL AND attempts BETWEEN 1 AND 5 AND datetime(expires_at) > datetime('now') LIMIT 1"
  ).bind(challengeId, businessId, menuHash, tableNumber).first();
  if (!challenge || String(challenge.phone) !== customer.digits) throw fail(400, "This OTP has expired. Request a new one.");
  const customerId = await upsertGuestCustomer(env, businessId, customer);
  const sessionHash = await sha256Hex(rawSessionToken);
  const statements = [
    env.DB.prepare("UPDATE qr_guest_otp_challenges SET verified_at = CURRENT_TIMESTAMP WHERE id = ? AND business_id = ? AND verified_at IS NULL").bind(challengeId, businessId),
    env.DB.prepare("DELETE FROM qr_guest_sessions WHERE business_id = ? AND menu_token_hash = ? AND table_number = ? AND phone = ?").bind(businessId, menuHash, tableNumber, customer.digits),
    env.DB.prepare("INSERT INTO qr_guest_sessions (business_id, menu_token_hash, table_number, phone, customer_id, session_token_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+2 hours'))")
      .bind(businessId, menuHash, tableNumber, customer.digits, customerId, sessionHash),
  ];
  await env.DB.batch(statements);
  const row = await env.DB.prepare("SELECT id, name, phone, email, birth_date FROM customers WHERE id = ? AND business_id = ? LIMIT 1").bind(customerId, businessId).first();
  return { success: true, customer: row, expiresInSeconds: 7200 };
}

async function tableQrLicensed(env, businessId) {
  const row = await env.DB.prepare(
    "SELECT add_on FROM business_licenses WHERE business_id = ? AND status = 'active' " +
    "AND datetime(CASE WHEN substr(starts_at, -3, 1) IN ('+', '-') AND substr(starts_at, -2, 2) NOT GLOB '*[^0-9]*' THEN substr(starts_at, 1, length(starts_at) - 3) || substr(starts_at, -3, 3) || ':00' ELSE starts_at END) <= datetime('now') " +
    "AND datetime(CASE WHEN substr(expires_at, -3, 1) IN ('+', '-') AND substr(expires_at, -2, 2) NOT GLOB '*[^0-9]*' THEN substr(expires_at, 1, length(expires_at) - 3) || substr(expires_at, -3, 3) || ':00' ELSE expires_at END) >= datetime('now') " +
    "ORDER BY created_at DESC, id DESC LIMIT 1"
  ).bind(businessId).first();
  if (!row) return false;
  let addOns = parseJson(row.add_on, null);
  if (!Array.isArray(addOns)) addOns = String(row.add_on || "").split(/[;,]/);
  return addOns.some((item) => String(item || "").trim().toLowerCase() === "table qr");
}

async function upsertGuestCustomer(env, businessId, customer) {
  const rows = await env.DB.prepare("SELECT id, name, phone, email, birth_date FROM customers WHERE business_id = ? ORDER BY id LIMIT 10000").bind(businessId).all();
  const existing = (rows.results || []).find((row) => String(row.phone || "").replace(/\D/g, "") === customer.digits);
  if (existing) {
    await env.DB.prepare(
      "UPDATE customers SET name = COALESCE(NULLIF(TRIM(name), ''), ?), email = COALESCE(NULLIF(TRIM(email), ''), ?), " +
      "birth_date = COALESCE(birth_date, ?) WHERE id = ? AND business_id = ?"
    ).bind(customer.name, customer.email, customer.birthDate, Number(existing.id), businessId).run();
    return Number(existing.id);
  }
  const inserted = await env.DB.prepare(
    "INSERT INTO customers (name, phone, email, birth_date, business_id) VALUES (?, ?, ?, ?, ?) RETURNING id"
  ).bind(customer.name, customer.phone, customer.email, customer.birthDate, businessId).first();
  if (!inserted?.id) throw fail(500, "Could not save guest details.");
  return Number(inserted.id);
}

async function getActiveOrder(env, businessId, body, sessionKey, customerId, orderType, tableNumber) {
  const requested = body?.currentOrder && typeof body.currentOrder === "object" ? body.currentOrder : {};
  const requestedId = Number(requested.orderId);
  const tracking = String(requested.trackingToken || "");
  let candidate = null;
  if (Number.isSafeInteger(requestedId) && requestedId > 0 && /^[a-f0-9]{48}$/i.test(tracking)) {
    candidate = await env.DB.prepare(
      "SELECT id, order_number, order_type, table_number, total, status, customer_id, public_tracking_token FROM orders " +
      "WHERE id = ? AND business_id = ? AND public_tracking_token = ? LIMIT 1"
    ).bind(requestedId, businessId, tracking).first();
  }
  if (candidate && !["completed", "cancelled"].includes(String(candidate.status || "").toLowerCase()) &&
    String(candidate.order_type || "").toLowerCase() === orderType.toLowerCase() && String(candidate.table_number || "") === String(tableNumber || "")) {
    const paid = await env.DB.prepare("SELECT COALESCE(SUM(amount), 0) AS collected FROM payments WHERE order_id = ? AND business_id = ? AND payment_status = 'Success'").bind(Number(candidate.id), businessId).first();
    if (Number(paid?.collected || 0) < Number(candidate.total || 0) - 0.009) return candidate;
  }
  if (!sessionKey) return null;
  candidate = await env.DB.prepare(
    "SELECT id, order_number, order_type, table_number, total, status, customer_id, public_tracking_token FROM orders " +
    "WHERE business_id = ? AND (public_session_key = ? OR (public_session_key IS NULL AND customer_id = ? AND public_tracking_token IS NOT NULL)) " +
    "AND LOWER(COALESCE(status, '')) NOT IN ('completed', 'cancelled') AND LOWER(order_type) = LOWER(?) " +
    "AND IFNULL(CAST(table_number AS TEXT), '') = ? ORDER BY CASE WHEN public_session_key = ? THEN 0 ELSE 1 END, id ASC LIMIT 1"
  ).bind(businessId, sessionKey, customerId, orderType, String(tableNumber || ""), sessionKey).first();
  if (!candidate || Number(candidate.customer_id || 0) !== customerId) return null;
  const paid = await env.DB.prepare("SELECT COALESCE(SUM(amount), 0) AS collected FROM payments WHERE order_id = ? AND business_id = ? AND payment_status = 'Success'").bind(Number(candidate.id), businessId).first();
  return Number(paid?.collected || 0) < Number(candidate.total || 0) - 0.009 ? candidate : null;
}

async function chooseOrderNumber(env, businessId, settings) {
  const prefix = String(settings?.qrOrderPrefix ?? "QR-").slice(0, 24);
  const paddingValue = Number(settings?.qrOrderNumberPadding || 4);
  const padding = Number.isSafeInteger(paddingValue) ? Math.max(1, Math.min(12, paddingValue)) : 4;
  const startValue = Number(settings?.qrOrderSequenceStart || 1);
  const start = Number.isSafeInteger(startValue) && startValue > 0 ? startValue : 1;
  const [counter, allNumbers] = await Promise.all([
    env.DB.prepare("SELECT next_number FROM business_sequence_counters WHERE business_id = ? AND series_key = 'qr_order' LIMIT 1").bind(businessId).first(),
    env.DB.prepare("SELECT order_number FROM orders WHERE business_id = ?").bind(businessId).all(),
  ]);
  let latest = 0;
  for (const row of allNumbers.results || []) {
    const number = String(row.order_number || "");
    if (!number.startsWith(prefix)) continue;
    const suffix = number.slice(prefix.length);
    if (/^\d+$/.test(suffix)) latest = Math.max(latest, Number(suffix));
  }
  let sequence = Math.max(start, Number(counter?.next_number) || 1, latest + 1);
  for (let attempt = 0; attempt < 100; attempt += 1, sequence += 1) {
    const orderNumber = prefix + String(sequence).padStart(padding, "0");
    const exists = await env.DB.prepare("SELECT 1 AS exists_flag FROM orders WHERE order_number = ? LIMIT 1").bind(orderNumber).first();
    if (!exists) return { orderNumber, next: sequence + 1 };
  }
  throw fail(409, "Could not allocate a QR order number. Try again.");
}

export async function createPublicQrOrder(env, businessId, token, input) {
  if (String(env.D1_STAGING_PUBLIC_QR_ORDER_WRITES_ENABLED || "").toLowerCase() !== "true") return { status: 503, error: "QR order writes are disabled in this D1 staging pilot." };
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw fail(400, "Invalid order request.");
    const linkTableNumber = String(input.linkTableNumber || "").trim();
    const tableNumber = String(input.tableNumber || input.table_number || "").trim();
    const requestedOrderType = String(input.orderType || "dine-in").toLowerCase();
    if (input.promotionId || input.marketingDealId || (input.discount !== undefined && Number(input.discount) !== 0)) throw fail(400, "Offers are display-only and cannot be applied to QR orders.");
    if (!["dine-in", "takeaway"].includes(requestedOrderType)) throw fail(400, "Choose Dine in or Takeaway.");
    const orderType = requestedOrderType === "takeaway" ? "Takeaway" : "Dine-in";
    if (!linkTableNumber || tableNumber !== linkTableNumber || tableNumber.length > 60 || /[\u0000-\u001f\u007f]/.test(tableNumber)) throw fail(400, "This order link does not have a valid table number.");
    const requestedItems = Array.isArray(input.items) ? input.items : [];
    if (!requestedItems.length || requestedItems.length > 30) throw fail(400, "Choose between 1 and 30 menu items.");
    const customer = normalizeGuestCustomer(input.customer);

    const publication = await env.DB.prepare(
      "SELECT s.business_id, s.enabled, s.price_channel, s.outlet_open, s.hours_enabled, s.open_time, s.close_time, b.business_name " +
      "FROM public_menu_settings s JOIN businesses b ON b.id = s.business_id WHERE s.token = ? LIMIT 1"
    ).bind(String(token)).first();
    if (!publication || Number(publication.business_id) !== businessId || !Boolean(publication.enabled) || !(await tableQrLicensed(env, businessId))) throw fail(404, "This QR menu is not currently accepting orders.");
    const settingsRow = await env.DB.prepare("SELECT settings FROM app_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
    const settings = parseJson(settingsRow?.settings, {});
    const availability = qrOrderingState(publication, settings.restaurantName || publication.business_name);
    if (!availability.orderingOpen) throw fail(403, availability.closedMessage);
    const table = await env.DB.prepare("SELECT table_number FROM restaurant_tables WHERE business_id = ? AND CAST(table_number AS TEXT) = ? LIMIT 1").bind(businessId, tableNumber).first();
    if (!table) throw fail(400, "This QR link does not match a table in this POS.");
    const customerId = await upsertGuestCustomer(env, businessId, customer);

    const channels = activeChannels(settings).filter((channel) => channel.qrMenu);
    const priceChannel = channels.find((channel) => channel.key === String(publication.price_channel || "").toLowerCase())?.key
      || channels.find((channel) => channel.key === "online")?.key || channels[0]?.key || "online";
    const channel = channels.find((entry) => entry.key === priceChannel);
    const merged = new Map();
    for (const source of requestedItems) {
      const itemId = Number(source?.itemId ?? source?.menuId);
      const rawVariantId = source?.variantId;
      const variantId = rawVariantId === undefined || rawVariantId === null || rawVariantId === "" ? null : Number(rawVariantId);
      const quantity = Number(source?.quantity);
      if (!Number.isSafeInteger(itemId) || itemId <= 0 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 30 ||
        (variantId !== null && (!Number.isSafeInteger(variantId) || variantId <= 0))) throw fail(400, "One of the order items is invalid.");
      const options = Array.isArray(source?.options) ? source.options : [];
      const optionSignature = JSON.stringify(options.map((set) => [String(set?.setId || ""), (Array.isArray(set?.options) ? set.options : []).map((option) => String(option?.id || "")).sort()]).sort((a, b) => a[0].localeCompare(b[0])));
      const key = `${itemId}:${variantId || 0}:${optionSignature}`;
      const prior = merged.get(key) || { itemId, variantId, quantity: 0, options };
      prior.quantity += quantity;
      if (prior.quantity > 30) throw fail(400, "Choose up to 30 of each menu item.");
      merged.set(key, prior);
    }
    const lines = [...merged.values()];
    const itemIds = [...new Set(lines.map((line) => line.itemId))];
    const menuResult = await env.DB.prepare(
      "SELECT id, name, category, price, channel_prices, sales_channels, available, qr_available, unit, tax_rate, tax_mode, option_set_ids " +
      `FROM menu WHERE business_id = ? AND id IN (${itemIds.map(() => "?").join(",")})`
    ).bind(businessId, ...itemIds).all();
    const menus = new Map((menuResult.results || []).map((row) => [Number(row.id), row]));
    if (menus.size !== itemIds.length || [...menus.values()].some((row) => Number(row.available) !== 1 || Number(row.qr_available) !== 1)) throw fail(409, "A selected menu item is no longer available.");
    const variantIds = [...new Set(lines.map((line) => line.variantId).filter(Boolean))];
    const variantMap = new Map();
    if (variantIds.length) {
      const variants = await env.DB.prepare(
        "SELECT id, menu_id, name, price, channel_prices, unit, option_set_ids, available FROM menu_variants WHERE business_id = ? AND id IN (" + variantIds.map(() => "?").join(",") + ")"
      ).bind(businessId, ...variantIds).all();
      for (const row of variants.results || []) variantMap.set(Number(row.id), row);
    }

    const orderLines = [];
    let subtotal = 0;
    let gst = 0;
    let total = 0;
    for (const line of lines) {
      const menu = menus.get(line.itemId);
      if (!storedChannels(menu.sales_channels, settings).includes(priceChannel)) throw fail(409, "A selected menu item is no longer available on this QR menu.");
      const variant = line.variantId ? variantMap.get(line.variantId) : null;
      if (line.variantId && (!variant || Number(variant.menu_id) !== line.itemId || Number(variant.available) !== 1)) throw fail(409, "A selected size is no longer available.");
      const prices = parseJson(menu.channel_prices, {});
      const variantPrices = parseJson(variant?.channel_prices, {});
      const basePrice = Number(variant ? (variantPrices?.[priceChannel] ?? variant.price) : (prices?.[priceChannel] ?? menu.price));
      if (!Number.isFinite(basePrice) || basePrice < 0) throw fail(400, "A menu price is invalid.");
      const optionData = normalizeOptions(line.options, menu, variant, settings);
      const price = money(basePrice + optionData.addOnPrice);
      const taxRate = settings.gstCalculationEnabled === false ? 0 : Math.max(0, Number(menu.tax_rate || 0));
      const taxMode = menu.tax_mode === "inclusive" ? "inclusive" : "exclusive";
      const gross = money(price * line.quantity);
      const net = taxMode === "inclusive" && taxRate > 0 ? gross / (1 + taxRate / 100) : gross;
      const tax = net * taxRate / 100;
      subtotal += net;
      gst += tax;
      total += taxMode === "inclusive" ? gross : net + tax;
      orderLines.push({ menuId: line.itemId, variantId: line.variantId, itemName: String(menu.name || "Item") + (variant?.name ? " · " + variant.name : ""), price,
        quantity: line.quantity, lineTotal: gross, unit: variant?.unit || menu.unit || "ea", taxRate, taxMode, options: optionData.options });
    }
    subtotal = money(subtotal);
    gst = money(gst);
    total = money(total);
    const analyticsSessionId = String(input.analyticsSessionId || "").trim();
    const sessionKey = /^[a-f0-9]{32,64}$/i.test(analyticsSessionId) ? await sessionKeyFor(businessId, token, analyticsSessionId) : null;
    const assignedTableNumber = orderType === "Dine-in" ? String(table.table_number) : null;
    const current = await getActiveOrder(env, businessId, input, sessionKey, customerId, orderType, assignedTableNumber);
    const note = String(input.notes || "").trim().slice(0, 300);
    const trackingToken = Array.from(crypto.getRandomValues(new Uint8Array(24)), (value) => value.toString(16).padStart(2, "0")).join("");
    const qrChannel = channel || { key: priceChannel, label: "Slash" };
    const businessBrand = await env.DB.prepare("SELECT b.logo_url, COALESCE(brand.show_powered_by_cafe_pilot, 1) AS show_powered_by FROM businesses b LEFT JOIN support_business_branding brand ON brand.business_id = b.id WHERE b.id = ? LIMIT 1").bind(businessId).first();
    const snapshot = receiptSnapshot(settings, businessBrand?.logo_url || "", Number(businessBrand?.show_powered_by) !== 0);

    if (current) {
      const appendedSubtotal = money(subtotal);
      const appendedGst = money(gst);
      const appendedTotal = money(total);
      const shouldCreateKot = ["preparing", "ready"].includes(String(current.status || "").toLowerCase()) && settings.kotEnabled !== false;
      const statements = [env.DB.prepare(
        "UPDATE orders SET subtotal = ROUND(subtotal + ?, 2), gst = ROUND(gst + ?, 2), total = ROUND(total + ?, 2), " +
        "status = CASE WHEN LOWER(status) = 'ready' AND ? = 1 THEN 'Preparing' ELSE status END, " +
        "public_session_key = COALESCE(public_session_key, ?), notes = CASE WHEN ? = '' THEN notes WHEN COALESCE(notes, '') = '' THEN ? ELSE notes || char(10) || ? END, updated_at = CURRENT_TIMESTAMP " +
        "WHERE id = ? AND business_id = ?"
      ).bind(appendedSubtotal, appendedGst, appendedTotal, shouldCreateKot ? 1 : 0, sessionKey, note, note, note, Number(current.id), businessId)];
      for (const item of orderLines) statements.push(env.DB.prepare(
        "INSERT INTO order_items (order_id, menu_id, variant_id, item_name, price, quantity, line_total, unit, tax_rate, tax_mode, business_id, options) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(Number(current.id), item.menuId, item.variantId, item.itemName, item.price, item.quantity, item.lineTotal, item.unit, item.taxRate, item.taxMode, businessId, JSON.stringify(item.options || [])));
      statements.push(env.DB.prepare("UPDATE invoices SET subtotal = (SELECT subtotal FROM orders WHERE id = ? AND business_id = ?), gst = (SELECT gst FROM orders WHERE id = ? AND business_id = ?), total = (SELECT total FROM orders WHERE id = ? AND business_id = ?) WHERE order_id = ? AND business_id = ?")
        .bind(Number(current.id), businessId, Number(current.id), businessId, Number(current.id), businessId, Number(current.id), businessId));
      statements.push(env.DB.prepare(
        "INSERT INTO order_activity (order_id, event_type, description, actor, business_id) VALUES (?, 'QR items added', ?, 'QR guest', ?)"
      ).bind(Number(current.id), `${orderLines.reduce((sum, item) => sum + item.quantity, 0)} more item(s) added from the active QR session.`, businessId));
      if (sessionKey) statements.push(env.DB.prepare(
        "INSERT INTO qr_menu_events (business_id, session_key, event_type, item_count, order_id) VALUES (?, ?, 'order_placed', ?, ?)"
      ).bind(businessId, sessionKey, orderLines.reduce((sum, item) => sum + item.quantity, 0), Number(current.id)));
      if (orderType === "Dine-in") statements.push(env.DB.prepare("UPDATE restaurant_tables SET status = 'Occupied' WHERE business_id = ? AND CAST(table_number AS TEXT) = ?").bind(businessId, String(table.table_number)));
      let ticketNumber = null;
      if (shouldCreateKot) {
        const kot = await buildKotStatements(env, businessId, { orderId: Number(current.id) });
        ticketNumber = kot.ticketNumber;
        statements.push(...kot.statements);
      }
      await env.DB.batch(statements);
      const updated = await env.DB.prepare("SELECT total, status FROM orders WHERE id = ? AND business_id = ? LIMIT 1").bind(Number(current.id), businessId).first();
      return { status: 201, success: true, appended: true, ticketNumber, orderId: Number(current.id), orderNumber: current.order_number,
        tableNumber: current.table_number, sourceTableNumber: String(table.table_number), orderType, total: Number(updated?.total || 0), orderStatus: updated?.status || current.status,
        trackingToken: current.public_tracking_token || String(input.currentOrder?.trackingToken || "") };
    }

    const generated = await chooseOrderNumber(env, businessId, settings);
    const statements = [env.DB.prepare(
      "INSERT INTO orders (order_number, order_type, table_number, subtotal, gst, total, payment_method, status, notes, pax, public_tracking_token, public_session_key, discount, customer_id, sales_channel_key, sales_channel_name, billing_settings_snapshot, business_id) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'Unpaid', 'Pending', ?, 1, ?, ?, 0, ?, ?, ?, ?, ?)"
    ).bind(generated.orderNumber, orderType, assignedTableNumber, subtotal, gst, total, note || "QR order", trackingToken, sessionKey, customerId, priceChannel, qrChannel.label || "Slash", JSON.stringify(snapshot), businessId)];
    statements.push(env.DB.prepare(
      "INSERT INTO business_sequence_counters (business_id, series_key, next_number) VALUES (?, 'qr_order', ?) " +
      "ON CONFLICT(business_id, series_key) DO UPDATE SET next_number = MAX(business_sequence_counters.next_number, excluded.next_number), updated_at = CURRENT_TIMESTAMP"
    ).bind(businessId, generated.next));
    for (const item of orderLines) statements.push(env.DB.prepare(
      "INSERT INTO order_items (order_id, menu_id, variant_id, item_name, price, quantity, line_total, unit, tax_rate, tax_mode, business_id, options) " +
      "SELECT o.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM orders o WHERE o.business_id = ? AND o.order_number = ?"
    ).bind(item.menuId, item.variantId, item.itemName, item.price, item.quantity, item.lineTotal, item.unit, item.taxRate, item.taxMode, businessId, JSON.stringify(item.options || []), businessId, generated.orderNumber));
    statements.push(env.DB.prepare(
      "INSERT INTO order_activity (order_id, event_type, description, actor, business_id) " +
      "SELECT id, 'QR order received', 'QR guest submitted an order.', 'QR guest', business_id FROM orders WHERE business_id = ? AND order_number = ?"
    ).bind(businessId, generated.orderNumber));
    if (sessionKey) statements.push(env.DB.prepare(
      "INSERT INTO qr_menu_events (business_id, session_key, event_type, item_count, order_id) " +
      "SELECT ?, ?, 'order_placed', ?, id FROM orders WHERE business_id = ? AND order_number = ?"
    ).bind(businessId, sessionKey, orderLines.reduce((sum, item) => sum + item.quantity, 0), businessId, generated.orderNumber));
    if (orderType === "Dine-in") statements.push(env.DB.prepare("UPDATE restaurant_tables SET status = 'Occupied' WHERE business_id = ? AND CAST(table_number AS TEXT) = ?").bind(businessId, String(table.table_number)));
    await env.DB.batch(statements);
    const order = await env.DB.prepare("SELECT id, order_number, table_number, total, status FROM orders WHERE business_id = ? AND order_number = ? LIMIT 1").bind(businessId, generated.orderNumber).first();
    if (!order) throw fail(500, "Could not save the QR order.");
    return { status: 201, success: true, appended: false, ticketNumber: null, orderId: Number(order.id), orderNumber: order.order_number,
      tableNumber: order.table_number, sourceTableNumber: String(table.table_number), orderType, total: Number(order.total), orderStatus: order.status, trackingToken };
  } catch (error) {
    return { status: Number(error?.status) || 500, error: Number(error?.status) ? error.message : "Could not place the QR order." };
  }
}
