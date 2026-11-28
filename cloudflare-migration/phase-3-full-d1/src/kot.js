function moneyInt(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

export async function buildKotStatements(env, businessId, target, { queueDevicePrint = true, updatedAt = null } = {}) {
  const orderId = moneyInt(target?.orderId);
  const orderNumber = String(target?.orderNumber || "").trim().slice(0, 80);
  if (!orderId && !orderNumber) throw new Error("A valid order is required to create a kitchen ticket.");

  const latest = await env.DB.prepare(
    "SELECT COALESCE(MAX(ticket_number), 0) AS max_ticket FROM kot WHERE business_id = ?"
  ).bind(businessId).first();
  const counter = await env.DB.prepare(
    "SELECT next_number FROM business_sequence_counters WHERE business_id = ? AND series_key = 'kot' LIMIT 1"
  ).bind(businessId).first();
  const ticketNumber = Math.max(Number(latest?.max_ticket || 0) + 1, Number(counter?.next_number || 1), 1);
  const orderWhere = orderId ? "o.id = ?" : "o.order_number = ?";
  const orderValue = orderId || orderNumber;
  const updatedGuard = updatedAt ? " AND o.updated_at = ?" : "";

  const statements = [env.DB.prepare(
    "INSERT INTO kot (order_id, item_name, quantity, status, kot_group_id, business_id, options, order_item_id, ticket_number) " +
    "SELECT oi.order_id, oi.item_name, oi.quantity, 'Pending', m.kot_group_id, oi.business_id, oi.options, oi.id, ? " +
    "FROM orders o JOIN order_items oi ON oi.order_id = o.id AND oi.business_id = o.business_id " +
    "LEFT JOIN menu m ON m.id = oi.menu_id AND m.business_id = oi.business_id " +
     "WHERE o.business_id = ? AND " + orderWhere + updatedGuard + " " +
    "AND NOT EXISTS (SELECT 1 FROM kot k WHERE k.business_id = oi.business_id AND k.order_item_id = oi.id) " +
    "ORDER BY oi.id"
  ).bind(...[ticketNumber, businessId, orderValue, ...(updatedAt ? [updatedAt] : [])])];

  statements.push(env.DB.prepare(
    "INSERT INTO business_sequence_counters (business_id, series_key, next_number) " +
    "SELECT ?, 'kot', ? WHERE changes() > 0 " +
    "ON CONFLICT(business_id, series_key) DO UPDATE SET " +
    "next_number = MAX(business_sequence_counters.next_number, excluded.next_number), updated_at = CURRENT_TIMESTAMP"
  ).bind(businessId, ticketNumber + 1));

  if (queueDevicePrint) {
    const host = await env.DB.prepare(
      "SELECT enabled FROM kot_device_print_hosts WHERE business_id = ? LIMIT 1"
    ).bind(businessId).first();
    if (Boolean(host?.enabled)) {
      statements.push(env.DB.prepare(
        "INSERT INTO kot_device_print_jobs (business_id, order_id, ticket_number) " +
        "SELECT o.business_id, o.id, ? FROM orders o " +
         "WHERE o.business_id = ? AND " + orderWhere + updatedGuard + " " +
        "AND EXISTS (SELECT 1 FROM kot k WHERE k.business_id = o.business_id AND k.order_id = o.id AND k.ticket_number = ?) " +
        "ON CONFLICT(business_id, order_id, ticket_number) DO NOTHING"
       ).bind(...[ticketNumber, businessId, orderValue, ...(updatedAt ? [updatedAt] : []), ticketNumber]) );
    }
  }
  return { statements, ticketNumber };
}

export async function createKotForOrder(env, businessId, orderId, { queueDevicePrint = true } = {}) {
  const statements = await buildKotStatements(env, businessId, { orderId }, { queueDevicePrint });
  const results = await env.DB.batch(statements.statements);
  const created = Number(results?.[0]?.meta?.changes || 0);
  return { created, ticketNumber: created ? statements.ticketNumber : null };
}
