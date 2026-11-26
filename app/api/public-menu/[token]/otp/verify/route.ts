import crypto from "node:crypto";
import { fast2Sms, guestCookie, guestPhone, normalizeGuestCustomer, qrPublication, upsertGuestCustomer } from "@/src/server/guest-menu";
import { withSystem } from "@/src/server/db";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{48}$/i.test(token)) return Response.json({ error: "Menu not found" }, { status: 404 });
  try {
    const body = await request.json();
    const phone = guestPhone(body?.phone);
    const customerDetails = normalizeGuestCustomer({ ...(body?.customer || {}), phone });
    const tableNumber = String(body?.tableNumber || "").trim();
    const challengeId = String(body?.challengeId || "");
    const otp = String(body?.otp || "").trim();
    if (!/^[0-9]{4,8}$/.test(otp)) return Response.json({ error: "Enter the OTP sent to your WhatsApp." }, { status: 400 });
    const publication = await qrPublication(token);
    const menuHash = crypto.createHash("sha256").update(token).digest("hex");
    const challengeResult = await withSystem((client) => client.query("SELECT id,attempts FROM qr_guest_otp_challenges WHERE id=$1 AND business_id=$2 AND menu_token_hash=$3 AND table_number=$4 AND phone=$5 AND verified_at IS NULL AND expires_at>CURRENT_TIMESTAMP LIMIT 1", [challengeId, publication.business_id, menuHash, tableNumber, phone]));
    const challenge = challengeResult.rows[0];
    if (!challenge) return Response.json({ error: "This OTP has expired. Request a new one." }, { status: 400 });
    if (Number(challenge.attempts) >= 5) return Response.json({ error: "Too many incorrect attempts. Request a new OTP." }, { status: 429 });
    await withSystem((client) => client.query("UPDATE qr_guest_otp_challenges SET attempts=attempts+1 WHERE id=$1", [challengeId]));
    await fast2Sms("verify", { mobile: phone, otp });
    const customer = await upsertGuestCustomer(Number(publication.business_id), customerDetails);
    const sessionToken = crypto.randomBytes(32).toString("hex");
    const sessionHash = crypto.createHash("sha256").update(sessionToken).digest("hex");
    await withSystem(async (client) => {
      await client.query("UPDATE qr_guest_otp_challenges SET verified_at=CURRENT_TIMESTAMP WHERE id=$1", [challengeId]);
      await client.query("DELETE FROM qr_guest_sessions WHERE business_id=$1 AND menu_token_hash=$2 AND table_number=$3 AND phone=$4", [publication.business_id, menuHash, tableNumber, phone]);
      await client.query("INSERT INTO qr_guest_sessions(business_id,menu_token_hash,table_number,phone,customer_id,session_token_hash,expires_at,last_activity_at) VALUES($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP+INTERVAL '2 hours',CURRENT_TIMESTAMP)", [publication.business_id, menuHash, tableNumber, phone, customer.id, sessionHash]);
    });
    return Response.json({ success: true, customer, expiresInSeconds: 7200 }, { headers: { "Cache-Control": "no-store", "Set-Cookie": guestCookie(token, sessionToken) } });
  } catch (error: any) {
    return Response.json({ error: error?.status ? error.message : "Could not verify OTP. Please try again." }, { status: error?.status || 500 });
  }
}
