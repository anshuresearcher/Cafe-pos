import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorizedSession(request, "menu.view"); if (auth.response) return auth.response; const id = Number((await params).id); if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Invalid menu item ID" }, { status: 400 });
    const result = await withTenant(auth.session!.businessId, (client) => client.query("SELECT mv.* FROM menu_variants mv INNER JOIN menu m ON m.id=mv.menu_id AND m.business_id=$2 WHERE mv.menu_id=$1 AND mv.business_id=$2 ORDER BY mv.id", [id, auth.session!.businessId]));
    return Response.json(result.rows);
  } catch { return Response.json({ error: "Failed to load variants" }, { status: 500 }); }
}
