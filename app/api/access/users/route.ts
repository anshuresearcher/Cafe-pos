import type { NextRequest } from "next/server";
import { authorizedSession } from "@/src/server/auth";
import { withTenant } from "@/src/server/db";
import { accessUser, canManageRole, hashPassword } from "@/src/server/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = `SELECT u.id,u.display_name,u.username,u.profile_id,u.active,u.is_blocked,u.blocked_at,u.block_reason,u.failed_login_attempts,u.created_at,p.name AS profile_name FROM app_users u LEFT JOIN access_profiles p ON p.id=u.profile_id AND p.business_id=u.business_id WHERE u.business_id=$1 ORDER BY u.id`;

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizedSession(request, "access.view");
    if (auth.response) return auth.response;
    const result = await withTenant(auth.session!.businessId, (client) => client.query(query, [auth.session!.businessId]));
    return Response.json(result.rows.map(accessUser));
  } catch { return Response.json({ error: "Failed to load users" }, { status: 500 }); }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizedSession(request, "access.create");
    if (auth.response) return auth.response;
    const body = await request.json().catch(() => ({}));
    const displayName = String(body.displayName || "").trim();
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    const requestedProfileId = body.profileId === null || body.profileId === undefined || body.profileId === "" ? null : Number(body.profileId);
    if (!displayName || !username) return Response.json({ error: "Display name and username are required" }, { status: 400 });
    if (password.length < 6) return Response.json({ error: "Password must be at least 6 characters" }, { status: 400 });
    if (requestedProfileId === null || !Number.isInteger(requestedProfileId) || requestedProfileId <= 0) return Response.json({ error: "Choose an access profile for the new user" }, { status: 400 });
    const profileId = requestedProfileId as number;
    const result = await withTenant(auth.session!.businessId, async (client) => {
      const profile = (await client.query("SELECT id,name FROM access_profiles WHERE id=$1 AND business_id=$2", [profileId, auth.session!.businessId])).rows[0];
      if (!profile) return { error: Response.json({ error: "Invalid access profile" }, { status: 400 }) };
      if (!canManageRole(auth.user!.profile_name, profile.name)) return { error: Response.json({ error: "You can only create users with a lower access level than yours" }, { status: 403 }) };
      const user = await client.query("INSERT INTO app_users(display_name,username,password_hash,profile_id,business_id,active) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,display_name,username,profile_id,business_id,active,created_at,updated_at", [displayName, username, await hashPassword(password), profileId, auth.session!.businessId, body.active !== false]);
      return { user: user.rows[0] };
    });
    if (result.error) return result.error;
    return Response.json({ success: true, user: result.user }, { status: 201 });
  } catch (error: any) { return Response.json({ error: error?.code === "23505" ? "A user with this username already exists in this business" : "Failed to create user" }, { status: error?.code === "23505" ? 409 : 500 }); }
}
