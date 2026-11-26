import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";
export const runtime = "nodejs";
export async function GET(request: NextRequest) { try { const auth = await authorizedSession(request, "kot_groups.view"); if (auth.response) return auth.response; const result = await withTenant(auth.session!.businessId, (client) => client.query("SELECT id,name,connection_type,paper_width FROM printers WHERE business_id=$1 AND active=TRUE ORDER BY is_default DESC,name", [auth.session!.businessId])); return Response.json(result.rows); } catch { return Response.json({ error: "Failed to load printers for KOT groups" }, { status: 500 }); } }
