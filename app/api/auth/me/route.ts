import { sessionResponse } from "@/src/server/auth";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const result = await sessionResponse(request);
    if (result.response) return result.response;
    return Response.json({ user: result.user, device: result.access.device, license: result.access.license, expiresAt: result.session?.expiresAt });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not read session" }, { status: 403 });
  }
}
