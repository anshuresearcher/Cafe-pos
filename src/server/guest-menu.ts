import { withSystem, withTenant } from "@/src/server/db";

const defaultChannels = [
  { key: "dine_in", label: "Dine in", orderType: "Dine-in", qrMenu: false },
  { key: "takeaway", label: "Takeaway", orderType: "Takeaway", qrMenu: false },
  { key: "delivery", label: "Delivery", orderType: "Takeaway", qrMenu: false },
  { key: "online", label: "Slash", orderType: "Takeaway", qrMenu: true },
];

function channels(settings: any) {
  const custom = Array.isArray(settings?.posSalesChannels) ? settings.posSalesChannels : [];
  const byKey = new Map(custom.map((entry: any) => [String(entry?.key || "").trim().toLowerCase(), entry]));
  return [...defaultChannels.map((entry) => ({ ...entry, ...(byKey.get(entry.key) || {}) })), ...custom.filter((entry: any) => !defaultChannels.some((item) => item.key === String(entry?.key || "").trim().toLowerCase()))]
    .map((entry: any) => ({
      key: String(entry.key || "").trim().toLowerCase(),
      label: String(entry.label || "").trim().slice(0, 60),
      orderType: entry.orderType === "Dine-in" ? "Dine-in" : "Takeaway",
      qrMenu: entry.qrMenu === true,
    }))
    .filter((entry) => /^[a-z][a-z0-9_]{1,19}$/.test(entry.key) && entry.label)
    .filter((entry, index, list) => list.findIndex((item) => item.key === entry.key) === index)
    .slice(0, 44);
}

function selectedChannels(value: any, settings: any) {
  const fallback = channels(settings).map((entry) => entry.key);
  if (value === undefined || value === null) return fallback;
  const source = Array.isArray(value) ? value : typeof value === "string" ? (() => { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [parsed]; } catch { return [value]; } })() : [];
  return [...new Set(source.map((item) => String(item || "").trim().toLowerCase().replace(/[\s-]+/g, "_")).filter(Boolean))];
}

function cleanTags(value: any) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[;,]/);
  const seen = new Set<string>();
  return source.map((entry) => String(entry || "").trim().replace(/\s+/g, " ").slice(0, 40)).filter((tag) => {
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function promotions(settings: any, channelKey: string) {
  return (Array.isArray(settings?.marketingDeals) ? settings.marketingDeals : []).filter((deal: any) => {
    const dealChannels = Array.isArray(deal.channels) ? deal.channels.map((value: any) => String(value).toLowerCase().replace(/[\s-]+/g, "_")) : [];
    return String(deal?.id || "").trim() && deal?.active !== false && (!dealChannels.length || dealChannels.includes(channelKey));
  }).map((deal: any) => ({
    id: `marketing:${String(deal.id)}`, source: "marketing", sourceId: String(deal.id),
    name: String(deal.name || "QR Menu offer").slice(0, 120), description: String(deal.description || "").slice(0, 240),
    type: String(deal.type || "Deal").slice(0, 80), valueType: String(deal.valueType || "amount"),
    value: Number.isFinite(Number(deal.value)) ? Number(deal.value) : 0,
    bundlePrice: Number.isFinite(Number(deal.bundlePrice)) && Number(deal.bundlePrice) > 0 ? Number(deal.bundlePrice) : null,
    buyQuantity: Math.max(1, Number(deal.buyQuantity) || 1), getQuantity: Math.max(1, Number(deal.getQuantity) || 1),
    rewardItemName: String(deal.rewardItemName || "").slice(0, 120), category: String(deal.category || ""),
    categories: Array.isArray(deal.categories) ? deal.categories.map((value: any) => String(value || "").slice(0, 120)) : [],
    itemId: deal.itemId || null, itemIds: Array.isArray(deal.itemIds) ? deal.itemIds.map(String) : [],
    startDate: deal.startDate || null, endDate: deal.endDate || null, days: Array.isArray(deal.days) ? deal.days.map((day: any) => String(day).toLowerCase()) : [],
    startTime: deal.startTime || null, endTime: deal.endTime || null,
  }));
}

function availability(publication: any, name: string) {
  const outletOpen = publication.outlet_open !== false;
  const hoursEnabled = publication.hours_enabled === true;
  const openTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(publication.open_time || "")) ? publication.open_time : "09:00";
  const closeTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(publication.close_time || "")) ? publication.close_time : "22:00";
  let withinHours = true;
  if (hoursEnabled) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    const current = Number(parts.find((part) => part.type === "hour")?.value || 0) * 60 + Number(parts.find((part) => part.type === "minute")?.value || 0);
    const [openHour, openMinute] = openTime.split(":").map(Number);
    const [closeHour, closeMinute] = closeTime.split(":").map(Number);
    const start = openHour * 60 + openMinute, end = closeHour * 60 + closeMinute;
    withinHours = start === end || (start < end ? current >= start && current < end : current >= start || current < end);
  }
  const orderingOpen = outletOpen && withinHours;
  const format = (time: string) => { const [hour, minute] = time.split(":").map(Number); return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`; };
  const hours = hoursEnabled ? ` We’re back ${format(openTime)}–${format(closeTime)} IST.` : "";
  return { orderingOpen, outletOpen, hoursEnabled, openTime, closeTime, closedMessage: orderingOpen ? "" : `${name || "The cafe"} is closed rn 😴 — the kitchen’s on a lil break.${hours} Catch us during open hours for the good stuff.` };
}

export async function publicMenu(token: string) {
  const access = await withSystem((client) => client.query(`
    SELECT s.business_id,s.enabled,s.price_channel,s.category_order,s.outlet_open,s.hours_enabled,s.open_time,s.close_time,b.business_name,
           EXISTS (SELECT 1 FROM business_licenses l WHERE l.business_id=s.business_id AND l.status='active' AND l.starts_at<=CURRENT_TIMESTAMP AND l.expires_at>=CURRENT_TIMESTAMP AND LOWER(COALESCE(l.add_on,'')) LIKE '%table qr%') AS has_qr_addon
    FROM public_menu_settings s JOIN businesses b ON b.id=s.business_id WHERE s.token=$1 LIMIT 1
  `, [token]));
  const publication = access.rows[0];
  if (!publication?.enabled || !publication.has_qr_addon) return null;
  const businessId = Number(publication.business_id);
  return withTenant(businessId, async (client) => {
    const [businessResult, settingsResult, categoryResult, menuResult, variantResult, tableResult] = await Promise.all([
      client.query("SELECT business_name,logo_url,currency FROM businesses WHERE id=$1 LIMIT 1", [businessId]),
      client.query("SELECT settings FROM app_settings WHERE business_id=$1 LIMIT 1", [businessId]),
      client.query("SELECT id,name,image_url FROM menu_categories WHERE business_id=$1 AND active=TRUE ORDER BY sort_order,name,id", [businessId]),
      client.query("SELECT id,name,description,tags,category,price,channel_prices,sales_channels,image_url,qr_available,tax_rate,tax_mode,option_set_ids FROM menu WHERE business_id=$1 AND available=TRUE ORDER BY category,name,id", [businessId]),
      client.query("SELECT id,menu_id,name,price,unit,channel_prices,option_set_ids FROM menu_variants WHERE business_id=$1 AND available=TRUE ORDER BY menu_id,id", [businessId]),
      client.query("SELECT table_number FROM restaurant_tables WHERE business_id=$1 ORDER BY table_number", [businessId]),
    ]);
    const business = businessResult.rows[0] || {};
    const settings = settingsResult.rows[0]?.settings || {};
    const allChannels = channels(settings);
    const priceChannel = allChannels.find((channel) => channel.key === publication.price_channel && channel.qrMenu)?.key || allChannels.find((channel) => channel.key === "online")?.key || allChannels.find((channel) => channel.qrMenu)?.key || "online";
    const categoryMap = new Map(categoryResult.rows.map((row) => [String(row.name || "").toLowerCase(), row]));
    const orderedCategories = (Array.isArray(publication.category_order) ? publication.category_order : []).map((name: any) => categoryMap.get(String(name || "").trim().toLowerCase())?.name).filter(Boolean) as string[];
    for (const row of categoryResult.rows) if (!orderedCategories.some((name) => name.toLowerCase() === String(row.name).toLowerCase())) orderedCategories.push(row.name);
    const optionSets = new Map((Array.isArray(settings.menuOptionSets) ? settings.menuOptionSets : []).map((set: any) => [String(set.id), set]));
    const publicOptions = (ids: any) => (Array.isArray(ids) ? ids : []).map((id) => optionSets.get(String(id))).filter(Boolean).map((set: any) => ({ id: String(set.id), name: String(set.name || "Options"), minSelections: Math.max(0, Number(set.minSelections) || 0), maxSelections: Math.max(1, Number(set.maxSelections) || 1), options: (Array.isArray(set.options) ? set.options : []).map((option: any) => ({ id: String(option.id), name: String(option.name || "Choice"), price: Math.max(0, Number(option.price) || 0) })) }));
    const itemsById = new Map<number, any>();
    const items = menuResult.rows.map((item) => {
      if (!selectedChannels(item.sales_channels, settings).includes(priceChannel)) return null;
      const prices = item.channel_prices && typeof item.channel_prices === "object" ? item.channel_prices : {};
      const entry = { id: String(item.id), name: item.name, description: String(item.description || ""), tags: cleanTags(item.tags), category: item.category || "Menu", price: Number(prices[priceChannel] ?? item.price ?? 0), imageUrl: item.image_url || "", inStock: item.qr_available !== false, taxRate: Number(item.tax_rate || 0), taxMode: item.tax_mode === "inclusive" ? "inclusive" : "exclusive", optionSets: publicOptions(item.option_set_ids), variants: [] as any[] };
      itemsById.set(Number(item.id), entry);
      return entry;
    }).filter(Boolean);
    for (const variant of variantResult.rows) {
      const item = itemsById.get(Number(variant.menu_id));
      if (!item) continue;
      const prices = variant.channel_prices && typeof variant.channel_prices === "object" ? variant.channel_prices : {};
      item.variants.push({ id: String(variant.id), name: variant.name, unit: variant.unit || "", price: Number(prices[priceChannel] ?? variant.price ?? item.price), optionSets: publicOptions(variant.option_set_ids) });
    }
    const restaurantName = String(settings.restaurantName || business.business_name || "Cafe & Restaurant");
    return { restaurantName, logoUrl: String(business.logo_url || settings.logoUrl || ""), heroImages: Array.isArray(settings.publicMenuHeroImages) ? settings.publicMenuHeroImages.slice(0, 6) : [], currency: String(settings.currency || business.currency || "₹"), priceChannel, priceChannelLabel: allChannels.find((channel) => channel.key === priceChannel)?.label || "Slash", gstCalculationEnabled: settings.gstCalculationEnabled !== false, onlinePromotions: promotions(settings, priceChannel), categories: orderedCategories.map((name) => ({ name, imageUrl: String(categoryMap.get(name.toLowerCase())?.image_url || "") })), items, ...availability(publication, restaurantName), tables: tableResult.rows.map((row) => String(row.table_number)) };
  });
}
