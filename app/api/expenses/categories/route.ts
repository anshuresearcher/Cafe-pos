import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) { try { const auth = await authorizedSession(request, "expenses.view"); if (auth.response) return auth.response; const result = await withTenant(auth.session!.businessId, (client) => client.query("SELECT * FROM expense_categories WHERE active=TRUE AND business_id=$1 ORDER BY name", [auth.session!.businessId])); return Response.json(result.rows); } catch { return Response.json({ error: "Failed to load expense categories" }, { status: 500 }); } }
export async function POST(request: NextRequest) { try { const auth = await authorizedSession(request, "expenses.create"); if (auth.response) return auth.response; const body = await request.json(), name = String(body?.name || "").trim(); if (!name) return Response.json({ error: "Category name is required" }, { status: 400 }); const result = await withTenant(auth.session!.businessId, (client) => client.query("INSERT INTO expense_categories(name,business_id) VALUES($1,$2) RETURNING *", [name, auth.session!.businessId])); return Response.json(result.rows[0], { status: 201 }); } catch (error: any) { return Response.json({ error: error?.code === "23505" ? "Category already exists" : "Failed to create category" }, { status: error?.code === "23505" ? 409 : 500 }); } }
