import fs from "node:fs";
import path from "node:path";
import { notFound } from "next/navigation";
import { LegacyHtmlPage } from "@/app/_components/legacy-html-page";

export default async function RestaurantPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{48}$/i.test(token)) notFound();
  const html = fs.readFileSync(path.join(process.cwd(), "public/restaurant-menu.html"), "utf8");
  return <LegacyHtmlPage html={html} scriptPrefix="restaurant-menu" />;
}
