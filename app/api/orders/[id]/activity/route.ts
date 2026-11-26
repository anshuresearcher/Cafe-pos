import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { const auth = await authorizedSession(request, "orders.view"); if (auth.response) return auth.response; const id = Number((await params).id); const result = await withTenant(auth.session!.businessId, (client) => client.query("SELECT id,event_type,description,actor,created_at FROM order_activity WHERE order_id=$1 AND business_id=$2 ORDER BY created_at DESC,id DESC", [id, auth.session!.businessId])); const activities = result.rows.map((activity) => { const actor = String(activity.actor || "Staff"); return { ...activity, actor, description: String(activity.description || "").replace(/Cancelled by user ID \d+/gi, `Cancelled by ${actor}`) }; }); return Response.json({ activities }); } catch { return Response.json({ error: "Failed to load order activity" }, { status: 500 }); }
}
