import type { NextRequest } from "next/server";
import { authorizedSession } from "@/src/server/auth";
import { withTenant } from "@/src/server/db";
import { canManageRole } from "@/src/server/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorizedSession(request, "access.edit");
    if (auth.response) return auth.response;
    const id = Number((await params).id);
    const body = await request.json().catch(() => ({}));
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Invalid user ID" }, { status: 400 });
    if (typeof body.blocked !== "boolean") return Response.json({ error: "Choose whether to block or unblock this user" }, { status: 400 });
    if (id === Number(auth.user!.id)) return Response.json({ error: "You cannot block or unblock your own account" }, { status: 403 });
    const result = await withTenant(auth.session!.businessId, async (client) => {
      const current = (await client.query("SELECT u.id,u.username,u.is_owner,p.name AS profile_name FROM app_users u LEFT JOIN access_profiles p ON p.id=u.profile_id AND p.business_id=u.business_id WHERE u.id=$1 AND u.business_id=$2", [id, auth.session!.businessId])).rows[0];
      if (!current) return { error: Response.json({ error: "User not found" }, { status: 404 }) };
      if (!canManageRole(auth.user!.profile_name, current.profile_name)) return { error: Response.json({ error: "Only a user above this account's role can block or unblock it" }, { status: 403 }) };
      if (current.is_owner && String(auth.user!.profile_name).toLowerCase() !== "slash ops") return { error: Response.json({ error: "The business owner account cannot be blocked from Access management" }, { status: 403 }) };
      const updated = await client.query("UPDATE app_users SET is_blocked=$1,failed_login_attempts=CASE WHEN $1 THEN failed_login_attempts ELSE 0 END,blocked_at=CASE WHEN $1 THEN COALESCE(blocked_at,CURRENT_TIMESTAMP) ELSE NULL END,blocked_by_user_id=CASE WHEN $1 THEN $2 ELSE NULL END,blocked_by_support_user_id=NULL,block_reason=CASE WHEN $1 THEN 'manual' ELSE NULL END,updated_at=CURRENT_TIMESTAMP WHERE id=$3 AND business_id=$4 RETURNING id,username,is_blocked,blocked_at,block_reason,failed_login_attempts", [body.blocked, auth.user!.id, id, auth.session!.businessId]);
      if (body.blocked) await client.query("DELETE FROM app_sessions WHERE user_id=$1 AND business_id=$2", [id, auth.session!.businessId]);
      return { user: updated.rows[0] };
    });
    if (result.error) return result.error;
    return Response.json({ success: true, user: result.user });
  } catch { return Response.json({ error: "Failed to update the user's sign-in block" }, { status: 500 }); }
}
