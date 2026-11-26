import { publicMenu } from "@/src/server/guest-menu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{48}$/i.test(token)) return Response.json({ error: "Menu not found" }, { status: 404 });
  try {
    const data = await publicMenu(token);
    if (!data) return Response.json({ error: "Menu not found" }, { status: 404 });
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Could not load menu" }, { status: 500 });
  }
}
