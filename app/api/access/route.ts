import type { NextRequest } from "next/server";
import { authorizedSession } from "@/src/server/auth";
import { withTenant } from "@/src/server/db";
import { accessUser, canManageRole, isBuiltInRole, isSlashOps } from "@/src/server/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const userQuery = `SELECT u.id,u.display_name,u.username,u.profile_id,u.active,u.is_blocked,u.blocked_at,u.block_reason,u.failed_login_attempts,u.created_at,p.name AS profile_name FROM app_users u LEFT JOIN access_profiles p ON p.id=u.profile_id AND p.business_id=u.business_id WHERE u.business_id=$1 ORDER BY u.id`;
const profileQuery = "SELECT id,name,description,permissions,created_at,updated_at FROM access_profiles WHERE business_id=$1 ORDER BY name";

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizedSession(request, "access.view");
    if (auth.response) return auth.response;
    const businessId = auth.session!.businessId;
    const [users, profiles] = await withTenant(businessId, (client) => Promise.all([client.query(userQuery, [businessId]), client.query(profileQuery, [businessId])]));
    const manageableProfiles = profiles.rows.filter((profile: any) => canManageRole(auth.user!.profile_name, profile.name));
    const slashOps = isSlashOps(auth.user!.profile_name);
    return Response.json({
      users: users.rows.map((user: any) => ({ ...accessUser(user), can_manage: Number(user.id) !== Number(auth.user!.id) && canManageRole(auth.user!.profile_name, user.profile_name) })),
      profiles: manageableProfiles.map((profile: any) => ({ ...profile, can_assign: true, can_edit: true, can_edit_identity: slashOps && !isBuiltInRole(profile.name), can_delete: slashOps && !isBuiltInRole(profile.name), is_built_in: isBuiltInRole(profile.name) })),
      currentProfileName: auth.user!.profile_name,
      canManageProfiles: manageableProfiles.length > 0,
      canCreateProfiles: slashOps,
    });
  } catch {
    return Response.json({ error: "Failed to load access data" }, { status: 500 });
  }
}
