import { buildKotStatements } from "./kot.js";

const DEFAULT_CHANNELS = [
  { key: "dine_in", label: "Dine in", orderType: "Dine-in", qrMenu: false },
  { key: "takeaway", label: "Takeaway", orderType: "Takeaway", qrMenu: false },
  { key: "delivery", label: "Delivery", orderType: "Takeaway", qrMenu: false },
  { key: "online", label: "Slash", orderType: "Takeaway", qrMenu: true },
];

const SNAPSHOT_KEYS = [
  "restaurantName", "businessLegalName", "businessType", "address", "phone", "gstin", "fssai",
  "header", "footer", "showInvoice", "showCustomer", "showCustomerPhone", "showOrder", "showOrderType",
  "showTable", "showTimestamp", "showGST", "showPayment", "showQR", "uppercaseItems", "wrapItems",
  "gstCalculationEnabled", "currency", "gstRate", "paperWidth", "autoPrint", "autoClose", "billCopies",
  "logoUrl", "upiId", "receiptFont", "customerMessage", "showItemNotes", "totalRoundingMode", "roundTotals",
  "designerShowNotes", "designerShowInvoiceMeta", "designerCompact", "accentLabel", "showPoweredByCafePilot",
];

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function activeChannels(settings) {
  const source = Array.isArray(settings?.posSalesChannels) ? settings.posSalesChannels : [];
  const defaults = new Map(DEFAULT_CHANNELS.map((channel) => [channel.key, channel]));
  const byKey = new Map(source.map((channel) => [String(channel?.key || "").trim().toLowerCase(), channel]));
  const entries = [
    ...DEFAULT_CHANNELS.map((channel) => ({ ...channel, ...(byKey.get(channel.key) || {}) })),
    ...source.filter((channel) => !defaults.has(String(channel?.key || "").trim().toLowerCase())),
  ].slice(0, 44);
  const seen = new Set();
  return entries.flatMap((channel) => {
    const key = String(channel?.key || "").trim().toLowerCase();
    const fixed = defaults.get(key);
    const label = String(fixed?.label || channel?.label || "").trim().slice(0, 60);
    const orderType = fixed?.orderType || (channel?.orderType === "Dine-in" ? "Dine-in" : channel?.orderType === "Takeaway" ? "Takeaway" : "");
    if (!/^[a-z][a-z0-9_]{1,19}$/.test(key) || !label || !orderType || seen.has(key)) return [];
    seen.add(key);
    return [{ key, label, orderType, qrMenu: fixed ? fixed.qrMenu : channel?.qrMenu === true }];
  });
}

export function storedChannels(value, settings) {
  if (value === null || value === undefined) return activeChannels(settings).map((channel) => channel.key);
  const parsed = parseJson(value, value);
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.map((channel) => String(channel || "").trim().toLowerCase().replace(/[\s-]+/g, "_")).filter(Boolean))];
}

function marketingScheduleUnavailableReason(deal, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const dayKey = ({ Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" })[values.weekday];
  const week = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const previousDay = week[(week.indexOf(dayKey) + 6) % 7];
  const today = `${values.year}-${values.month}-${values.day}`;
  if (deal?.startDate && String(deal.startDate) > today) return "The deal has not started yet.";
  if (deal?.endDate && String(deal.endDate) < today) return "The deal has ended.";
  const days = Array.isArray(deal?.days) && deal.days.length
    ? deal.days.map((day) => String(day).toLowerCase()).filter((day) => week.includes(day))
    : week;
  const startTime = String(deal?.startTime || "").trim();
  const endTime = String(deal?.endTime || "").trim();
  if (Boolean(startTime) !== Boolean(endTime)) return "Both deal times must be set.";
  if (!startTime) return days.includes(dayKey) ? "" : "The deal is not available today.";
  const parseTime = (value) => {
    const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const start = parseTime(startTime);
  const end = parseTime(endTime);
  if (start === null || end === null || start === end) return "Deal hours are invalid.";
  const minute = Number(values.hour) * 60 + Number(values.minute);
  const inWindow = start < end
    ? days.includes(dayKey) && minute >= start && minute < end
    : (days.includes(dayKey) && minute >= start) || (days.includes(previousDay) && minute < end);
  return inWindow ? "" : "The deal is outside its available days or hours.";
}

async function resolveBillingRules(env, businessId, settings, body, channelKey, fallback = {}) {
  const valueOrFallback = (camel, snake, fallbackValue) => {
    if (Object.prototype.hasOwnProperty.call(body, camel)) return body[camel];
    if (Object.prototype.hasOwnProperty.call(body, snake)) return body[snake];
    return fallbackValue;
  };
  const rawMarketingId = valueOrFallback("marketingDealId", "marketing_deal_id", fallback.marketingDealId ?? null);
  const marketingDealId = rawMarketingId ? String(rawMarketingId).trim().slice(0, 120) : null;
  let marketingDeal = null;
  if (marketingDealId) {
    const lookupId = marketingDealId.replace(/^marketing:/, "");
    marketingDeal = (Array.isArray(settings.marketingDeals) ? settings.marketingDeals : [])
      .find((deal) => String(deal?.id) === lookupId);
    if (!marketingDeal || marketingDeal.active === false) throw failure(400, "The selected marketing deal is no longer available.");
    const dealChannels = Array.isArray(marketingDeal.channels)
      ? marketingDeal.channels.map((value) => String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_")) : [];
    if (dealChannels.length && !dealChannels.includes(String(channelKey).toLowerCase())) throw failure(400, "The selected marketing deal is not available on this sale channel.");
    const unavailable = marketingScheduleUnavailableReason(marketingDeal);
    if (unavailable) throw failure(400, "The selected marketing deal cannot be used now. " + unavailable);
  }

  const readAdjustment = async (rawId, expectedKind, fallbackId, fallbackName) => {
    const value = rawId ?? fallbackId ?? null;
    if (value === null || value === undefined || value === "") return { id: null, name: null };
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw failure(400, "The selected discount or charge is invalid.");
    const row = await env.DB.prepare(
      "SELECT id, name, kind, applies_to, active FROM billing_adjustments WHERE id = ? AND business_id = ? LIMIT 1"
    ).bind(id, businessId).first();
    if (!row || !Boolean(row.active) || String(row.kind || "").toLowerCase() !== expectedKind) throw failure(400, "The selected discount or charge is no longer active.");
    const appliesTo = String(row.applies_to || "all").toLowerCase().replace(/[\s-]+/g, "_");
    if (appliesTo !== "all" && appliesTo !== String(channelKey).toLowerCase()) throw failure(400, "The selected discount or charge is not available on this sale channel.");
    return { id, name: String(fallbackName || row.name || "").slice(0, 120) || null };
  };
  const discountAdjustmentId = valueOrFallback("discountAdjustmentId", "discount_adjustment_id", fallback.discountAdjustmentId);
  const discountAdjustmentName = valueOrFallback("discountAdjustmentName", "discount_adjustment_name", fallback.discountAdjustmentName);
  const chargeAdjustmentId = valueOrFallback("chargeAdjustmentId", "charge_adjustment_id", fallback.chargeAdjustmentId);
  const chargeAdjustmentName = valueOrFallback("chargeAdjustmentName", "charge_adjustment_name", fallback.chargeAdjustmentName);
  const discountRule = await readAdjustment(discountAdjustmentId, "discount", null, discountAdjustmentName);
  const chargeRule = await readAdjustment(chargeAdjustmentId, "charge", null, chargeAdjustmentName);
  return {
    marketingDealId,
    marketingDealName: marketingDeal ? String(body.marketingDealName ?? body.marketing_deal_name ?? marketingDeal.name ?? "Deal").slice(0, 120) : null,
    discountAdjustmentId: discountRule.id,
    discountAdjustmentName: discountRule.name,
    chargeAdjustmentId: chargeRule.id,
    chargeAdjustmentName: chargeRule.name,
  };
}

async function applyItemDiscounts(env, businessId, channelKey, items, lineNets) {
  const ruleIds = [...new Set(items.map((item) => Number(item.itemDiscountRuleId) || 0).filter((id) => id > 0))];
  const rules = new Map();
  if (ruleIds.length) {
    const result = await env.DB.prepare(
      "SELECT id, name, kind, calculation, value, applies_to, active, application_level " +
      "FROM billing_adjustments WHERE business_id = ? AND id IN (" + ruleIds.map(() => "?").join(",") + ")"
    ).bind(businessId, ...ruleIds).all();
    for (const row of result.results || []) rules.set(Number(row.id), row);
  }
  let itemDiscountTotal = 0;
  items.forEach((item, index) => {
    const id = Number(item.itemDiscountRuleId) || 0;
    if (!id) {
      item.itemDiscountRuleId = null;
      item.itemDiscountAmount = 0;
      item.itemDiscountName = null;
      return;
    }
    const rule = rules.get(id);
    const appliesTo = String(rule?.applies_to || "all").toLowerCase().replace(/[\s-]+/g, "_");
    if (!rule || !Boolean(rule.active) || String(rule.kind || "").toLowerCase() !== "discount"
      || String(rule.application_level || "order").toLowerCase() !== "item"
      || (appliesTo !== "all" && appliesTo !== String(channelKey).toLowerCase())) {
      throw failure(400, "One of the selected item discounts is no longer available for this sale channel.");
    }
    const lineNet = lineNets[index];
    const value = Math.max(0, Number(rule.value) || 0);
    const raw = String(rule.calculation || "").toLowerCase() === "percent"
      ? lineNet * value / 100
      : value * item.quantity;
    item.itemDiscountRuleId = id;
    item.itemDiscountAmount = money(Math.min(lineNet, Math.max(0, raw)));
    item.itemDiscountName = String(rule.name || "Item discount").slice(0, 120);
    itemDiscountTotal += item.itemDiscountAmount;
  });
  return money(itemDiscountTotal);
}

export function normalizeOptions(value, menu, variant, settings) {
  const submitted = Array.isArray(value) ? value.slice(0, 30) : [];
  const metadata = [];
  const selected = new Map();
  for (const optionSet of submitted) {
    const setId = String(optionSet?.setId || "").slice(0, 80);
    const setName = String(optionSet?.setName || "").trim().slice(0, 100);
    const choices = (Array.isArray(optionSet?.options) ? optionSet.options : []).slice(0, 50);
    if (setId === "__slash_custom_instruction__") {
      const choice = choices[0];
      const name = String(choice?.name || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 250);
      if (choices.length !== 1 || !/^instruction_[a-z0-9_]{1,70}$/i.test(String(choice?.id || "")) || !name) {
        throw failure(400, "Add one valid cooking instruction or remove it.");
      }
      metadata.push({ setId, setName: "Cooking Instruction", options: [{ id: String(choice.id), name, price: 0 }] });
      continue;
    }
    if (setId === "__slash_back_order__") {
      if (choices.length !== 1 || String(choices[0]?.id || "") !== "back_order") throw failure(400, "Invalid Back Order selection.");
      metadata.push({ setId, setName: "Order Handling", options: [{ id: "back_order", name: "Back Order", price: 0 }] });
      continue;
    }
    if (!setId || setId.startsWith("__slash_") || !setName || selected.has(setId)) throw failure(400, "One of the selected options is not available for this item.");
    selected.set(setId, choices.map((choice) => ({ id: String(choice?.id || "") })));
  }

  const menuSetIds = parseJson(menu.option_set_ids, []);
  const variantSetIds = parseJson(variant?.option_set_ids, []);
  const assignedIds = [...new Set([
    ...(Array.isArray(menuSetIds) ? menuSetIds : []),
    ...(Array.isArray(variantSetIds) ? variantSetIds : []),
  ].map(String))];
  const configured = Array.isArray(settings?.menuOptionSets) ? settings.menuOptionSets : [];
  const normalized = [];
  let addOnPrice = 0;
  for (const setId of assignedIds) {
    const set = configured.find((entry) => String(entry?.id) === setId);
    if (!set) continue;
    const choices = selected.get(setId) || [];
    const min = Math.max(0, Number(set.minSelections) || 0);
    const max = Math.max(1, Number(set.maxSelections) || 1);
    if (choices.length < min || choices.length > max) throw failure(400, "Choose the required options for " + String(set.name || "this item") + ".");
    const savedChoices = [];
    for (const choice of choices) {
      const saved = (Array.isArray(set.options) ? set.options : []).find((entry) => String(entry?.id) === choice.id);
      if (!saved) throw failure(400, "An option for " + String(set.name || "this item") + " is no longer available.");
      const price = Math.max(0, Number(saved.price) || 0);
      addOnPrice += price;
      savedChoices.push({ id: String(saved.id), name: String(saved.name || ""), price });
    }
    if (savedChoices.length) normalized.push({ setId, setName: String(set.name || ""), options: savedChoices });
    selected.delete(setId);
  }
  if (selected.size) throw failure(400, "One of the selected options is not available for this item.");
  return { options: [...normalized, ...metadata], addOnPrice: money(addOnPrice) };
}

export function receiptSnapshot(settings, logoUrl, poweredBy) {
  const snapshot = {};
  for (const key of SNAPSHOT_KEYS) if (Object.prototype.hasOwnProperty.call(settings || {}, key)) snapshot[key] = settings[key];
  snapshot.businessLogoUrl = String(logoUrl || "");
  snapshot.showPoweredByCafePilot = poweredBy !== false;
  return snapshot;
}

export async function createOpenOrder(request, env, businessId, bridgeClaims) {
  if (String(env.D1_STAGING_ORDER_WRITES_ENABLED || "").toLowerCase() !== "true") {
    return { status: 503, error: "D1 staging order writes are disabled until the write pilot is enabled." };
  }
  if (!bridgeClaims || bridgeClaims.scope !== "new_order.create" || Number(bridgeClaims.business_id) !== businessId) {
    return { status: 403, error: "A signed order-creation permission is required." };
  }

  try {
    const raw = await request.text();
    if (raw.length > 65536) throw failure(413, "Order request is too large.");
    let body;
    try { body = JSON.parse(raw || "{}"); } catch { throw failure(400, "Invalid order request JSON."); }

    const orderType = String(body.orderType || body.order_type || "");
    if (orderType !== "Dine-in" && orderType !== "Takeaway") throw failure(400, "Choose Dine-in or Takeaway for this order.");
    if (String(body.initialStatus || body.status || "") !== "Open") throw failure(409, "The staging pilot currently supports saved Open orders only.");
    if (body.checkout && typeof body.checkout === "object") throw failure(409, "Checkout and payment writes are not enabled in the D1 pilot yet.");
    const discount = Number(body.discount || 0);
    const serviceCharge = Number(body.serviceCharge ?? body.service_charge ?? 0);
    if (!Number.isFinite(discount) || discount < 0 || !Number.isFinite(serviceCharge) || serviceCharge < 0) throw failure(400, "Discount or service charge is invalid.");
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) throw failure(400, "Add between 1 and 50 order items.");

    const tableNumber = orderType === "Dine-in" ? String(body.tableNumber || body.table_number || "").trim().slice(0, 80) : null;
    const pax = orderType === "Dine-in" ? Number(body.pax) || 1 : null;
    if (orderType === "Dine-in" && (!tableNumber || !Number.isInteger(pax) || pax < 1 || pax > 100)) throw failure(400, "Select a valid dine-in table and guest count.");

    const settingsRow = await env.DB.prepare("SELECT settings FROM app_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
    const settings = parseJson(settingsRow?.settings, {});
    const channels = activeChannels(settings);
    const preference = settings?.posChannelPreferences?.[orderType === "Dine-in" ? "tableView" : "newOrder"]?.defaultChannel;
    const channelKey = String(body.saleChannelKey || preference || (orderType === "Dine-in" ? "dine_in" : "takeaway")).trim().toLowerCase();
    const channel = channels.find((entry) => entry.key === channelKey);
    if (!channel || (channel.orderType !== orderType && channel.qrMenu !== true)) throw failure(400, "Choose an active sale channel that matches this order type.");
    const billingRules = await resolveBillingRules(env, businessId, settings, body, channel.key);

    const inputItems = body.items.map((source) => {
      const menuId = Number(source?.menuId ?? source?.menu_id ?? source?.id);
      const quantity = Number(source?.quantity);
      const variantId = Number(source?.variantId ?? source?.variant_id) || null;
      const itemDiscountRuleId = Number(source?.itemDiscountRuleId ?? source?.item_discount_rule_id) || null;
      if (!Number.isSafeInteger(menuId) || menuId <= 0 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999 || (variantId !== null && (!Number.isSafeInteger(variantId) || variantId <= 0))) {
        throw failure(400, "Invalid order item information.");
      }
      if (itemDiscountRuleId !== null && (!Number.isSafeInteger(itemDiscountRuleId) || itemDiscountRuleId <= 0)) throw failure(400, "Invalid item discount selection.");
      return { source, menuId, quantity, variantId, itemDiscountRuleId };
    });
    const menuIds = [...new Set(inputItems.map((item) => item.menuId))];
    const menuResult = await env.DB.prepare(`
      SELECT id, name, price, channel_prices, sales_channels, available, unit, tax_rate, tax_mode,
             option_set_ids, is_open_item
      FROM menu WHERE business_id = ? AND id IN (${menuIds.map(() => "?").join(",")})
    `).bind(businessId, ...menuIds).all();
    const menus = new Map((menuResult.results || []).map((row) => [Number(row.id), row]));
    if (menus.size !== menuIds.length || [...menus.values()].some((row) => !Boolean(row.available))) throw failure(409, "One of the menu items is no longer available for this business.");

    const variantIds = [...new Set(inputItems.map((item) => item.variantId).filter(Boolean))];
    const variants = new Map();
    if (variantIds.length) {
      const result = await env.DB.prepare(`
        SELECT id, menu_id, name, price, channel_prices, unit, option_set_ids, available
        FROM menu_variants WHERE business_id = ? AND id IN (${variantIds.map(() => "?").join(",")})
      `).bind(businessId, ...variantIds).all();
      for (const row of result.results || []) variants.set(Number(row.id), row);
    }

    const items = [];
    const lineNets = [];
    for (const input of inputItems) {
      const menu = menus.get(input.menuId);
      if (!storedChannels(menu.sales_channels, settings).includes(channel.key)) throw failure(409, "A menu item is not available on the selected sale channel.");
      const variant = input.variantId ? variants.get(input.variantId) : null;
      if (input.variantId && (!variant || Number(variant.menu_id) !== input.menuId || !Boolean(variant.available))) throw failure(409, "One of the selected item sizes is no longer available.");
      const openItem = Boolean(menu.is_open_item);
      if (openItem && (input.variantId || (Array.isArray(input.source.options) && input.source.options.length))) throw failure(400, "Open items cannot use variants or add-on options.");
      const menuPrices = parseJson(menu.channel_prices, {});
      const variantPrices = parseJson(variant?.channel_prices, {});
      const basePrice = openItem ? Number(input.source.price ?? input.source.basePrice) : Number(variant ? (variantPrices?.[channel.key] ?? variant.price) : (menuPrices?.[channel.key] ?? menu.price));
      const name = openItem ? String(input.source.name || "").trim().slice(0, 160) : String(menu.name || "Item") + (variant?.name ? " - " + variant.name : "");
      if (!name || !Number.isFinite(basePrice) || basePrice < 0) throw failure(400, "One of the menu prices or item names is invalid.");
      const optionData = openItem ? { options: [], addOnPrice: 0 } : normalizeOptions(input.source.options, menu, variant, settings);
      const price = money(basePrice + optionData.addOnPrice);
      const taxRate = settings.gstCalculationEnabled === false ? 0 : Math.max(0, Number(menu.tax_rate || 0));
      const taxMode = menu.tax_mode === "inclusive" ? "inclusive" : "exclusive";
      const lineNet = taxMode === "inclusive" && taxRate > 0 ? price * input.quantity / (1 + taxRate / 100) : price * input.quantity;
      lineNets.push(lineNet);
      items.push({ menuId: input.menuId, variantId: input.variantId, name, price, quantity: input.quantity,
        unit: variant?.unit || menu.unit || "ea", taxRate, taxMode, options: optionData.options,
        itemDiscountRuleId: input.itemDiscountRuleId });
    }

    const subtotal = money(lineNets.reduce((sum, value) => sum + value, 0));
    const itemDiscountTotal = await applyItemDiscounts(env, businessId, channel.key, items, lineNets);
    const orderDiscountBase = Math.max(0, subtotal - itemDiscountTotal);
    if (discount > orderDiscountBase + 0.01) throw failure(400, "Discount must be between 0 and the remaining order subtotal.");
    let discountRemaining = Math.min(discount, orderDiscountBase);
    let discountAssigned = 0;
    let gst = 0;
    items.forEach((item, index) => {
      const lineNet = Math.max(0, lineNets[index] - Number(item.itemDiscountAmount || 0));
      const lineDiscount = index === items.length - 1
        ? Math.min(lineNet, discountRemaining)
        : Math.min(lineNet, orderDiscountBase > 0 ? discount * lineNet / orderDiscountBase : 0);
      discountRemaining = Math.max(0, discountRemaining - lineDiscount);
      discountAssigned += lineDiscount;
      gst += Math.max(0, lineNet - lineDiscount) * item.taxRate / 100;
    });
    gst = money(gst);
    const totalDiscount = money(itemDiscountTotal + discountAssigned);
    const total = money(Math.max(0, subtotal - totalDiscount) + serviceCharge + gst);
    let customerId = body.customerId === null || body.customerId === undefined || body.customerId === "" ? null : Number(body.customerId);
    if (customerId !== null) {
      if (!Number.isSafeInteger(customerId) || customerId <= 0) {
        customerId = null;
      } else {
        const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ? AND business_id = ? LIMIT 1").bind(customerId, businessId).first();
        if (!customer) customerId = null;
      }
    }
    const business = await env.DB.prepare("SELECT logo_url FROM businesses WHERE id = ? AND active = 1 LIMIT 1").bind(businessId).first();
    if (!business) throw failure(404, "Business not found or inactive.");
    const branding = await env.DB.prepare("SELECT show_powered_by_cafe_pilot FROM support_business_branding WHERE business_id = ? LIMIT 1").bind(businessId).first();
    const snapshot = receiptSnapshot(settings, business.logo_url, branding ? Boolean(branding.show_powered_by_cafe_pilot) : true);

    const prefix = String(settings.orderPrefix ?? "ORD-").slice(0, 24);
    const padding = Math.max(1, Math.min(12, Math.floor(Number(settings.orderNumberPadding) || 4)));
    const start = Math.max(1, Math.floor(Number(settings.orderSequenceStart) || 1));
    const sequenceStart = prefix.length + 1;
    const maxOrder = await env.DB.prepare(`
      SELECT MAX(CAST(substr(order_number, ?) AS INTEGER)) AS max_number
      FROM orders WHERE substr(order_number, 1, ?) = ? AND substr(order_number, ?) <> ''
        AND substr(order_number, ?) NOT GLOB '*[^0-9]*'
    `).bind(sequenceStart, prefix.length, prefix, sequenceStart, sequenceStart).first();
    const counter = await env.DB.prepare("SELECT next_number FROM business_sequence_counters WHERE business_id = ? AND series_key = 'pos_order' LIMIT 1").bind(businessId).first();
    let sequence = Math.max(start, Number(counter?.next_number) || 1, (Number(maxOrder?.max_number) || 0) + 1);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const orderNumber = prefix + String(sequence).padStart(padding, "0");
      const statements = [];
      if (orderType === "Dine-in") {
        statements.push(env.DB.prepare(`
          UPDATE restaurant_tables SET status = 'Occupied'
          WHERE business_id = ? AND table_number = ? AND status = 'Available'
            AND (capacity <= 0 OR capacity >= ?)
        `).bind(businessId, tableNumber, pax));
      }
      const insertOrderIndex = statements.length;
      statements.push(env.DB.prepare(`
        INSERT INTO orders (
          order_number, order_type, table_number, subtotal, gst, total, status, customer_id,
          discount, service_charge, notes, marketing_deal_id, marketing_deal_name, discount_adjustment_id,
          discount_adjustment_name, charge_adjustment_id, charge_adjustment_name, pax, business_id,
          sales_channel_key, sales_channel_name, billing_settings_snapshot
        )
        SELECT ?, ?, ?, ?, ?, ?, 'Open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM orders WHERE order_number = ?)
          AND (? <> 'Dine-in' OR changes() = 1)
      `).bind(orderNumber, orderType, tableNumber, subtotal, gst, total, customerId, totalDiscount, serviceCharge,
        body.notes ? String(body.notes).slice(0, 1000) : null, billingRules.marketingDealId, billingRules.marketingDealName,
        billingRules.discountAdjustmentId, billingRules.discountAdjustmentName, billingRules.chargeAdjustmentId, billingRules.chargeAdjustmentName,
        pax, businessId, channel.key, channel.label, JSON.stringify(snapshot), orderNumber, orderType));
      statements.push(env.DB.prepare(`
        INSERT INTO business_sequence_counters (business_id, series_key, next_number)
        VALUES (?, 'pos_order', ?)
        ON CONFLICT(business_id, series_key) DO UPDATE SET
          next_number = MAX(business_sequence_counters.next_number, excluded.next_number),
          updated_at = CURRENT_TIMESTAMP
      `).bind(businessId, sequence + 1));
      for (const item of items) {
        statements.push(env.DB.prepare(`
          INSERT INTO order_items (
            order_id, menu_id, variant_id, item_name, price, quantity, line_total, unit, tax_rate,
            tax_mode, business_id, options, item_discount_rule_id, item_discount_amount, item_discount_name
          )
          SELECT o.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          FROM orders o WHERE o.business_id = ? AND o.order_number = ?
        `).bind(item.menuId, item.variantId, item.name, item.price, item.quantity, money(item.price * item.quantity), item.unit, item.taxRate, item.taxMode,
          businessId, JSON.stringify(item.options), item.itemDiscountRuleId, Number(item.itemDiscountAmount || 0), item.itemDiscountName, businessId, orderNumber));
      }
      statements.push(env.DB.prepare(`
        INSERT INTO order_activity (order_id, event_type, description, actor, business_id, actor_user_id)
        SELECT o.id, 'Order created', 'Order created with status Open.',
          COALESCE(u.display_name, u.username, 'Staff'), o.business_id, ?
        FROM orders o LEFT JOIN app_users u ON u.id = ? AND u.business_id = o.business_id
        WHERE o.business_id = ? AND o.order_number = ?
      `).bind(Number(bridgeClaims.sub), Number(bridgeClaims.sub), businessId, orderNumber));

      if (body.createKot === true && settings.kotEnabled !== false) {
        const kot = await buildKotStatements(env, businessId, { orderNumber });
        statements.push(...kot.statements);
      }
      try {
        const batchResults = await env.DB.batch(statements);
        const insertedOrder = Number(batchResults?.[insertOrderIndex]?.meta?.changes || 0) > 0;
        if (!insertedOrder) {
          const reservationSucceeded = orderType !== "Dine-in" || Number(batchResults?.[0]?.meta?.changes || 0) > 0;
          if (!reservationSucceeded) throw failure(409, "The selected table is unavailable or too small. Refresh and try again.");
          if (orderType === "Dine-in") {
            await env.DB.prepare(`
              UPDATE restaurant_tables SET status = 'Available'
              WHERE business_id = ? AND table_number = ? AND status = 'Occupied'
                AND NOT EXISTS (
                  SELECT 1 FROM orders WHERE business_id = ? AND table_number = ?
                    AND LOWER(COALESCE(status, '')) NOT IN ('completed', 'cancelled')
                )
            `).bind(businessId, tableNumber, businessId, tableNumber).run();
          }
          sequence += 1;
          continue;
        }
        const order = await env.DB.prepare(`
          SELECT id, business_id, order_number, order_type, table_number, subtotal, gst, total,
            payment_method, status, created_at, updated_at, customer_id, discount, service_charge,
            notes, marketing_deal_id, marketing_deal_name, discount_adjustment_id, discount_adjustment_name,
            charge_adjustment_id, charge_adjustment_name, pax, sales_channel_key, sales_channel_name, billing_settings_snapshot
          FROM orders WHERE business_id = ? AND order_number = ? LIMIT 1
        `).bind(businessId, orderNumber).first();
        if (!order) throw failure(409, "The selected table became unavailable. Refresh and try again.");
        const savedItems = await env.DB.prepare(`
          SELECT id, order_id, business_id, menu_id, item_name, price, quantity, line_total, variant_id,
            unit, tax_rate, tax_mode, options, item_discount_rule_id, item_discount_amount, item_discount_name
          FROM order_items WHERE business_id = ? AND order_id = ? ORDER BY id
        `).bind(businessId, Number(order.id)).all();
        return { status: 201, success: true, order, items: (savedItems.results || []).map((item) => ({ ...item, options: parseJson(item.options, []) })) };
      } catch (error) {
        if (/orders\.order_number|UNIQUE constraint failed: orders/i.test(String(error?.message || "")) && attempt < 4) {
          sequence += 1;
          continue;
        }
        throw error;
      }
    }
    throw failure(409, "Could not allocate a unique order number. Try again.");
  } catch (error) {
    console.error("D1 open-order creation failed", {
      businessId,
      name: String(error?.name || "Error").slice(0, 80),
      message: String(error?.message || "Unknown D1 error").slice(0, 500),
    });
    return { status: Number(error?.status) || 500, error: error?.status ? error.message : "D1 order creation failed." };
  }
}

export async function updateOpenOrder(request, env, businessId, bridgeClaims, orderId) {
  if (String(env.D1_STAGING_ORDER_WRITES_ENABLED || "").toLowerCase() !== "true") {
    return { status: 503, error: "D1 staging order writes are disabled until the write pilot is enabled." };
  }
  if (!bridgeClaims || bridgeClaims.scope !== "orders.edit_open" || Number(bridgeClaims.business_id) !== businessId) {
    return { status: 403, error: "A signed open-order edit permission is required." };
  }
  try {
    const raw = await request.text();
    if (raw.length > 65536) throw failure(413, "Order request is too large.");
    let body;
    try { body = JSON.parse(raw || "{}"); } catch { throw failure(400, "Invalid order update JSON."); }
    const order = await env.DB.prepare(
      "SELECT * FROM orders WHERE id = ? AND business_id = ? LIMIT 1"
    ).bind(orderId, businessId).first();
    if (!order) throw failure(404, "Order not found.");
    const orderStatus = String(order.status || "").trim().toLowerCase();
    if (orderStatus === "cancelled") throw failure(409, "Cancelled orders cannot be edited.");
    const isQrOrder = Boolean(order.public_tracking_token) || /^QR-/i.test(String(order.order_number || ""));
    const isQrReadyOrder = isQrOrder && orderStatus === "ready";
    if (!["open", "completed"].includes(orderStatus) && !isQrReadyOrder) {
      throw failure(409, isQrOrder ? "QR orders must be accepted and marked ready before checkout." : "This D1 order cannot be edited in its current status.");
    }
    const isClosedBill = orderStatus === "completed";
    const expectedStatusSql = isClosedBill ? "'Completed'" : isQrReadyOrder ? "'Ready'" : "'Open'";
    const activityEventSql = isClosedBill ? "'Closed bill edited'" : "'Order updated'";
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) throw failure(400, "Add between 1 and 50 order items.");
    const oldItemsResult = await env.DB.prepare(
      "SELECT id, menu_id, variant_id, item_name, quantity, options, item_discount_amount FROM order_items WHERE business_id = ? AND order_id = ? ORDER BY id"
    ).bind(businessId, orderId).all();
    const oldItems = oldItemsResult.results || [];
    const oldItemDiscountTotal = oldItems.reduce((sum, item) => sum + Math.max(0, Number(item.item_discount_amount) || 0), 0);
    const priorOrderDiscount = Math.max(0, (Number(order.discount) || 0) - oldItemDiscountTotal);
    const discount = Number(body.discount ?? priorOrderDiscount);
    const serviceCharge = Number(body.serviceCharge ?? body.service_charge ?? order.service_charge ?? 0);
    if (!Number.isFinite(discount) || discount < 0 || !Number.isFinite(serviceCharge) || serviceCharge < 0) throw failure(400, "Discount or service charge is invalid.");
    const orderType = String(order.order_type || "");
    if (String(body.orderType || body.order_type || orderType) !== orderType
      || String(body.tableNumber ?? body.table_number ?? order.table_number ?? "") !== String(order.table_number || "")) {
      throw failure(409, "Changing an existing D1 order's type or table is not enabled yet.");
    }

    const settingsRow = await env.DB.prepare("SELECT settings FROM app_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
    const settings = parseJson(settingsRow?.settings, {});
    const channels = activeChannels(settings);
    const preferredChannel = String(body.saleChannelKey || order.sales_channel_key || (orderType === "Dine-in" ? "dine_in" : "takeaway")).trim().toLowerCase();
    const channel = channels.find((entry) => entry.key === preferredChannel);
    if (!channel || (channel.orderType !== orderType && channel.qrMenu !== true)) throw failure(400, "Choose an active sale channel that matches this order type.");
    const billingRules = await resolveBillingRules(env, businessId, settings, body, channel.key, {
      marketingDealId: order.marketing_deal_id,
      marketingDealName: order.marketing_deal_name,
      discountAdjustmentId: order.discount_adjustment_id,
      discountAdjustmentName: order.discount_adjustment_name,
      chargeAdjustmentId: order.charge_adjustment_id,
      chargeAdjustmentName: order.charge_adjustment_name,
    });

    const inputItems = body.items.map((source) => {
      const menuId = Number(source?.menuId ?? source?.menu_id ?? source?.id);
      const quantity = Number(source?.quantity);
      const variantId = Number(source?.variantId ?? source?.variant_id) || null;
      const itemDiscountRuleId = Number(source?.itemDiscountRuleId ?? source?.item_discount_rule_id) || null;
      if (!Number.isSafeInteger(menuId) || menuId <= 0 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999
        || (variantId !== null && (!Number.isSafeInteger(variantId) || variantId <= 0))
        || (itemDiscountRuleId !== null && (!Number.isSafeInteger(itemDiscountRuleId) || itemDiscountRuleId <= 0))) throw failure(400, "Invalid order item information.");
      return { source, menuId, quantity, variantId, itemDiscountRuleId };
    });
    const menuIds = [...new Set(inputItems.map((item) => item.menuId))];
    const menuResult = await env.DB.prepare(
      "SELECT id, name, price, channel_prices, sales_channels, available, unit, tax_rate, tax_mode, option_set_ids, is_open_item " +
      "FROM menu WHERE business_id = ? AND id IN (" + menuIds.map(() => "?").join(",") + ")"
    ).bind(businessId, ...menuIds).all();
    const menus = new Map((menuResult.results || []).map((row) => [Number(row.id), row]));
    if (menus.size !== menuIds.length || [...menus.values()].some((row) => !Boolean(row.available))) throw failure(409, "One of the menu items is no longer available for this business.");
    const variantIds = [...new Set(inputItems.map((item) => item.variantId).filter(Boolean))];
    const variants = new Map();
    if (variantIds.length) {
      const result = await env.DB.prepare(
        "SELECT id, menu_id, name, price, channel_prices, unit, option_set_ids, available " +
        "FROM menu_variants WHERE business_id = ? AND id IN (" + variantIds.map(() => "?").join(",") + ")"
      ).bind(businessId, ...variantIds).all();
      for (const row of result.results || []) variants.set(Number(row.id), row);
    }

    const items = [];
    const lineNets = [];
    for (const input of inputItems) {
      const menu = menus.get(input.menuId);
      if (!storedChannels(menu.sales_channels, settings).includes(channel.key)) throw failure(409, "A menu item is not available on the selected sale channel.");
      const variant = input.variantId ? variants.get(input.variantId) : null;
      if (input.variantId && (!variant || Number(variant.menu_id) !== input.menuId || !Boolean(variant.available))) throw failure(409, "One of the selected item sizes is no longer available.");
      const openItem = Boolean(menu.is_open_item);
      if (openItem && (input.variantId || (Array.isArray(input.source.options) && input.source.options.length))) throw failure(400, "Open items cannot use variants or add-on options.");
      const menuPrices = parseJson(menu.channel_prices, {});
      const variantPrices = parseJson(variant?.channel_prices, {});
      const basePrice = openItem ? Number(input.source.price ?? input.source.basePrice)
        : Number(variant ? (variantPrices?.[channel.key] ?? variant.price) : (menuPrices?.[channel.key] ?? menu.price));
      const name = openItem ? String(input.source.name || "").trim().slice(0, 160)
        : String(menu.name || "Item") + (variant?.name ? " - " + variant.name : "");
      if (!name || !Number.isFinite(basePrice) || basePrice < 0) throw failure(400, "One of the menu prices or item names is invalid.");
      const optionData = openItem ? { options: [], addOnPrice: 0 } : normalizeOptions(input.source.options, menu, variant, settings);
      const price = money(basePrice + optionData.addOnPrice);
      const taxRate = settings.gstCalculationEnabled === false ? 0 : Math.max(0, Number(menu.tax_rate || 0));
      const taxMode = menu.tax_mode === "inclusive" ? "inclusive" : "exclusive";
      const lineNet = taxMode === "inclusive" && taxRate > 0 ? price * input.quantity / (1 + taxRate / 100) : price * input.quantity;
      lineNets.push(lineNet);
      items.push({ menuId: input.menuId, variantId: input.variantId, name, price, quantity: input.quantity,
        unit: variant?.unit || menu.unit || "ea", taxRate, taxMode, options: optionData.options,
        itemDiscountRuleId: input.itemDiscountRuleId });
    }
    const subtotal = money(lineNets.reduce((sum, value) => sum + value, 0));
    const itemDiscountTotal = await applyItemDiscounts(env, businessId, channel.key, items, lineNets);
    const orderDiscountBase = Math.max(0, subtotal - itemDiscountTotal);
    if (discount > orderDiscountBase + 0.01) throw failure(400, "Discount must be between 0 and the remaining order subtotal.");
    let discountRemaining = Math.min(discount, orderDiscountBase);
    let discountAssigned = 0;
    let gst = 0;
    items.forEach((item, index) => {
      const lineNet = Math.max(0, lineNets[index] - Number(item.itemDiscountAmount || 0));
      const lineDiscount = index === items.length - 1
        ? Math.min(lineNet, discountRemaining)
        : Math.min(lineNet, orderDiscountBase > 0 ? discount * lineNet / orderDiscountBase : 0);
      discountRemaining = Math.max(0, discountRemaining - lineDiscount);
      discountAssigned += lineDiscount;
      gst += Math.max(0, lineNet - lineDiscount) * item.taxRate / 100;
    });
    gst = money(gst);
    const totalDiscount = money(itemDiscountTotal + discountAssigned);
    const total = money(Math.max(0, subtotal - totalDiscount) + serviceCharge + gst);
    const collectedRow = await env.DB.prepare(
      "SELECT COALESCE(SUM(amount), 0) AS amount FROM payments WHERE business_id = ? AND order_id = ? AND payment_status = 'Success'"
    ).bind(businessId, orderId).first();
    if (total + 0.01 < Number(collectedRow?.amount || 0)) throw failure(409, "The updated bill cannot be less than the amount already paid.");

    const customerSupplied = Object.prototype.hasOwnProperty.call(body, "customerId") || Object.prototype.hasOwnProperty.call(body, "customer_id");
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

    const oldItemsById = new Map(oldItems.map((item) => [Number(item.id), item]));
    const itemIdentity = (item) => JSON.stringify([
      Number(item.menu_id ?? item.menuId) || null, Number(item.variant_id ?? item.variantId) || null,
      String(item.item_name ?? item.name ?? ""), parseJson(item.options, []),
    ]);
    const oldQuantities = new Map();
    const nextQuantities = new Map();
    for (const item of oldItems) oldQuantities.set(itemIdentity(item), (oldQuantities.get(itemIdentity(item)) || 0) + Math.max(0, Number(item.quantity) || 0));
    for (const item of items) nextQuantities.set(itemIdentity(item), (nextQuantities.get(itemIdentity(item)) || 0) + item.quantity);
    const reasons = Array.isArray(body.itemCancellationReasons) ? body.itemCancellationReasons : [];
    const allowedCancellationReasons = [...new Set((Array.isArray(settings.cancellationReasons)
      ? settings.cancellationReasons : ["Customer request", "Duplicate order", "Item unavailable", "Other"])
      .map((value) => String(value || "").trim().slice(0, 120)).filter(Boolean))].slice(0, 30);
    const reasonRows = [];
    for (const entry of reasons) {
      const oldItem = oldItemsById.get(Number(entry?.orderItemId ?? entry?.order_item_id));
      const reason = String(entry?.reason || "").trim().slice(0, 120);
      const quantity = Number(entry?.quantity ?? 1);
      if (!oldItem || !reason || !allowedCancellationReasons.includes(reason) || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
        throw failure(400, "Choose a valid cancellation reason for each removed item.");
      }
      reasonRows.push({ identity: itemIdentity(oldItem), itemName: String(oldItem.item_name || "Item"), reason, quantity });
    }
    const cancellationEvents = [];
    for (const [identity, oldQuantity] of oldQuantities) {
      const removed = Math.max(0, oldQuantity - (nextQuantities.get(identity) || 0));
      if (!removed) continue;
      const matching = reasonRows.filter((entry) => entry.identity === identity);
      if (matching.reduce((sum, entry) => sum + entry.quantity, 0) < removed) throw failure(400, "Choose a cancellation reason before removing or reducing a saved order item.");
      let remaining = removed;
      const eventReasons = [];
      for (const entry of matching) {
        if (remaining <= 0) break;
        const quantity = Math.min(entry.quantity, remaining);
        eventReasons.push({ ...entry, quantity });
        remaining -= quantity;
      }
      cancellationEvents.push({ identity, itemName: matching[0]?.itemName || "Item", quantity: removed, reasons: eventReasons });
    }

    const oldTicketsResult = await env.DB.prepare(
      "SELECT id, order_item_id, quantity, cancelled_quantity FROM kot WHERE business_id = ? AND order_id = ? AND order_item_id IS NOT NULL ORDER BY id"
    ).bind(businessId, orderId).all();
    const ticketsByIdentity = new Map();
    for (const ticket of oldTicketsResult.results || []) {
      const oldItem = oldItemsById.get(Number(ticket.order_item_id));
      if (!oldItem) continue;
      const identity = itemIdentity(oldItem);
      if (!ticketsByIdentity.has(identity)) ticketsByIdentity.set(identity, []);
      ticketsByIdentity.get(identity).push(ticket);
    }

    const notes = body.notes ? String(body.notes).slice(0, 1000) : null;
    const pax = orderType === "Dine-in" ? Math.max(1, Math.min(100, Math.floor(Number(body.pax) || Number(order.pax) || 1))) : null;
    const updatedAt = new Date().toISOString().replace("T", " ").replace("Z", "")
      + String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
    const statements = [env.DB.prepare(
      "UPDATE orders SET subtotal = ?, gst = ?, total = ?, discount = ?, service_charge = ?, marketing_deal_id = ?, marketing_deal_name = ?, " +
      "discount_adjustment_id = ?, discount_adjustment_name = ?, charge_adjustment_id = ?, charge_adjustment_name = ?, " +
      "customer_id = ?, notes = ?, pax = ?, sales_channel_key = ?, sales_channel_name = ?, updated_at = ? " +
      "WHERE id = ? AND business_id = ? AND status = " + expectedStatusSql + " AND total = ? AND COALESCE(updated_at, '') = COALESCE(?, '')"
    ).bind(subtotal, gst, total, totalDiscount, serviceCharge, billingRules.marketingDealId, billingRules.marketingDealName,
      billingRules.discountAdjustmentId, billingRules.discountAdjustmentName, billingRules.chargeAdjustmentId, billingRules.chargeAdjustmentName,
      customerId, notes, pax, channel.key, channel.label, updatedAt,
      orderId, businessId, Number(order.total || 0), order.updated_at ?? "")];
    statements.push(env.DB.prepare(
      "UPDATE kot SET order_item_id = NULL WHERE business_id = ? AND order_id = ? AND order_item_id IS NOT NULL " +
      "AND EXISTS (SELECT 1 FROM orders o WHERE o.id = ? AND o.business_id = ? AND o.updated_at = ?)"
    ).bind(businessId, orderId, orderId, businessId, updatedAt));
    statements.push(env.DB.prepare(
      "DELETE FROM order_items WHERE business_id = ? AND order_id = ? " +
      "AND EXISTS (SELECT 1 FROM orders o WHERE o.id = ? AND o.business_id = ? AND o.updated_at = ?)"
    ).bind(businessId, orderId, orderId, businessId, updatedAt));
    for (const item of items) {
      statements.push(env.DB.prepare(
        "INSERT INTO order_items (order_id, menu_id, variant_id, item_name, price, quantity, line_total, unit, tax_rate, tax_mode, business_id, options, item_discount_rule_id, item_discount_amount, item_discount_name) " +
        "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM orders WHERE id = ? AND business_id = ? AND status = " + expectedStatusSql + " AND updated_at = ?)"
      ).bind(orderId, item.menuId, item.variantId, item.name, item.price, item.quantity, money(item.price * item.quantity), item.unit,
        item.taxRate, item.taxMode, businessId, JSON.stringify(item.options), item.itemDiscountRuleId,
        Number(item.itemDiscountAmount || 0), item.itemDiscountName, orderId, businessId, updatedAt));
    }

    const matchedTicketIds = new Set();
    for (const item of items) {
      const identity = itemIdentity(item);
      const candidates = ticketsByIdentity.get(identity);
      const ticket = candidates?.shift();
      if (!ticket || Number(ticket.quantity || 0) <= 0) {
        if (ticket) candidates.unshift(ticket);
        continue;
      }
      const nextQuantity = item.quantity;
      const cancelledQuantity = Math.max(0, Number(ticket.cancelled_quantity || 0)) + Math.max(0, Number(ticket.quantity || 0) - nextQuantity);
      statements.push(env.DB.prepare(
        "UPDATE kot SET order_item_id = (SELECT oi.id FROM order_items oi WHERE oi.business_id = ? AND oi.order_id = ? AND oi.menu_id = ? " +
        "AND COALESCE(oi.variant_id, 0) = COALESCE(?, 0) AND oi.item_name = ? AND oi.options = ? " +
        "AND NOT EXISTS (SELECT 1 FROM kot used WHERE used.business_id = oi.business_id AND used.order_item_id = oi.id) ORDER BY oi.id LIMIT 1), " +
        "quantity = ?, cancelled_quantity = ?, item_name = ?, options = ?, status = CASE WHEN ? = 0 THEN 'Completed' ELSE status END " +
        "WHERE id = ? AND business_id = ? AND EXISTS (SELECT 1 FROM orders o WHERE o.id = ? AND o.business_id = ? AND o.updated_at = ?)"
      ).bind(businessId, orderId, item.menuId, item.variantId, item.name, JSON.stringify(item.options), nextQuantity, cancelledQuantity,
        item.name, JSON.stringify(item.options), nextQuantity, Number(ticket.id), businessId, orderId, businessId, updatedAt));
      matchedTicketIds.add(Number(ticket.id));
    }
    const cancellationEventLines = [];
    for (const tickets of ticketsByIdentity.values()) {
      for (const ticket of tickets) {
        if (matchedTicketIds.has(Number(ticket.id))) continue;
        const quantity = Math.max(0, Number(ticket.quantity) || 0);
        if (!quantity) continue;
        statements.push(env.DB.prepare(
          "UPDATE kot SET order_item_id = NULL, quantity = 0, cancelled_quantity = COALESCE(cancelled_quantity, 0) + ?, status = 'Completed' " +
          "WHERE id = ? AND business_id = ? AND EXISTS (SELECT 1 FROM orders o WHERE o.id = ? AND o.business_id = ? AND o.updated_at = ?)"
        ).bind(quantity, Number(ticket.id), businessId, orderId, businessId, updatedAt));
      }
    }
    for (const event of cancellationEvents) {
      const labels = [...new Set(event.reasons.map((entry) => entry.reason))].join(", ");
      cancellationEventLines.push({ itemName: event.itemName, quantity: event.quantity, labels });
      statements.push(env.DB.prepare(
        "INSERT INTO order_activity (order_id, event_type, description, actor, business_id, actor_user_id) " +
        "SELECT ?, 'Item cancelled', ?, COALESCE(u.display_name, u.username, 'Staff'), ?, ? FROM app_users u WHERE u.id = ? AND u.business_id = ? " +
        "AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND business_id = ? AND status = " + expectedStatusSql + " AND updated_at = ?) " +
        "UNION ALL SELECT ?, 'Item cancelled', ?, 'Staff', ?, ? WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE id = ? AND business_id = ?) " +
        "AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND business_id = ? AND status = " + expectedStatusSql + " AND updated_at = ?)"
      ).bind(orderId, `${event.quantity} × ${event.itemName} removed. Reason: ${labels}.`, businessId, Number(bridgeClaims.sub), Number(bridgeClaims.sub), businessId,
        orderId, businessId, updatedAt,
        orderId, `${event.quantity} × ${event.itemName} removed. Reason: ${labels}.`, businessId, Number(bridgeClaims.sub), Number(bridgeClaims.sub), businessId,
        orderId, businessId, updatedAt));
    }

    const invoice = await env.DB.prepare("SELECT id FROM invoices WHERE business_id = ? AND order_id = ? LIMIT 1").bind(businessId, orderId).first();
    if (invoice) statements.push(env.DB.prepare(
      "UPDATE invoices SET subtotal = ?, gst = ?, total = ?, status = CASE " +
      "WHEN LOWER(COALESCE(payment_method, '')) LIKE '%non-chargeable%' THEN 'Non-chargeable' " +
      "WHEN COALESCE((SELECT SUM(amount) FROM payments WHERE business_id = ? AND order_id = ? AND payment_status = 'Success'), 0) + 0.009 >= ? THEN 'Paid' ELSE 'Partially Paid' END " +
      "WHERE id = ? AND business_id = ? AND EXISTS (SELECT 1 FROM orders o WHERE o.id = ? AND o.business_id = ? AND o.updated_at = ?)"
    ).bind(subtotal, gst, total, businessId, orderId, total, Number(invoice.id), businessId, orderId, businessId, updatedAt));
    if (body.createKot === true && settings.kotEnabled !== false) {
      const kot = await buildKotStatements(env, businessId, { orderId }, { updatedAt });
      statements.push(...kot.statements);
    }
    statements.push(env.DB.prepare(
      "INSERT INTO order_activity (order_id, event_type, description, actor, business_id, actor_user_id) " +
      "SELECT ?, " + activityEventSql + ", ?, COALESCE(u.display_name, u.username, 'Staff'), ?, ? FROM app_users u WHERE u.id = ? AND u.business_id = ? AND EXISTS " +
      "(SELECT 1 FROM orders WHERE id = ? AND business_id = ? AND status = " + expectedStatusSql + " AND updated_at = ?) " +
      "UNION ALL SELECT ?, " + activityEventSql + ", ?, 'Staff', ?, ? WHERE NOT EXISTS (SELECT 1 FROM app_users WHERE id = ? AND business_id = ?) " +
      "AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND business_id = ? AND status = " + expectedStatusSql + " AND updated_at = ?)"
    ).bind(orderId, `Order details saved. New total: ${total.toFixed(2)}.`, businessId, Number(bridgeClaims.sub), Number(bridgeClaims.sub), businessId, orderId, businessId, updatedAt,
      orderId, `Order details saved. New total: ${total.toFixed(2)}.`, businessId, Number(bridgeClaims.sub), Number(bridgeClaims.sub), businessId, orderId, businessId, updatedAt));

    const results = await env.DB.batch(statements);
    if (Number(results?.[0]?.meta?.changes || 0) !== 1) throw failure(409, "This order changed before it could be saved.");
    const savedOrder = await env.DB.prepare("SELECT * FROM orders WHERE id = ? AND business_id = ? LIMIT 1").bind(orderId, businessId).first();
    const savedItems = await env.DB.prepare("SELECT * FROM order_items WHERE business_id = ? AND order_id = ? ORDER BY id").bind(businessId, orderId).all();
    return { status: 200, success: true, order: savedOrder,
      items: (savedItems.results || []).map((item) => ({ ...item, options: parseJson(item.options, []) })),
      itemCancellationEvents: cancellationEventLines };
  } catch (error) {
    return { status: Number(error?.status) || 500, error: error?.status ? error.message : "D1 order update failed." };
  }
}

export async function cancelOrder(request, env, businessId, bridgeClaims, orderId) {
  if (!bridgeClaims || bridgeClaims.scope !== "orders.cancel" || Number(bridgeClaims.business_id) !== businessId) {
    return { status: 403, error: "A signed order-cancellation permission is required." };
  }
  try {
    const raw = await request.text();
    if (raw.length > 16384) throw failure(413, "Cancellation request is too large.");
    const body = JSON.parse(raw || "{}");
    const reason = String(body.reason || "").trim().slice(0, 300);
    if (!reason) throw failure(400, "Choose a cancellation reason from Settings.");
    const order = await env.DB.prepare(
      "SELECT id, status, order_type, table_number FROM orders WHERE id = ? AND business_id = ? LIMIT 1"
    ).bind(orderId, businessId).first();
    if (!order) throw failure(404, "Order not found.");
    if (String(order.status || "").toLowerCase() === "cancelled") throw failure(409, "This order has already been cancelled.");
    const settingsRow = await env.DB.prepare("SELECT settings FROM app_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
    const settings = parseJson(settingsRow?.settings, {});
    const reasons = Array.isArray(settings.cancellationReasons)
      ? settings.cancellationReasons.map((value) => String(value || "").trim().slice(0, 120)).filter(Boolean).slice(0, 30)
      : ["Customer request", "Duplicate order", "Item unavailable", "Other"];
    if (!reasons.includes(reason)) throw failure(400, "Choose a cancellation reason from Settings.");
    const wasClosed = String(order.status || "").toLowerCase() === "completed";
    const activityEvent = wasClosed ? "Order voided" : "Order cancelled";
    const statements = [
      env.DB.prepare(
        "UPDATE orders SET status = 'Cancelled', cancellation_reason = ?, cancelled_by_user_id = ?, " +
        "cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP " +
        "WHERE id = ? AND business_id = ? AND LOWER(COALESCE(status, '')) <> 'cancelled'"
      ).bind(reason, Number(bridgeClaims.sub), orderId, businessId),
      env.DB.prepare(
        "UPDATE kot SET status = 'Cancelled', cancelled_quantity = cancelled_quantity + quantity, quantity = 0 " +
        "WHERE order_id = ? AND business_id = ? AND quantity > 0 AND changes() = 1"
      ).bind(orderId, businessId),
      env.DB.prepare(
        "UPDATE restaurant_tables SET status = 'Available' WHERE business_id = ? AND table_number = ? " +
        "AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND business_id = ? AND status = 'Cancelled' AND cancelled_at IS NOT NULL)"
      ).bind(businessId, String(order.table_number || ""), orderId, businessId),
      env.DB.prepare(
        "INSERT INTO order_activity (order_id, event_type, description, actor, business_id, actor_user_id) " +
        "SELECT ?, ?, ?, COALESCE(u.display_name, u.username, 'Staff'), ?, ? " +
        "FROM app_users u WHERE u.id = ? AND u.business_id = ? AND EXISTS " +
        "(SELECT 1 FROM orders WHERE id = ? AND business_id = ? AND status = 'Cancelled' AND cancelled_at IS NOT NULL) " +
        "UNION ALL SELECT ?, ?, ?, 'Staff', ?, ? WHERE NOT EXISTS " +
        "(SELECT 1 FROM app_users WHERE id = ? AND business_id = ?) AND EXISTS " +
        "(SELECT 1 FROM orders WHERE id = ? AND business_id = ? AND status = 'Cancelled' AND cancelled_at IS NOT NULL)"
      ).bind(
        orderId, activityEvent, "Reason: " + reason + (wasClosed ? ". Closed bill voided." : "."), businessId, Number(bridgeClaims.sub), Number(bridgeClaims.sub), businessId, orderId, businessId,
        orderId, activityEvent, "Reason: " + reason + (wasClosed ? ". Closed bill voided." : "."), businessId, Number(bridgeClaims.sub), Number(bridgeClaims.sub), businessId, orderId, businessId
      ),
    ];
    if (order.order_type !== "Dine-in" || !order.table_number) statements.splice(2, 1);
    const results = await env.DB.batch(statements);
    if (Number(results?.[0]?.meta?.changes || 0) !== 1) throw failure(409, "This order changed before it could be cancelled.");
    const savedOrder = await env.DB.prepare("SELECT * FROM orders WHERE id = ? AND business_id = ? LIMIT 1").bind(orderId, businessId).first();
    return { status: 200, success: true, order: savedOrder };
  } catch (error) {
    return { status: Number(error?.status) || 500, error: error?.status ? error.message : "D1 order cancellation failed." };
  }
}

export async function markOrderPrinted(env, businessId, bridgeClaims, orderId) {
  if (!bridgeClaims || bridgeClaims.scope !== "orders.print_open" || Number(bridgeClaims.business_id) !== businessId) {
    return { status: 403, error: "A signed bill-print permission is required." };
  }
  const order = await env.DB.prepare(
    "UPDATE orders SET bill_printed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP " +
    "WHERE id = ? AND business_id = ? RETURNING *"
  ).bind(orderId, businessId).first();
  return order ? { status: 200, success: true, order } : { status: 404, error: "Order not found." };
}
