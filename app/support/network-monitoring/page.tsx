import fs from "node:fs";
import path from "node:path";
import { LegacyHtmlPage } from "@/app/_components/legacy-html-page";

export default function NetworkMonitoringPage() {
  const html = fs.readFileSync(path.join(process.cwd(), "public/network-monitoring.html"), "utf8");
  return <LegacyHtmlPage html={html} scriptPrefix="network-monitoring" />;
}
