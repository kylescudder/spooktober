import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { clerkConfiguration } from "../server/auth";
import "../styles.css";

export const metadata: Metadata = {
  title: "Spooktober · Kyle & Rhiann",
  description: "Our shared Halloween film watchlist. Pick a fright, settle in, and tick it off together.",
  icons: { icon: "/favicon.svg" },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const { configured, publishableKey } = clerkConfiguration();
  return <html lang="en"><body className="antialiased">{configured ? <ClerkProvider
    dynamic publishableKey={publishableKey} signInUrl="/sign-in" signUpUrl="/sign-in"
    signInForceRedirectUrl="/" signUpForceRedirectUrl="/" afterSignOutUrl="/sign-in"
    appearance={{ variables: { colorPrimary: "#ed9751", colorBackground: "#20201c", colorForeground: "#f2e9dc", colorMutedForeground: "#aaa596", colorInput: "#171714", colorInputForeground: "#f2e9dc", colorBorder: "#3a382f", borderRadius: "0.625rem" } }}
  >{children}</ClerkProvider> : children}</body></html>;
}
