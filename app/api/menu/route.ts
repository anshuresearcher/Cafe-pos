import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizedSession(request, "menu.view"); if (auth.response) return auth.response;
    const data = await withTenant(auth.session!.businessId, async (client) => { const items = await client.query("SELECT m.*,kg.name AS kot_group_name,kg.station AS kot_group_station FROM menu m LEFT JOIN kot_groups kg ON kg.id=m.kot_group_id AND kg.business_id=$1 WHERE m.business_id=$1 ORDER BY m.category,m.name,m.id", [auth.session!.businessId]); const variants = await client.query("SELECT mv.id,mv.menu_id,mv.name,mv.sku,mv.price,mv.unit,mv.channel_prices,mv.option_set_ids,mv.available FROM menu_variants mv INNER JOIN menu m ON m.id=mv.menu_id AND m.business_id=$1 WHERE mv.business_id=$1 ORDER BY mv.menu_id,mv.id", [auth.session!.businessId]); const grouped = new Map<number, any[]>(); for (const variant of variants.rows) { const key = Number(variant.menu_id); if (!grouped.has(key)) grouped.set(key, []); grouped.get(key)!.push(variant); } return items.rows.map((item) => ({ ...item, variants: grouped.get(Number(item.id)) || [] })); });
    return Response.json(data);
  } catch { return Response.json({ error: "Failed to load menu" }, { status: 500 }); }
}
