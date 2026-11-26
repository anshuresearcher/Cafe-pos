import fs from "node:fs";
import path from "node:path";
import Script from "next/script";

function legacyMarkup() {
  const html = fs.readFileSync(path.join(process.cwd(), "public/index.html"), "utf8");
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? "";
  const inlineScripts = Array.from(html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi))
    .map((match) => match[1])
    .join("\n");
  return { markup: body.replace(/<script[\s\S]*?<\/script>/gi, ""), inlineScripts };
}

export default function Home() {
  const { markup, inlineScripts } = legacyMarkup();
  return (
    <>
      <link rel="stylesheet" href="/style.css" />
      <link rel="stylesheet" href="/login.css" />
      <div dangerouslySetInnerHTML={{ __html: markup }} />
      <Script src="/app.js" strategy="afterInteractive" />
      <Script id="legacy-inline" strategy="afterInteractive">{inlineScripts}</Script>
    </>
  );
}
