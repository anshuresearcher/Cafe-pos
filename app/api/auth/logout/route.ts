import { logout } from "@/src/server/auth";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    return await logout(request, new Response());
  } catch {
    return Response.json({ error: "Logout failed" }, { status: 500 });
  }
}
