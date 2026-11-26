import type { NextRequest } from "next/server";
import { authorizedSession } from "@/src/server/auth";
import { withTenant } from "@/src/server/db";
import { canManageRole, isBuiltInRole, isSlashOps, reservedProfileName } from "@/src/server/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorizedSession(request, "access.edit");
    if (auth.response) return auth.response;
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Invalid profile ID" }, { status: 400 });
    const body = await request.json().catch(() => ({}));
    const result = await withTenant(auth.session!.businessId, async (client) => {
      const current = (await client.query("SELECT * FROM access_profiles WHERE id=$1 AND business_id=$2", [id, auth.session!.businessId])).rows[0];
      if (!current) return { error: Response.json({ error: "Access profile not found" }, { status: 404 }) };
      if (!canManageRole(auth.user!.profile_name, current.name)) return { error: Response.json({ error: "You can only change permissions for profiles below your access level" }, { status: 403 }) };
      const builtIn = isBuiltInRole(current.name);
      const name = builtIn ? current.name : String(body.name ?? current.name).trim();
      if (!name) return { error: Response.json({ error: "Profile name is required" }, { status: 400 }) };
      if (!builtIn && (!isSlashOps(auth.user!.profile_name) || reservedProfileName(name))) return { error: Response.json({ error: "Only Slash ops can edit custom access profiles" }, { status: 403 }) };
      const own = await client.query("SELECT 1 FROM app_users WHERE id=$1 AND business_id=$2 AND profile_id=$3 LIMIT 1", [auth.user!.id, auth.session!.businessId, id]);
      if (own.rows.length) return { error: Response.json({ error: "You cannot edit the access profile assigned to your own account" }, { status: 403 }) };
      const updated = await client.query("UPDATE access_profiles SET name=$1,description=$2,permissions=$3::jsonb,updated_at=CURRENT_TIMESTAMP WHERE id=$4 AND business_id=$5 RETURNING *", [name, builtIn ? current.description : String(body.description ?? current.description ?? "").trim() || null, JSON.stringify(body.permissions && typeof body.permissions === "object" ? body.permissions : current.permissions), id, auth.session!.businessId]);
      return { profile: updated.rows[0] };
    });
    if (result.error) return result.error;
    return Response.json({ success: true, profile: result.profile });
  } catch (error: any) { return Response.json({ error: error?.code === "23505" ? "An access profile with this name already exists" : "Failed to update access profile" }, { status: error?.code === "23505" ? 409 : 500 }); }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorizedSession(request, "access.delete");
    if (auth.response) return auth.response;
    if (!isSlashOps(auth.user!.profile_name)) return Response.json({ error: "Only Slash ops can manage access profiles" }, { status: 403 });
    const id = Number((await params).id);
    const result = await withTenant(auth.session!.businessId, (client) => client.query("DELETE FROM access_profiles WHERE id=$1 AND business_id=$2 AND LOWER(name) NOT IN ('slash ops','admin','manager','cashier') RETURNING id", [id, auth.session!.businessId]));
    if (!result.rowCount) return Response.json({ error: "Access profile not found or cannot be deleted" }, { status: 404 });
    return Response.json({ success: true });
  } catch { return Response.json({ error: "Failed to delete access profile" }, { status: 500 }); }
}
