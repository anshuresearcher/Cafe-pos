import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { const auth = await authorizedSession(request, "payments.view"); if (auth.response) return auth.response; const id = Number((await params).id); const result = await withTenant(auth.session!.businessId, (client) => client.query(`SELECT o.total,o.payment_method,COALESCE(summary.amount_collected,0) AS amount_collected,COALESCE(summary.allocations,'[]'::json) AS allocations FROM orders o LEFT JOIN LATERAL (SELECT COALESCE(SUM(method_amount),0) AS amount_collected,COALESCE(json_agg(json_build_object('method',payment_method,'amount',method_amount) ORDER BY payment_method),'[]'::json) AS allocations FROM (SELECT payment_method,SUM(amount) AS method_amount FROM payments WHERE order_id=o.id AND business_id=o.business_id AND payment_status='Success' GROUP BY payment_method) payment_totals) summary ON TRUE WHERE o.id=$1 AND o.business_id=$2`, [id, auth.session!.businessId])); if (!result.rows.length) return Response.json({ error: "Order not found" }, { status: 404 }); const row = result.rows[0], total = Number(row.total || 0), amountCollected = Number(row.amount_collected || 0); return Response.json({ total, amountCollected, amountDue: /non.?chargeable/i.test(String(row.payment_method || "")) ? 0 : Math.max(0, total - amountCollected), allocations: row.allocations || [] }); } catch { return Response.json({ error: "Failed to load payment summary" }, { status: 500 }); }
}
