import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";
import { testNetworkPrinter } from "@/src/server/printers";
export const runtime = "nodejs";
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) { try { const auth = await authorizedSession(request, "printer.print"); if (auth.response) return auth.response; const id = Number((await params).id); const printer = (await withTenant(auth.session!.businessId, (client) => client.query("SELECT * FROM printers WHERE id=$1 AND business_id=$2 AND active=TRUE", [id, auth.session!.businessId]))).rows[0]; if (!printer) return Response.json({ error: "Printer not found" }, { status: 404 }); if (printer.connection_type === "network") { await testNetworkPrinter(printer.host, printer.port); return Response.json({ success: true, mode: "network" }); } return Response.json({ success: true, mode: printer.connection_type }); } catch (error: any) { return Response.json({ error: error?.message || "Printer test failed" }, { status: 502 }); } }
