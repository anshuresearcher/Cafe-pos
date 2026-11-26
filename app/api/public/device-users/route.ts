import { withSystem } from "@/src/server/db";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const deviceId = request.cookies.get("cafe_device_id")?.value;
  if (!deviceId) return Response.json({ error: "This device is not registered" }, { status: 403 });
  try {
    const result = await withSystem((client) => client.query(`
      SELECT u.display_name AS "displayName",u.username,p.name AS "profileName",u.is_blocked AS "isBlocked"
      FROM registered_devices d
      JOIN businesses b ON b.id=d.business_id AND b.active=TRUE
      JOIN app_users u ON u.business_id=b.id AND u.active=TRUE
      LEFT JOIN access_profiles p ON p.id=u.profile_id AND p.business_id=u.business_id
      WHERE d.device_id=$1 AND d.status='active'
      ORDER BY u.is_owner DESC,LOWER(u.display_name),LOWER(u.username)
    `, [deviceId]));
    return Response.json({ users: result.rows });
  } catch {
    return Response.json({ error: "Could not load business users" }, { status: 500 });
  }
}
