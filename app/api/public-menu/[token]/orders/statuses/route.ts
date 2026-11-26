import { withSystem, withTenant } from "@/src/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const body = await request.json();
    const submitted = body?.orders;
    if (!/^[a-f0-9]{48}$/i.test(token) || !Array.isArray(submitted) || submitted.length > 30) return Response.json({ error: "Invalid order status request" }, { status: 400 });
    const orders = submitted.map((item: any) => ({ orderId: Number(item?.orderId), trackingToken: String(item?.trackingToken || "") }));
    if (orders.some((item: any) => !Number.isSafeInteger(item.orderId) || item.orderId <= 0 || !/^[a-f0-9]{48}$/i.test(item.trackingToken))) return Response.json({ error: "Invalid order status request" }, { status: 400 });
    const access = await withSystem((client) => client.query("SELECT business_id,enabled,EXISTS (SELECT 1 FROM business_licenses l WHERE l.business_id=public_menu_settings.business_id AND l.status='active' AND l.starts_at<=CURRENT_TIMESTAMP AND l.expires_at>=CURRENT_TIMESTAMP AND LOWER(COALESCE(l.add_on,'')) LIKE '%table qr%') AS has_qr_addon FROM public_menu_settings WHERE token=$1 LIMIT 1", [token]));
    const publication = access.rows[0];
    if (!publication?.enabled || !publication.has_qr_addon) return Response.json({ error: "Menu not found" }, { status: 404 });
    const result = await withTenant(Number(publication.business_id), (client) => client.query(`WITH requested AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x("orderId" bigint,"trackingToken" text)) SELECT o.id,o.order_number,o.order_type,o.table_number,o.status,o.total,o.created_at FROM requested r JOIN orders o ON o.id=r."orderId" AND o.business_id=$1 AND o.public_tracking_token=r."trackingToken" ORDER BY o.created_at DESC,o.id DESC`, [publication.business_id, JSON.stringify(orders)]));
    return Response.json({ orders: result.rows }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Could not refresh order statuses" }, { status: 500 });
  }
}
