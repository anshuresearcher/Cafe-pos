import type { NextRequest } from "next/server";
import { authorizedSession } from "@/src/server/auth";
import { withTenant } from "@/src/server/db";
import { canManageRole, hashPassword } from "@/src/server/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorizedSession(request, "access.edit");
    if (auth.response) return auth.response;
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Invalid user ID" }, { status: 400 });
    if (id === Number(auth.user!.id)) return Response.json({ error: "You cannot edit your own account from Access management" }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    const result = await withTenant(auth.session!.businessId, async (client) => {
      const old = (await client.query("SELECT * FROM app_users WHERE id=$1 AND business_id=$2", [id, auth.session!.businessId])).rows[0];
      if (!old) return { error: Response.json({ error: "User not found" }, { status: 404 }) };
      const oldProfile = (await client.query("SELECT name FROM access_profiles WHERE id=$1 AND business_id=$2", [old.profile_id, auth.session!.businessId])).rows[0];
      if (!canManageRole(auth.user!.profile_name, oldProfile?.name)) return { error: Response.json({ error: "You can only edit users below your access level" }, { status: 403 }) };
      const displayName = body.displayName === undefined ? old.display_name : String(body.displayName).trim();
      const username = body.username === undefined ? old.username : String(body.username).trim().toLowerCase();
      const requestedProfileId = body.profileId === undefined ? Number(old.profile_id) : (body.profileId === null || body.profileId === "" ? null : Number(body.profileId));
      const password = String(body.password || "");
      if (!displayName || !username) return { error: Response.json({ error: "Display name and username are required" }, { status: 400 }) };
      if (password && password.length < 6) return { error: Response.json({ error: "Password must be at least 6 characters" }, { status: 400 }) };
      if (requestedProfileId === null || !Number.isInteger(requestedProfileId) || requestedProfileId <= 0) return { error: Response.json({ error: "Choose a valid access profile for this user" }, { status: 400 }) };
      const profileId = requestedProfileId as number;
      const profile = (await client.query("SELECT id,name FROM access_profiles WHERE id=$1 AND business_id=$2", [profileId, auth.session!.businessId])).rows[0];
      if (!profile) return { error: Response.json({ error: "Invalid access profile" }, { status: 400 }) };
      if (!canManageRole(auth.user!.profile_name, profile.name)) return { error: Response.json({ error: "You can only assign a lower access level than yours" }, { status: 403 }) };
      const result = password ? await client.query("UPDATE app_users SET display_name=$1,username=$2,password_hash=$3,profile_id=$4,active=$5,permissions_override=NULL,is_owner=CASE WHEN $4 IS DISTINCT FROM $8 THEN FALSE ELSE is_owner END,updated_at=CURRENT_TIMESTAMP WHERE id=$6 AND business_id=$7 RETURNING id,display_name,username,profile_id,business_id,active,created_at,updated_at", [displayName, username, await hashPassword(password), profileId, body.active === undefined ? old.active : Boolean(body.active), id, auth.session!.businessId, old.profile_id]) : await client.query("UPDATE app_users SET display_name=$1,username=$2,profile_id=$3,active=$4,permissions_override=NULL,is_owner=CASE WHEN $3 IS DISTINCT FROM $7 THEN FALSE ELSE is_owner END,updated_at=CURRENT_TIMESTAMP WHERE id=$5 AND business_id=$6 RETURNING id,display_name,username,profile_id,business_id,active,created_at,updated_at", [displayName, username, profileId, body.active === undefined ? old.active : Boolean(body.active), id, auth.session!.businessId, old.profile_id]);
      if (password || body.active === false || username !== old.username) await client.query("DELETE FROM app_sessions WHERE user_id=$1 AND business_id=$2", [id, auth.session!.businessId]);
      return { user: result.rows[0] };
    });
    if (result.error) return result.error;
    return Response.json({ success: true, user: result.user });
  } catch (error: any) { return Response.json({ error: error?.code === "23505" ? "A user with this username already exists in this business" : "Failed to update user" }, { status: error?.code === "23505" ? 409 : 500 }); }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorizedSession(request, "access.delete");
    if (auth.response) return auth.response;
    const id = Number((await params).id);
    if (id === Number(auth.user!.id)) return Response.json({ error: "You cannot delete your own account" }, { status: 403 });
    const result = await withTenant(auth.session!.businessId, async (client) => {
      const user = (await client.query("SELECT u.id,p.name AS profile_name FROM app_users u LEFT JOIN access_profiles p ON p.id=u.profile_id AND p.business_id=u.business_id WHERE u.id=$1 AND u.business_id=$2", [id, auth.session!.businessId])).rows[0];
      if (!user) return { error: Response.json({ error: "User not found" }, { status: 404 }) };
      if (!canManageRole(auth.user!.profile_name, user.profile_name)) return { error: Response.json({ error: "You can only delete users below your access level" }, { status: 403 }) };
      await client.query("DELETE FROM app_sessions WHERE user_id=$1 AND business_id=$2", [id, auth.session!.businessId]);
      await client.query("DELETE FROM app_users WHERE id=$1 AND business_id=$2", [id, auth.session!.businessId]);
      return {};
    });
    if (result.error) return result.error;
    return Response.json({ success: true });
  } catch { return Response.json({ error: "Failed to delete user" }, { status: 500 }); }
}
