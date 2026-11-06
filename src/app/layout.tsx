import type { Metadata } from "next";
import { Inter, Silkscreen } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "./auth/auth-provider";
import { getSupabaseConfigForBrowser } from "./auth/server-config";
import { QuestProvider } from "./quest-store";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const silkscreen = Silkscreen({
  variable: "--font-silkscreen",
  weight: "400",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Plantetary | Your cozy habit garden",
  description:
    "Grow good habits one small quest at a time in your cozy pixel-art garden.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${silkscreen.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        {/* Checked on the server, so a secret key never reaches the browser (see server-config.ts). */}
        <AuthProvider config={getSupabaseConfigForBrowser()}>
          <QuestProvider>{children}</QuestProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
