import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";
export const runtime = "nodejs";
export async function GET(request: NextRequest) { try { const auth = await authorizedSession(request, ["new_order.create", "kitchen.print", "orders.view"]); if (auth.response) return auth.response; const result = await withTenant(auth.session!.businessId, (client) => client.query("SELECT enabled FROM kot_device_print_hosts WHERE business_id=$1 LIMIT 1", [auth.session!.businessId])); return Response.json({ printAllTicketsFromDevice: result.rows[0]?.enabled === true }); } catch { return Response.json({ error: "Could not load kitchen ticket printing mode." }, { status: 500 }); } }
