import { withSystem, withTenant } from "@/src/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function allowedPushHost(hostname: string) {
  const host = hostname.toLowerCase();
  return host === "fcm.googleapis.com" || host.endsWith(".fcm.googleapis.com")
    || host === "updates.push.services.mozilla.com" || host.endsWith(".push.services.mozilla.com")
    || host === "web.push.apple.com" || host.endsWith(".web.push.apple.com")
    || host.endsWith(".notify.windows.com");
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{48}$/i.test(token)) return Response.json({ error: "Menu not found" }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  const subscription = body.subscription;
  const endpoint = String(subscription?.endpoint || "");
  let endpointUrl: URL;
  try { endpointUrl = new URL(endpoint); } catch { return Response.json({ error: "Invalid push subscription" }, { status: 400 }); }
  if (endpointUrl.protocol !== "https:" || !allowedPushHost(endpointUrl.hostname) || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return Response.json({ error: "Invalid push subscription" }, { status: 400 });
  }
  try {
    const access = await withSystem((client) => client.query(`
      SELECT s.business_id,s.enabled,
             EXISTS (SELECT 1 FROM business_licenses l WHERE l.business_id=s.business_id AND l.status='active' AND l.starts_at<=CURRENT_TIMESTAMP AND l.expires_at>=CURRENT_TIMESTAMP AND LOWER(COALESCE(l.add_on,'')) LIKE '%table qr%') AS has_qr_addon,
             EXISTS (SELECT 1 FROM business_licenses l WHERE l.business_id=s.business_id AND l.status='active' AND l.starts_at<=CURRENT_TIMESTAMP AND l.expires_at>=CURRENT_TIMESTAMP AND LOWER(COALESCE(l.add_on,'')) LIKE '%marketing%') AS has_marketing_addon
      FROM public_menu_settings s WHERE s.token=$1 LIMIT 1
    `, [token]));
    const publication = access.rows[0];
    if (!publication?.enabled || !publication.has_qr_addon) return Response.json({ error: "Menu not found" }, { status: 404 });
    if (!publication.has_marketing_addon) return Response.json({ error: "Promotional messages are not enabled for this cafe" }, { status: 403 });
    await withTenant(Number(publication.business_id), (client) => client.query(`
      INSERT INTO public_menu_push_subscriptions(business_id,endpoint,subscription)
      VALUES($1,$2,$3::jsonb)
      ON CONFLICT(business_id,endpoint) DO UPDATE SET subscription=EXCLUDED.subscription,updated_at=CURRENT_TIMESTAMP
    `, [publication.business_id, endpoint, JSON.stringify(subscription)]));
    return Response.json({ success: true }, { status: 201 });
  } catch {
    return Response.json({ error: "Could not save notification preference" }, { status: 500 });
  }
}
