import fs from "node:fs";
import path from "node:path";
import Script from "next/script";

export default function Home() {
  const html = fs.readFileSync(
    path.join(process.cwd(), "old_project/public/index.html"),
    "utf8",
  );
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? "";
  const styles = Array.from(html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi))
    .map((match) => match[1])
    .join("\n");
  const inlineScripts = Array.from(
    html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi),
  )
    .map((match) => match[1])
    .join("\n");
  const markup = body.replace(/<script[\s\S]*?<\/script>/gi, "");

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div dangerouslySetInnerHTML={{ __html: markup }} />
      <Script src="/legacy/app.js" strategy="afterInteractive" />
      <Script
        id="legacy-index-inline"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{ __html: inlineScripts }}
      />
    </>
  );
}
