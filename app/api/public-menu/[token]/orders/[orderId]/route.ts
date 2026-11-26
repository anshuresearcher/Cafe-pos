import { withSystem, withTenant } from "@/src/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ token: string; orderId: string }> }) {
  const { token, orderId: rawOrderId } = await params;
  const orderId = Number(rawOrderId);
  const trackingToken = new URL(request.url).searchParams.get("tracking") || "";
  if (!/^[a-f0-9]{48}$/i.test(token) || !Number.isInteger(orderId) || orderId <= 0 || !/^[a-f0-9]{48}$/i.test(trackingToken)) return Response.json({ error: "Order not found" }, { status: 404 });
  try {
    const access = await withSystem((client) => client.query("SELECT business_id,enabled,EXISTS (SELECT 1 FROM business_licenses l WHERE l.business_id=public_menu_settings.business_id AND l.status='active' AND l.starts_at<=CURRENT_TIMESTAMP AND l.expires_at>=CURRENT_TIMESTAMP AND LOWER(COALESCE(l.add_on,'')) LIKE '%table qr%') AS has_qr_addon FROM public_menu_settings WHERE token=$1 LIMIT 1", [token]));
    const publication = access.rows[0];
    if (!publication?.enabled || !publication.has_qr_addon) return Response.json({ error: "Order not found" }, { status: 404 });
    const data = await withTenant(Number(publication.business_id), async (client) => {
      const orderResult = await client.query(`SELECT o.id,o.order_number,o.order_type,o.table_number,o.status,o.subtotal,o.gst,o.total,o.created_at,COALESCE(paid.amount_collected,0) AS amount_collected,GREATEST(o.total-COALESCE(paid.amount_collected,0),0) AS amount_due,COALESCE(paid.amount_collected,0)>=o.total AS is_paid FROM orders o LEFT JOIN LATERAL (SELECT SUM(amount) AS amount_collected FROM payments WHERE business_id=o.business_id AND order_id=o.id AND payment_status='Success') paid ON TRUE WHERE o.business_id=$1 AND o.id=$2 AND o.public_tracking_token=$3 LIMIT 1`, [publication.business_id, orderId, trackingToken]);
      if (!orderResult.rows[0]) return null;
      const lines = await client.query("SELECT item_name,quantity,price,line_total,options FROM order_items WHERE business_id=$1 AND order_id=$2 ORDER BY id", [publication.business_id, orderId]);
      return { ...orderResult.rows[0], items: lines.rows };
    });
    if (!data) return Response.json({ error: "Order not found" }, { status: 404 });
    const number = (value: unknown) => Number(value || 0);
    return Response.json({ order: { ...data, subtotal: number(data.subtotal), gst: number(data.gst), total: number(data.total), amount_collected: number(data.amount_collected), amount_due: number(data.amount_due), is_paid: data.is_paid === true, items: data.items.map((item: any) => ({ ...item, quantity: number(item.quantity), price: number(item.price), line_total: number(item.line_total) })) } }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Could not load this order" }, { status: 500 });
  }
}
