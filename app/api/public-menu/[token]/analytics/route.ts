import crypto from "node:crypto";
import { withSystem, withTenant } from "@/src/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{48}$/i.test(token)) return Response.json({ error: "Menu not found" }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  const sessionId = String(body.sessionId || "").trim();
  const eventType = String(body.eventType || "").trim();
  if (!/^[a-f0-9]{32,64}$/i.test(sessionId) || !["menu_view", "cart_updated", "checkout_started"].includes(eventType)) {
    return Response.json({ error: "Invalid menu analytics event" }, { status: 400 });
  }
  const itemCount = eventType === "cart_updated" ? Math.max(0, Math.min(100, Math.floor(Number(body.itemCount) || 0))) : 0;
  try {
    const access = await withSystem((client) => client.query(`
      SELECT s.business_id,s.enabled,
             EXISTS (
               SELECT 1 FROM business_licenses l
               WHERE l.business_id=s.business_id AND l.status='active'
                 AND l.starts_at<=CURRENT_TIMESTAMP AND l.expires_at>=CURRENT_TIMESTAMP
                 AND LOWER(COALESCE(l.add_on,'')) LIKE '%table qr%'
             ) AS has_qr_addon
      FROM public_menu_settings s WHERE s.token=$1 LIMIT 1
    `, [token]));
    const publication = access.rows[0];
    if (!publication?.enabled || !publication.has_qr_addon) return Response.json({ error: "This QR menu is not currently available" }, { status: 404 });
    const businessId = Number(publication.business_id);
    const sessionKey = crypto.createHash("sha256").update(`${businessId}:${token}:${sessionId}`).digest("hex");
    await withTenant(businessId, (client) => client.query(`
      INSERT INTO qr_menu_events(business_id,session_key,event_type,item_count) VALUES($1,$2,$3,$4)
    `, [businessId, sessionKey, eventType, itemCount]));
    return new Response(null, { status: 204 });
  } catch {
    return Response.json({ error: "Could not record menu activity" }, { status: 500 });
  }
}
