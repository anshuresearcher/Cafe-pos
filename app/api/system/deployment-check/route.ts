import { db } from "@/src/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const checks = [
    {
      key: "database",
      label: "PostgreSQL configuration",
      ok: Boolean(process.env.DATABASE_URL || (process.env.DB_USER && process.env.DB_NAME && process.env.DB_HOST)),
    },
  ];

  try {
    await db.query("SELECT 1");
    checks.push({ key: "dbConnection", label: "Database connection", ok: true });
  } catch {
    checks.push({ key: "dbConnection", label: "Database connection", ok: false });
  }

  const [major, minor] = process.versions.node.split(".").map(Number);
  checks.push({
    key: "node",
    label: "Node.js runtime",
    ok: major > 22 || (major === 22 && minor >= 12),
  });

  return Response.json({
    checks,
    env: { NODE_ENV: process.env.NODE_ENV || "development", PORT: process.env.PORT || "3000" },
  });
}
