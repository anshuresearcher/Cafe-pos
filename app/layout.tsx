import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Slash POS",
  description: "Slash cafe point-of-sale system",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
