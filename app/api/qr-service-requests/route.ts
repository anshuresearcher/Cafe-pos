import type { NextRequest } from "next/server";
import { withTenant } from "@/src/server/db";
import { authorizedSession } from "@/src/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function orderingOpen(publication: any) {
  if (publication?.outlet_open === false) return false;
  if (publication?.hours_enabled !== true) return true;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()); const now = Number(parts.find((part) => part.type === "hour")?.value || 0) * 60 + Number(parts.find((part) => part.type === "minute")?.value || 0); const parse = (value: unknown, fallback: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "")) ? String(value) : fallback; const [oh, om] = parse(publication.open_time, "09:00").split(":").map(Number), [ch, cm] = parse(publication.close_time, "22:00").split(":").map(Number); const start = oh * 60 + om, end = ch * 60 + cm; return start === end || (start < end ? now >= start && now < end : now >= start || now < end);
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizedSession(request, "qr_service_requests.view"); if (auth.response) return auth.response; const raw = request.nextUrl.searchParams.get("afterId"); const provided = raw !== null; const afterId = provided ? Number(raw) : null; if (provided && (!Number.isSafeInteger(afterId) || afterId! < 0)) return Response.json({ error: "Invalid service request cursor" }, { status: 400 });
    const result = await withTenant(auth.session!.businessId, async (client) => { const data = await client.query("WITH latest AS (SELECT COALESCE(MAX(id),0)::bigint AS latest_id FROM qr_service_requests WHERE business_id=$1), request_page AS (SELECT id,table_number,request_type,created_at FROM qr_service_requests WHERE business_id=$1 AND $3::boolean=TRUE AND id>$2 ORDER BY id LIMIT 100), publication AS (SELECT outlet_open,hours_enabled,open_time,close_time FROM public_menu_settings WHERE business_id=$1 LIMIT 1) SELECT latest.latest_id,(SELECT row_to_json(publication) FROM publication) AS publication,COALESCE((SELECT json_agg(row_to_json(request_page) ORDER BY request_page.id) FROM request_page),'[]'::json) AS requests FROM latest", [auth.session!.businessId, afterId, provided]); return data.rows[0] || {}; }); const latestId = Number(result.latest_id || 0); return Response.json({ latestId, cursorId: latestId, requests: result.requests || [], orderingOpen: orderingOpen(result.publication || {}) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch { return Response.json({ error: "Could not check table service requests" }, { status: 500 }); }
}
