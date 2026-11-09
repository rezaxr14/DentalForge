import { z } from "zod";

/**
 * zod 4 decides once, lazily, whether it may JIT-compile schemas by calling `Function("")` inside a try/catch.
 * Under our Content-Security-Policy (no `'unsafe-eval'`, deliberately) that probe throws, is caught, and still fires a
 * `securitypolicyviolation` event on every page that parses something: a self-inflicted violation that would drown real
 * ones in any report. In the browser we switch the JIT off, so the probe never runs; the interpreter path is what zod
 * would have fallen back to anyway. The server keeps the JIT (CSP does not apply to Node).
 */
if (typeof window !== "undefined") z.config({ jitless: true });
