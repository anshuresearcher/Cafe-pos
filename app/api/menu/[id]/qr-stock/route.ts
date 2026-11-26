import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";

export const runtime = "nodejs";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { const auth = await authorizedSession(request, "menu.edit"); if (auth.response) return auth.response; const id = Number((await params).id); const body = await request.json(); if (!Number.isInteger(id) || id <= 0 || typeof body?.inStock !== "boolean") return Response.json({ error: "Choose whether this item is in stock for the QR menu" }, { status: 400 }); const result = await withTenant(auth.session!.businessId, (client) => client.query("UPDATE menu SET qr_available=$1 WHERE id=$2 AND business_id=$3 RETURNING id,qr_available", [body.inStock, id, auth.session!.businessId])); if (!result.rows.length) return Response.json({ error: "Menu item not found" }, { status: 404 }); return Response.json({ success: true, item: result.rows[0] }); } catch { return Response.json({ error: "Could not update QR menu stock" }, { status: 500 }); }
}
