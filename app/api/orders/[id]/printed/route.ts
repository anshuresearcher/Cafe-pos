import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";

export const runtime = "nodejs";
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) { try { const auth = await authorizedSession(request, "orders.print_open"); if (auth.response) return auth.response; const id = Number((await params).id); const result = await withTenant(auth.session!.businessId, (client) => client.query("UPDATE orders SET bill_printed_at=COALESCE(bill_printed_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND business_id=$2 AND status='Completed' RETURNING id,bill_printed_at", [id, auth.session!.businessId])); if (!result.rows.length) return Response.json({ error: "Completed order not found" }, { status: 404 }); return Response.json({ success: true, billPrintedAt: result.rows[0].bill_printed_at }); } catch { return Response.json({ error: "Could not record the bill print" }, { status: 500 }); } }
