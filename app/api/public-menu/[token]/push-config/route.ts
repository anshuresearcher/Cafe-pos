import { withSystem } from "@/src/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{48}$/i.test(token)) return Response.json({ error: "Menu not found" }, { status: 404 });
  try {
    const result = await withSystem((client) => client.query(`
      SELECT s.business_id,s.enabled,
             EXISTS (
               SELECT 1 FROM business_licenses l
               WHERE l.business_id=s.business_id AND l.status='active'
                 AND l.starts_at<=CURRENT_TIMESTAMP AND l.expires_at>=CURRENT_TIMESTAMP
                 AND LOWER(COALESCE(l.add_on,'')) LIKE '%table qr%'
             ) AS has_qr_addon,
             EXISTS (
               SELECT 1 FROM business_licenses l
               WHERE l.business_id=s.business_id AND l.status='active'
                 AND l.starts_at<=CURRENT_TIMESTAMP AND l.expires_at>=CURRENT_TIMESTAMP
                 AND LOWER(COALESCE(l.add_on,'')) LIKE '%marketing%'
             ) AS has_marketing_addon
      FROM public_menu_settings s WHERE s.token=$1 LIMIT 1
    `, [token]));
    const publication = result.rows[0];
    if (!publication?.enabled || !publication.has_qr_addon) return Response.json({ error: "Menu not found" }, { status: 404 });
    const marketingEnabled = Boolean(publication.has_marketing_addon);
    const configured = marketingEnabled && Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
    return Response.json({ configured, marketingEnabled, publicKey: configured ? process.env.VAPID_PUBLIC_KEY : null }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Could not load notification settings" }, { status: 500 });
  }
}
