function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" } });
}

function kotRange(url) {
  const range = String(url.searchParams.get("range") || "today");
  if (range === "all") return { start: "1970-01-01T00:00:00.000Z", end: "9999-12-31T23:59:59.999Z" };
  const parseDate = (value) => {
    const text = String(value || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const date = new Date(`${text}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? null : date;
  };
  let first;
  let after;
  if (range === "custom") {
    first = parseDate(url.searchParams.get("from"));
    const last = parseDate(url.searchParams.get("to"));
    if (!first || !last) return { error: "Invalid custom date range" };
    if (first > last) return { error: "From date cannot be after To date" };
    after = new Date(last.getTime() + 86400000);
  } else {
    const shifted = new Date(Date.now() + 19800000);
    const today = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
    if (range === "yesterday") { first = new Date(today.getTime() - 86400000); after = today; }
    else if (range === "week") {
      const day = today.getUTCDay() || 7;
      first = new Date(today.getTime() - (day - 1) * 86400000);
      after = new Date(first.getTime() + 7 * 86400000);
    } else if (range === "month") {
      first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      after = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    } else { first = today; after = new Date(today.getTime() + 86400000); }
  }
  const utc = (date) => new Date(date.getTime() - 19800000).toISOString();
  return { start: utc(first), end: utc(after) };
}

const ITEM_FIELDS = "k.id,k.business_id,k.order_id,k.item_name,k.quantity,k.status,k.created_at,k.kot_group_id,k.options,k.cancelled_quantity,k.ticket_number";
const ORDER_FIELDS = "o.order_number,o.order_type,o.table_number,o.pax,o.notes AS order_notes,o.status AS order_status";

export async function handleKotTickets(env, businessId, url) {
  const orderId = url.searchParams.has("orderId") ? Number(url.searchParams.get("orderId")) : null;
  if (orderId !== null && (!Number.isSafeInteger(orderId) || orderId <= 0)) return json({ error: "Invalid order ID" }, 400);
  const rangeUrl = new URL(url);
  if (orderId !== null) rangeUrl.searchParams.set("range", "all");
  const bounds = kotRange(rangeUrl);
  if (bounds.error) return json({ error: bounds.error }, 400);
  if (orderId !== null) {
    const result = await env.DB.prepare(
      `SELECT ${ITEM_FIELDS},kg.name AS kot_group_name,kg.station AS kot_group_station,kg.printer_id,
        p.name AS printer_name,p.connection_type AS printer_connection_type,p.host AS printer_host,p.port AS printer_port,
        p.bluetooth_name AS printer_bluetooth_name,p.service_uuid AS printer_service_uuid,
        p.characteristic_uuid AS printer_characteristic_uuid,p.paper_width AS printer_paper_width,${ORDER_FIELDS}
       FROM kot k JOIN orders o ON k.order_id=o.id AND k.business_id=o.business_id
       LEFT JOIN kot_groups kg ON kg.id=k.kot_group_id AND kg.business_id=o.business_id
       LEFT JOIN printers p ON p.id=kg.printer_id AND p.business_id=o.business_id
       WHERE o.business_id=? AND o.id=? AND datetime(k.created_at)>=datetime(?) AND datetime(k.created_at)<datetime(?)
       ORDER BY k.created_at DESC,k.id DESC`
    ).bind(businessId, orderId, bounds.start, bounds.end).all();
    return json(result.results || []);
  }

  const pagingRequested = url.searchParams.has("limit") || url.searchParams.has("beforeCreatedAt") || url.searchParams.has("beforeId");
  if (!pagingRequested) {
    const result = await env.DB.prepare(
      `SELECT ${ITEM_FIELDS},kg.name AS kot_group_name,kg.station AS kot_group_station,${ORDER_FIELDS}
       FROM kot k JOIN orders o ON k.order_id=o.id AND k.business_id=o.business_id
       LEFT JOIN kot_groups kg ON kg.id=k.kot_group_id AND kg.business_id=o.business_id
       WHERE o.business_id=? AND datetime(k.created_at)>=datetime(?) AND datetime(k.created_at)<datetime(?)
       ORDER BY k.created_at DESC,k.id DESC`
    ).bind(businessId, bounds.start, bounds.end).all();
    return json(result.results || []);
  }
  const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return json({ error: "KOT page size must be between 1 and 100." }, 400);
  const hasCursor = url.searchParams.has("beforeCreatedAt") || url.searchParams.has("beforeId");
  const beforeCreatedAt = hasCursor ? String(url.searchParams.get("beforeCreatedAt") || "") : null;
  const beforeCreatedAtMs = hasCursor ? Date.parse(beforeCreatedAt) : NaN;
  const beforeId = hasCursor ? Number(url.searchParams.get("beforeId")) : null;
  if (hasCursor && (!Number.isFinite(beforeCreatedAtMs) || !Number.isSafeInteger(beforeId) || beforeId <= 0)) return json({ error: "Invalid KOT history cursor." }, 400);
  const cursorDate = hasCursor ? new Date(beforeCreatedAtMs).toISOString() : null;
  const result = await env.DB.prepare(`
    WITH ticket_keys AS (
      SELECT order_id,ticket_number,MAX(created_at) AS page_created_at,MAX(id) AS page_id
      FROM kot WHERE business_id=? AND datetime(created_at)>=datetime(?) AND datetime(created_at)<datetime(?)
      GROUP BY order_id,ticket_number
    ), ticket_batch AS (
      SELECT order_id,ticket_number,page_created_at,page_id FROM ticket_keys
      WHERE ? IS NULL OR datetime(page_created_at)<datetime(?) OR (datetime(page_created_at)=datetime(?) AND page_id<?)
      ORDER BY page_created_at DESC,page_id DESC LIMIT ?
    ), ticket_page AS (
      SELECT order_id,ticket_number,page_created_at,page_id FROM ticket_batch
      ORDER BY page_created_at DESC,page_id DESC LIMIT ?
    ), page_items AS (
      SELECT ${ITEM_FIELDS},kg.name AS kot_group_name,kg.station AS kot_group_station,${ORDER_FIELDS}
      FROM ticket_page page JOIN kot k ON k.business_id=? AND k.order_id=page.order_id AND k.ticket_number=page.ticket_number
       AND datetime(k.created_at)>=datetime(?) AND datetime(k.created_at)<datetime(?)
      JOIN orders o ON o.id=k.order_id AND o.business_id=?
      LEFT JOIN kot_groups kg ON kg.id=k.kot_group_id AND kg.business_id=?
    )
    SELECT COALESCE((SELECT json_group_array(json(item_json)) FROM (
      SELECT json_object('id',id,'business_id',business_id,'order_id',order_id,'item_name',item_name,'quantity',quantity,'status',status,
        'created_at',created_at,'kot_group_id',kot_group_id,'options',json(COALESCE(options,'[]')),'cancelled_quantity',cancelled_quantity,
        'ticket_number',ticket_number,'kot_group_name',kot_group_name,'kot_group_station',kot_group_station,'order_number',order_number,
        'order_type',order_type,'table_number',table_number,'pax',pax,'order_notes',order_notes,'order_status',order_status) AS item_json
      FROM page_items ORDER BY created_at DESC,id DESC
    )), '[]') AS items,
    (SELECT COUNT(*)>? FROM ticket_batch) AS has_more,
    (SELECT json_object('createdAt',page_created_at,'id',page_id) FROM ticket_page ORDER BY page_created_at ASC,page_id ASC LIMIT 1) AS next_cursor
  `).bind(businessId, bounds.start, bounds.end, cursorDate, cursorDate, cursorDate, beforeId, limit + 1, limit,
    businessId, bounds.start, bounds.end, businessId, businessId, limit).first();
  let items = [];
  try { items = JSON.parse(result?.items || "[]"); } catch { items = []; }
  let nextCursor = null;
  try { nextCursor = result?.next_cursor ? JSON.parse(result.next_cursor) : null; } catch { nextCursor = null; }
  return json({ items, hasMore: Boolean(result?.has_more), nextCursor, limit });
}

export async function updateKotItem(env, businessId, kotId, status, actorUserId) {
  const allowed = ["Pending", "Preparing", "Ready", "Completed"];
  if (!allowed.includes(String(status || ""))) return { status: 400, error: "Invalid KOT status" };
  const kot = await env.DB.prepare("SELECT id,order_id FROM kot WHERE id=? AND business_id=? LIMIT 1").bind(kotId,businessId).first();
  if (!kot) return { status: 404, error: "KOT not found" };
  const order = await env.DB.prepare("SELECT id,order_number,public_tracking_token,status FROM orders WHERE id=? AND business_id=? LIMIT 1").bind(Number(kot.order_id),businessId).first();
  const statements = [env.DB.prepare(
    "UPDATE kot SET status=?, prep_started_at=CASE WHEN ?='Preparing' THEN COALESCE(prep_started_at,CURRENT_TIMESTAMP) ELSE prep_started_at END, " +
    "prep_completed_at=CASE WHEN ? IN ('Ready','Completed') THEN COALESCE(prep_completed_at,CURRENT_TIMESTAMP) ELSE prep_completed_at END " +
    "WHERE id=? AND business_id=?"
  ).bind(status,status,status,kotId,businessId)];
  const isQrOrder = order && (order.public_tracking_token || /^QR-/i.test(String(order.order_number || "")));
  if (isQrOrder && !["completed","cancelled"].includes(String(order.status || "").toLowerCase())) {
    statements.push(env.DB.prepare(
      "UPDATE orders SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM kot WHERE order_id=? AND business_id=? AND status NOT IN ('Ready','Completed')) THEN 'Ready' " +
      "WHEN EXISTS(SELECT 1 FROM kot WHERE order_id=? AND business_id=? AND status IN ('Preparing','Ready','Completed')) THEN 'Preparing' ELSE 'Pending' END, updated_at=CURRENT_TIMESTAMP " +
      "WHERE id=? AND business_id=? AND status NOT IN ('Completed','Cancelled')"
    ).bind(Number(order.id),businessId,Number(order.id),businessId,Number(order.id),businessId));
  }
  statements.push(env.DB.prepare("INSERT INTO order_activity (order_id,event_type,description,actor,business_id,actor_user_id) SELECT ?, 'Kitchen status changed', ?, COALESCE(u.display_name,u.username,'Staff'), ?, ? FROM app_users u WHERE u.id=? AND u.business_id=? UNION ALL SELECT ?, 'Kitchen status changed', ?, 'Staff', ?, ? WHERE NOT EXISTS(SELECT 1 FROM app_users WHERE id=? AND business_id=?)")
    .bind(Number(kot.order_id),`Kitchen ticket marked ${status}.`,businessId,actorUserId,actorUserId,businessId,Number(kot.order_id),`Kitchen ticket marked ${status}.`,businessId,actorUserId,actorUserId,businessId));
  try { await env.DB.batch(statements); }
  catch { return { status: 409, error: "Could not update the kitchen ticket" }; }
  const saved = await env.DB.prepare("SELECT * FROM kot WHERE id=? AND business_id=? LIMIT 1").bind(kotId,businessId).first();
  return { status: 200, success: true, kot: saved };
}
