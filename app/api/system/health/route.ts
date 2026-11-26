import { db } from "@/src/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.query("SELECT 1");
    return Response.json({
      ok: true,
      serverTime: new Date().toISOString(),
      node: process.version,
      environment: process.env.NODE_ENV || "development",
    });
  } catch {
    return Response.json({ ok: false, error: "Database health check failed" }, { status: 503 });
  }
}
