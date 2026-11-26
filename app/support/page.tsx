import fs from "node:fs";
import path from "node:path";
import { LegacyHtmlPage } from "@/app/_components/legacy-html-page";

export default function SupportPage() {
  const html = fs.readFileSync(path.join(process.cwd(), "public/support.html"), "utf8");
  return <LegacyHtmlPage html={html} scriptPrefix="support" />;
}
