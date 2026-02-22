import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ALPHA-TECH X",
  description: "ALPHA-TECH X Admin Portal"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
