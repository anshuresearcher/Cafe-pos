import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";

export const runtime = "nodejs";
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) { try { const auth = await authorizedSession(request, "settings.edit"); if (auth.response) return auth.response; const id = Number((await params).id); const result = await withTenant(auth.session!.businessId, (client) => client.query("UPDATE billing_adjustments SET active=NOT active,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND business_id=$2 RETURNING *", [id, auth.session!.businessId])); if (!result.rows.length) return Response.json({ error: "Billing adjustment not found" }, { status: 404 }); return Response.json(result.rows[0]); } catch { return Response.json({ error: "Failed to update billing adjustment" }, { status: 500 }); } }
