import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  // A template so every page reads as part of one product; the landing page overrides it outright.
  title: { default: "Testloop — AI QA that shows its evidence", template: "%s · Testloop" },
  description: "Point Testloop at a URL. It crawls the application, writes the test cases, runs them in a real browser, and marks the bug on the screenshot.",
  icons: { icon: "/testloop-icon.svg" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
