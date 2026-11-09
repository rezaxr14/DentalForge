/**
 * Security headers for every response: ONE definition, used by next.config.ts and by the API fallback in
 * `middleware/security.ts`.
 *
 * `script-src` keeps `'unsafe-inline'` on purpose. The Next.js App Router emits inline bootstrap scripts
 * (`self.__next_f.push(...)`, the theme init, the hydration payload). A policy without a nonce or `'unsafe-inline'`
 * blocks all of them: the browser logs "Refused to execute inline script", React error #412 follows and no page ever
 * hydrates, so every page is static HTML with dead buttons (this shipped once, see ADR-0028 amendment).
 * A nonce-based policy needs a proxy that forces dynamic rendering for every page; that is a separate decision.
 *
 * Everything else stays closed: same-origin only, no framing, no plugins, no foreign form targets, no `<base>` tricks.
 * Add `'wasm-unsafe-eval'` here only when the browser YOLO (ADR-0027) actually needs it.
 */
export const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
] as const;

export const CONTENT_SECURITY_POLICY = CSP_DIRECTIVES.join("; ");

export const SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
];
