import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";

export const runtime = "nodejs";
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) { try { const auth = await authorizedSession(request, "expenses.delete"); if (auth.response) return auth.response; const id = Number((await params).id); await withTenant(auth.session!.businessId, (client) => client.query("DELETE FROM expenses WHERE id=$1 AND business_id=$2", [id, auth.session!.businessId])); return Response.json({ success: true }); } catch { return Response.json({ error: "Failed to delete expense" }, { status: 500 }); } }
