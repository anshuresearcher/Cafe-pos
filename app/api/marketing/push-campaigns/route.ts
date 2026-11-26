import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) { try { const auth = await authorizedSession(request, "marketing.view"); if (auth.response) return auth.response; const result = await withTenant(auth.session!.businessId, (client) => client.query("SELECT id,title,message,target_url,status,subscriber_count,sent_count,failed_count,created_at,sent_at FROM marketing_push_campaigns WHERE business_id=$1 ORDER BY created_at DESC LIMIT 50", [auth.session!.businessId])); return Response.json({ campaigns: result.rows }); } catch { return Response.json({ error: "Could not load notification campaigns" }, { status: 500 }); } }
