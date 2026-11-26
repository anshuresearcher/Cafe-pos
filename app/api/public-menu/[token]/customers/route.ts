export const runtime = "nodejs";

export async function POST() {
  return Response.json(
    { error: "Phone verification is required. Please request and verify a WhatsApp OTP." },
    { status: 410 },
  );
}
