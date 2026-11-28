function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function handleInvoices(env, businessId, path, url) {
  const orderMatch = path.match(/^\/v1\/pos\/invoices\/order\/(\d+)$/);
  const idMatch = path.match(/^\/v1\/pos\/invoices\/(\d+)$/);
  if (path === "/v1/pos/invoices" && url.searchParams.has("id")) return json({ error: "Not found" }, 404);
  if (path === "/v1/pos/invoices") {
    const limit = Math.min(99, Math.max(1, Number(url.searchParams.get("limit") || 99)));
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
    if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) return json({ error: "Invalid invoice page" }, 400);
    const rows = await env.DB.prepare(
      "SELECT i.*,o.order_number,COALESCE(NULLIF(o.sales_channel_name,''),CASE WHEN o.public_tracking_token IS NOT NULL THEN 'Slash '||o.order_type ELSE o.order_type END) AS order_type,o.table_number " +
      "FROM invoices i JOIN orders o ON o.id=i.order_id AND o.business_id=i.business_id WHERE i.business_id=? " +
      "ORDER BY i.created_at DESC,i.id DESC LIMIT ? OFFSET ?"
    ).bind(businessId, limit + 1, offset).all();
    const list = rows.results || [];
    const hasMore = list.length > limit;
    return json({ items: list.slice(0, limit), limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null });
  }
  const match = orderMatch || idMatch;
  if (!match || path !== orderMatch?.input && path !== idMatch?.input) return json({ error: "Not found" }, 404);
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "Invalid invoice ID" }, 400);
  const invoice = orderMatch
    ? await env.DB.prepare(
      "SELECT i.*,o.order_number,COALESCE(NULLIF(o.sales_channel_name,''),CASE WHEN o.public_tracking_token IS NOT NULL THEN 'Slash '||o.order_type ELSE o.order_type END) AS order_type,o.table_number,o.created_at AS order_created_at " +
      "FROM invoices i JOIN orders o ON o.id=i.order_id AND o.business_id=i.business_id WHERE i.order_id=? AND i.business_id=? LIMIT 1"
    ).bind(id, businessId).first()
    : await env.DB.prepare(
      "SELECT i.*,o.order_number,COALESCE(NULLIF(o.sales_channel_name,''),CASE WHEN o.public_tracking_token IS NOT NULL THEN 'Slash '||o.order_type ELSE o.order_type END) AS order_type,o.table_number,o.created_at AS order_created_at, " +
      "c.name AS customer_name,c.phone AS customer_phone,c.email AS customer_email " +
      "FROM invoices i JOIN orders o ON o.id=i.order_id AND o.business_id=i.business_id LEFT JOIN customers c ON c.id=i.customer_id AND c.business_id=i.business_id " +
      "WHERE i.id=? AND i.business_id=? LIMIT 1"
    ).bind(id, businessId).first();
  if (!invoice) return json({ error: orderMatch ? "Invoice not found for this order" : "Invoice not found" }, 404);
  const items = await env.DB.prepare("SELECT * FROM order_items WHERE business_id=? AND order_id=? ORDER BY id").bind(businessId, Number(invoice.order_id)).all();
  return json({ invoice, items: items.results || [] });
}
