import { withSystem, withTenant } from "@/src/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{48}$/i.test(token)) return Response.json({ error: "Menu not found" }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  const tableNumber = String(body.tableNumber || "").trim();
  const requestType = String(body.requestType || "").trim();
  if (!tableNumber || tableNumber.length > 60 || !["clean_table", "call_waiter"].includes(requestType)) {
    return Response.json({ error: "Choose a valid table and service request." }, { status: 400 });
  }
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
    const serviceRequest = await withTenant(businessId, async (client) => {
      const table = await client.query("SELECT table_number FROM restaurant_tables WHERE business_id=$1 AND table_number::text=$2 LIMIT 1", [businessId, tableNumber]);
      if (!table.rows.length) throw Object.assign(new Error("This table QR is no longer active. Please ask the team for help."), { status: 409 });
      const result = await client.query(`
        INSERT INTO qr_service_requests(business_id,table_number,request_type)
        VALUES($1,$2,$3) RETURNING id,table_number,request_type,status,created_at
      `, [businessId, String(table.rows[0].table_number), requestType]);
      return result.rows[0];
    });
    return Response.json({ success: true, request: serviceRequest }, { status: 201 });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
    return Response.json({ error: error instanceof Error ? error.message : "Could not notify the cafe team" }, { status });
  }
}
