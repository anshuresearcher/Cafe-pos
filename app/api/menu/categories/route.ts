import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function imageValue(value: unknown, existing?: string | null) {
  if (value === undefined) return existing || null;
  if (value === null || value === "") return null;
  if (value === existing) return String(value);
  throw Object.assign(new Error("Category images must be uploaded through secure image storage."), { status: 400 });
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizedSession(request, "menu.view"); if (auth.response) return auth.response;
    const result = await withTenant(auth.session!.businessId, (client) => client.query("SELECT id,name,image_url,sort_order,active,created_at,updated_at FROM menu_categories WHERE business_id=$1 ORDER BY sort_order ASC,name ASC,id ASC", [auth.session!.businessId]));
    return Response.json(result.rows);
  } catch { return Response.json({ error: "Failed to load menu categories" }, { status: 500 }); }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizedSession(request, "menu.create"); if (auth.response) return auth.response;
    const body = await request.json(); const name = String(body?.name || "").trim(); const sortOrder = Number(body?.sortOrder || 0); if (!name) return Response.json({ error: "Category name is required" }, { status: 400 });
    const result = await withTenant(auth.session!.businessId, (client) => client.query("INSERT INTO menu_categories(name,sort_order,active,business_id,image_url) VALUES($1,$2,$3,$4,$5) RETURNING *", [name, Number.isFinite(sortOrder) ? sortOrder : 0, body?.active !== false, auth.session!.businessId, imageValue(body?.imageUrl)]));
    return Response.json(result.rows[0], { status: 201 });
  } catch (error: any) { return Response.json({ error: error?.code === "23505" ? "Menu category already exists" : error?.status ? error.message : "Failed to create menu category" }, { status: error?.code === "23505" ? 409 : error?.status || 500 }); }
}
