"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/** next-themes wrapper — `class` strategy matches the `.dark` CSS tokens. */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}
