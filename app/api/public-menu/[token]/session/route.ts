import crypto from "node:crypto";
import { withSystem } from "@/src/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cookieName(token: string) {
  return `slash_qr_${crypto.createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}

function phoneValue(value: string | null) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!/^\d{10}$/.test(digits)) throw Object.assign(new Error("Enter a valid 10-digit Indian mobile number."), { status: 400 });
  return digits;
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{48}$/i.test(token)) return Response.json({ error: "Menu not found" }, { status: 404 });
  try {
    const url = new URL(request.url);
    const phone = phoneValue(url.searchParams.get("phone"));
    const tableNumber = String(url.searchParams.get("tableNumber") || "").trim();
    const menuHash = crypto.createHash("sha256").update(token).digest("hex");
    const result = await withSystem(async (client) => {
      const publication = await client.query(`
        SELECT s.business_id,s.enabled,
               EXISTS (
                 SELECT 1 FROM business_licenses l
                 WHERE l.business_id=s.business_id AND l.status='active'
                   AND l.starts_at<=CURRENT_TIMESTAMP AND l.expires_at>=CURRENT_TIMESTAMP
                   AND LOWER(COALESCE(l.add_on,'')) LIKE '%table qr%'
               ) AS has_qr_addon
        FROM public_menu_settings s WHERE s.token=$1 LIMIT 1
      `, [token]);
      const menu = publication.rows[0];
      if (!menu?.enabled || !menu.has_qr_addon) throw Object.assign(new Error("This QR menu is not currently accepting orders"), { status: 404 });
      const cookie = request.headers.get("cookie")?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${cookieName(token)}=`))?.slice(cookieName(token).length + 1);
      if (!cookie || !/^[a-f0-9]{64}$/i.test(cookie)) return null;
      const sessionHash = crypto.createHash("sha256").update(decodeURIComponent(cookie)).digest("hex");
      const session = await client.query(`
        SELECT id,customer_id,phone FROM qr_guest_sessions
        WHERE session_token_hash=$1 AND business_id=$2 AND menu_token_hash=$3 AND table_number=$4
          AND phone=$5 AND expires_at>CURRENT_TIMESTAMP LIMIT 1
      `, [sessionHash, menu.business_id, menuHash, tableNumber, phone]);
      if (!session.rows.length) return null;
      await client.query("UPDATE qr_guest_sessions SET last_activity_at=CURRENT_TIMESTAMP,expires_at=CURRENT_TIMESTAMP+INTERVAL '2 hours' WHERE id=$1", [session.rows[0].id]);
      return { session: session.rows[0], businessId: menu.business_id, token: cookie };
    });
    if (!result) return Response.json({ verified: false }, { status: 401, headers: { "Cache-Control": "no-store" } });
    const response = Response.json({ verified: true, customerId: result.session.customer_id, expiresInSeconds: 7200 }, { headers: { "Cache-Control": "no-store" } });
    response.headers.append("Set-Cookie", `${cookieName(token)}=${encodeURIComponent(result.token)}; Path=/public-menu/${token}; Max-Age=7200; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" || process.env.VERCEL ? "; Secure" : ""}`);
    return response;
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
    return Response.json({ error: error instanceof Error ? error.message : "Could not check verification session" }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
