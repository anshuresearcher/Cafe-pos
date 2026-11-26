import { withSystem } from "@/src/server/db";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const deviceId = request.cookies.get("cafe_device_id")?.value;
  if (!deviceId) return Response.json({ businessName: "" });
  try {
    const result = await withSystem((client) => client.query(`
      SELECT b.business_name AS "businessName"
      FROM registered_devices d JOIN businesses b ON b.id=d.business_id
      WHERE d.device_id=$1 AND d.status='active' AND b.active=TRUE LIMIT 1
    `, [deviceId]));
    return Response.json(result.rows[0] || { businessName: "" });
  } catch {
    return Response.json({ error: "Could not load business name" }, { status: 500 });
  }
}
