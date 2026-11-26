import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) { try { const auth = await authorizedSession(request, "payments.view"); if (auth.response) return auth.response; const result = await withTenant(auth.session!.businessId, (client) => client.query("SELECT * FROM payments WHERE business_id=$1 ORDER BY created_at DESC", [auth.session!.businessId])); return Response.json(result.rows); } catch { return Response.json({ error: "Failed to load payments" }, { status: 500 }); } }
export async function POST() { return Response.json({ error: "Direct payment creation is disabled. Record payments through order settlement." }, { status: 410 }); }
