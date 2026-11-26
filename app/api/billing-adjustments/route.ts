import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";
import { salesChannels } from "@/src/server/guest-menu";
import { billingAdjustmentInput, billingAdjustmentSchema } from "@/src/server/billing-adjustments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


export async function GET(request: NextRequest) { try { const auth = await authorizedSession(request, "settings.view"); if (auth.response) return auth.response; const result = await withTenant(auth.session!.businessId, (client) => client.query("SELECT * FROM billing_adjustments WHERE business_id=$1 ORDER BY active DESC,name ASC,id ASC", [auth.session!.businessId])); return Response.json(result.rows); } catch { return Response.json({ error: "Failed to load billing adjustments" }, { status: 500 }); } }
export async function POST(request: NextRequest) { try { const auth = await authorizedSession(request, "settings.edit"); if (auth.response) return auth.response; const body = await request.json(); const result = await withTenant(auth.session!.businessId, async (client) => { const storage = await billingAdjustmentSchema(client), value = billingAdjustmentInput(body, storage.legacy), settings = (await client.query("SELECT settings FROM app_settings WHERE business_id=$1 LIMIT 1", [auth.session!.businessId])).rows[0]?.settings || {}; if (value.applies !== "all" && !salesChannels(settings).some((channel) => channel.key === value.applies)) throw Object.assign(new Error("Choose an active sale channel for this discount or charge."), { status: 400 }); return client.query(`INSERT INTO billing_adjustments(name,${storage.kind},${storage.calculation},value,applies_to,description,active,business_id,application_level) VALUES($1,$2,$3,$4,$5,$6,TRUE,$7,$8) RETURNING *`, [value.name, value.type, value.calculation, value.value, value.applies, value.description, auth.session!.businessId, value.level]); }); return Response.json(result.rows[0], { status: 201 }); } catch (error: any) { return Response.json({ error: error?.code === "23505" ? "Billing adjustment already exists" : error?.status ? error.message : "Failed to create billing adjustment" }, { status: error?.code === "23505" ? 409 : error?.status || 500 }); } }
