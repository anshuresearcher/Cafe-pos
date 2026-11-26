import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function channelPrices(value: unknown) { const source = value && typeof value === "object" ? value as Record<string, unknown> : {}; const result: Record<string, number> = {}; for (const key of Object.keys(source)) { if (!/^[a-z][a-z0-9_]{1,19}$/.test(key)) continue; const number = Number(source[key]); if (Number.isFinite(number) && number >= 0) result[key] = number; } return result; }

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorizedSession(request, "menu.edit"); if (auth.response) return auth.response; const id = Number((await params).id); const body = await request.json(); const price = Number(body?.price); const variants = Array.isArray(body?.variants) ? body.variants : []; if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(price) || price < 0) return Response.json({ error: "Enter a valid item price" }, { status: 400 }); if (variants.some((row: any) => !Number.isInteger(Number(row?.id)) || !Number.isFinite(Number(row?.price)) || Number(row.price) < 0 || (row.channelPrices && Object.values(row.channelPrices).some((value) => !Number.isFinite(Number(value)) || Number(value) < 0)))) return Response.json({ error: "Enter valid prices for every variant" }, { status: 400 });
    const result = await withTenant(auth.session!.businessId, async (client) => { const menu = await client.query("UPDATE menu SET price=$1,channel_prices=$2 WHERE id=$3 AND business_id=$4 RETURNING id,price,channel_prices", [price, JSON.stringify(channelPrices(body?.channelPrices)), id, auth.session!.businessId]); if (!menu.rows.length) return null; for (const variant of variants) { const updated = Object.prototype.hasOwnProperty.call(variant, "channelPrices") ? await client.query("UPDATE menu_variants SET price=$1,channel_prices=$2::jsonb,updated_at=CURRENT_TIMESTAMP WHERE id=$3 AND menu_id=$4 AND business_id=$5 RETURNING id", [Number(variant.price), JSON.stringify(channelPrices(variant.channelPrices)), Number(variant.id), id, auth.session!.businessId]) : await client.query("UPDATE menu_variants SET price=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND menu_id=$3 AND business_id=$4 RETURNING id", [Number(variant.price), Number(variant.id), id, auth.session!.businessId]); if (!updated.rows.length) throw Object.assign(new Error("A menu variant could not be found"), { status: 400 }); } return menu.rows[0]; });
    if (!result) return Response.json({ error: "Menu item not found" }, { status: 404 }); return Response.json({ success: true, menu: result });
  } catch (error: any) { return Response.json({ error: error?.status ? error.message : "Could not update menu prices" }, { status: error?.status || 500 }); }
}
