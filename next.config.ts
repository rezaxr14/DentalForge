import type { NextConfig } from "next";
import { SECURITY_HEADERS } from "./src/shared/lib/csp";

const nextConfig: NextConfig = {
  async headers() {
    // One rule: "/:path*" already covers "/api/...". The values live in src/shared/lib/csp.ts.
    return [{ source: "/:path*", headers: SECURITY_HEADERS.map((h) => ({ ...h })) }];
  },
};

export default nextConfig;
