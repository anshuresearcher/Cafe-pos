import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, { params }: { params: Promise<{ customerId: string }> }) { try { const auth = await authorizedSession(request, "loyalty.view"); if (auth.response) return auth.response; const customerId = Number((await params).customerId); const result = await withTenant(auth.session!.businessId, async (client) => { const customer = (await client.query("SELECT * FROM customers WHERE id=$1 AND business_id=$2", [customerId, auth.session!.businessId])).rows[0]; if (!customer) return null; const balance = (await client.query("SELECT COALESCE(SUM(points),0) points FROM loyalty_transactions WHERE customer_id=$1", [customerId])).rows[0]; const history = (await client.query("SELECT * FROM loyalty_transactions WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100", [customerId])).rows; return { customer, balance: Number(balance.points || 0), history }; }); if (!result) return Response.json({ error: "Customer not found" }, { status: 404 }); return Response.json(result); } catch { return Response.json({ error: "Failed to load loyalty history" }, { status: 500 }); } }
