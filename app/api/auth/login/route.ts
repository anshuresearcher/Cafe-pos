import { login } from "@/src/server/auth";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const response = new Response();
    return await login(request, response);
  } catch {
    return Response.json({ error: "Login failed" }, { status: 500 });
  }
}
