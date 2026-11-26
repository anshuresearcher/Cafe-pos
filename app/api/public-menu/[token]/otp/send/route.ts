import crypto from "node:crypto";
import { fast2Sms, guestPhone, qrPublication } from "@/src/server/guest-menu";
import { withSystem } from "@/src/server/db";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{48}$/i.test(token)) return Response.json({ error: "Menu not found" }, { status: 404 });
  try {
    const body = await request.json();
    const phone = guestPhone(body?.phone);
    const tableNumber = String(body?.tableNumber || "").trim();
    if (!tableNumber || tableNumber.length > 60) return Response.json({ error: "Choose a valid table before verifying your number." }, { status: 400 });
    const publication = await qrPublication(token);
    const table = await withSystem((client) => client.query("SELECT 1 FROM restaurant_tables WHERE business_id=$1 AND table_number::text=$2 LIMIT 1", [publication.business_id, tableNumber]));
    if (!table.rows.length) return Response.json({ error: "This QR link does not match an active table." }, { status: 400 });
    const menuHash = crypto.createHash("sha256").update(token).digest("hex");
    const existing = await withSystem((client) => client.query("SELECT resend_after FROM qr_guest_otp_challenges WHERE business_id=$1 AND menu_token_hash=$2 AND table_number=$3 AND phone=$4 AND verified_at IS NULL AND expires_at>CURRENT_TIMESTAMP ORDER BY created_at DESC LIMIT 1", [publication.business_id, menuHash, tableNumber, phone]));
    if (existing.rows[0] && new Date(existing.rows[0].resend_after).getTime() > Date.now()) return Response.json({ error: "Please wait 60 seconds before requesting another OTP." }, { status: 429 });
    const recent = await withSystem((client) => client.query("SELECT COUNT(*)::int AS count FROM qr_guest_otp_challenges WHERE business_id=$1 AND phone=$2 AND created_at>CURRENT_TIMESTAMP-INTERVAL '1 hour'", [publication.business_id, phone]));
    if (Number(recent.rows[0]?.count || 0) >= 5) return Response.json({ error: "Too many OTP requests for this number. Please try again later." }, { status: 429 });
    const provider = await fast2Sms("send", { mobile: phone, otp_id: String(process.env.FAST2SMS_OTP_ID).trim(), otp_expiry: 10, otp_length: 6 });
    const challengeId = crypto.randomUUID();
    await withSystem((client) => client.query("INSERT INTO qr_guest_otp_challenges(id,business_id,menu_token_hash,table_number,phone,provider_request_id,expires_at,resend_after) VALUES($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP+INTERVAL '10 minutes',CURRENT_TIMESTAMP+INTERVAL '60 seconds')", [challengeId, publication.business_id, menuHash, tableNumber, phone, String(provider.request_id || "").slice(0, 200)]));
    return Response.json({ success: true, challengeId, expiresInSeconds: 600, resendInSeconds: 60, message: "OTP sent. Check WhatsApp messages." }, { headers: { "Cache-Control": "no-store" } });
  } catch (error: any) {
    return Response.json({ error: error?.status ? error.message : "Could not send OTP. Please try again." }, { status: error?.status || 500 });
  }
}
