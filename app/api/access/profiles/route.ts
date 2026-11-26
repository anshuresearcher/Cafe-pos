import type { NextRequest } from "next/server";
import { authorizedSession } from "@/src/server/auth";
import { withTenant } from "@/src/server/db";
import { isSlashOps, reservedProfileName } from "@/src/server/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizedSession(request, "access.view");
    if (auth.response) return auth.response;
    const result = await withTenant(auth.session!.businessId, (client) => client.query("SELECT id,name,description,permissions,created_at,updated_at FROM access_profiles WHERE business_id=$1 ORDER BY name", [auth.session!.businessId]));
    return Response.json(result.rows);
  } catch { return Response.json({ error: "Failed to load access profiles" }, { status: 500 }); }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizedSession(request, "access.create");
    if (auth.response) return auth.response;
    if (!isSlashOps(auth.user!.profile_name)) return Response.json({ error: "Only Slash ops can manage access profiles" }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    const description = String(body.description || "").trim();
    if (!name) return Response.json({ error: "Profile name is required" }, { status: 400 });
    if (reservedProfileName(name)) return Response.json({ error: "That name is reserved for a built-in access profile" }, { status: 400 });
    const permissions = body.permissions && typeof body.permissions === "object" ? body.permissions : {};
    const result = await withTenant(auth.session!.businessId, (client) => client.query("INSERT INTO access_profiles(name,business_id,description,permissions) VALUES($1,$2,$3,$4::jsonb) RETURNING *", [name, auth.session!.businessId, description || null, JSON.stringify(permissions)]));
    return Response.json({ success: true, profile: result.rows[0] }, { status: 201 });
  } catch (error: any) { return Response.json({ error: error?.code === "23505" ? "An access profile with this name already exists" : "Failed to create access profile" }, { status: error?.code === "23505" ? 409 : 500 }); }
}
