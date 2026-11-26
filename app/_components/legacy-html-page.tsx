import Script from "next/script";

type LegacyHtmlPageProps = { html: string; scriptPrefix: string };

export function LegacyHtmlPage({ html, scriptPrefix }: LegacyHtmlPageProps) {
  const styles = Array.from(html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi))
    .map((match) => match[1])
    .join("\n");
  const scripts = Array.from(html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi));
  const externalScripts = scripts
    .map((match) => match[1].match(/\bsrc=["']([^"']+)["']/i)?.[1])
    .filter((src): src is string => Boolean(src));
  const inlineScripts = scripts
    .filter((match) => !/\bsrc=["']/i.test(match[1]))
    .map((match) => match[2])
    .join("\n");
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const markup = body
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "");

  return (
    <>
      {styles ? <style dangerouslySetInnerHTML={{ __html: styles }} /> : null}
      <div dangerouslySetInnerHTML={{ __html: markup }} />
      {externalScripts.map((src, index) => (
        <Script key={`${scriptPrefix}-${index}`} src={src} strategy="afterInteractive" />
      ))}
      {inlineScripts ? <Script id={`${scriptPrefix}-inline`} strategy="afterInteractive">{inlineScripts}</Script> : null}
    </>
  );
}
