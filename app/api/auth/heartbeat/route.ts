import { sessionResponse } from "@/src/server/auth";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const result = await sessionResponse(request);
    if (result.response) return Response.json({ error: "Session is no longer active" }, { status: 401 });
    return Response.json({ active: true, expiresAt: result.session?.expiresAt });
  } catch {
    return Response.json({ error: "Could not verify session" }, { status: 500 });
  }
}
