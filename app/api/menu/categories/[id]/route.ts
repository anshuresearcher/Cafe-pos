import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function imageValue(value: unknown, existing?: string | null) { if (value === undefined) return existing || null; if (value === null || value === "") return null; if (value === existing) return String(value); throw Object.assign(new Error("Category images must be uploaded through secure image storage."), { status: 400 }); }

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorizedSession(request, "menu.edit"); if (auth.response) return auth.response; const id = Number((await params).id); if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Invalid category ID" }, { status: 400 }); const body = await request.json(); const name = String(body?.name || "").trim(); const sortOrder = Number(body?.sortOrder || 0); if (!name) return Response.json({ error: "Category name is required" }, { status: 400 });
    const result = await withTenant(auth.session!.businessId, async (client) => { const current = await client.query("SELECT image_url FROM menu_categories WHERE id=$1 AND business_id=$2", [id, auth.session!.businessId]); if (!current.rows[0]) return null; return client.query("UPDATE menu_categories SET name=$1,sort_order=$2,active=$3,image_url=$4,updated_at=CURRENT_TIMESTAMP WHERE id=$5 AND business_id=$6 RETURNING *", [name, Number.isFinite(sortOrder) ? sortOrder : 0, body?.active !== false, imageValue(body?.imageUrl, current.rows[0].image_url), id, auth.session!.businessId]); });
    if (!result) return Response.json({ error: "Menu category not found" }, { status: 404 }); return Response.json(result.rows[0]);
  } catch (error: any) { return Response.json({ error: error?.code === "23505" ? "Menu category already exists" : error?.status ? error.message : "Failed to update menu category" }, { status: error?.code === "23505" ? 409 : error?.status || 500 }); }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authorizedSession(request, "menu.delete"); if (auth.response) return auth.response; const id = Number((await params).id); if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "Invalid category ID" }, { status: 400 }); const result = await withTenant(auth.session!.businessId, (client) => client.query("DELETE FROM menu_categories WHERE id=$1 AND business_id=$2 RETURNING id", [id, auth.session!.businessId])); if (!result.rows.length) return Response.json({ error: "Menu category not found" }, { status: 404 }); return Response.json({ success: true });
  } catch { return Response.json({ error: "Failed to delete menu category" }, { status: 500 }); }
}
