import { withSystem } from "@/src/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{48}$/i.test(token)) return Response.json({ error: "Menu not found" }, { status: 404 });
  try {
    const result = await withSystem((client) => client.query(`
      SELECT s.business_id, s.enabled, b.business_name,
             EXISTS (
               SELECT 1 FROM business_licenses l
               WHERE l.business_id=s.business_id AND l.status='active'
                 AND l.starts_at<=CURRENT_TIMESTAMP AND l.expires_at>=CURRENT_TIMESTAMP
                 AND LOWER(COALESCE(l.add_on,'')) LIKE '%table qr%'
             ) AS has_qr_addon
      FROM public_menu_settings s JOIN businesses b ON b.id=s.business_id
      WHERE s.token=$1 LIMIT 1
    `, [token]));
    const publication = result.rows[0];
    if (!publication?.enabled || !publication.has_qr_addon) return Response.json({ error: "Menu not found" }, { status: 404 });
    const name = String(publication.business_name || "Cafe & Restaurant").slice(0, 80);
    return Response.json({
      id: `/restaurant/${token}`,
      name: `${name} · Slash QR Menu`,
      short_name: name.slice(0, 30),
      description: `Browse the menu at ${name}, powered by Slash.`,
      start_url: `/restaurant/${token}`,
      scope: "/",
      display: "standalone",
      background_color: "#f5f3ec",
      theme_color: "#25222f",
      icons: [
        { src: "/qr-menu-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/qr-menu-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        { src: "/qr-menu-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      ],
    }, { headers: { "Cache-Control": "public, max-age=0, must-revalidate", "Content-Type": "application/manifest+json" } });
  } catch {
    return Response.json({ error: "Could not load menu app details" }, { status: 500 });
  }
}
