import { createAuthClient } from "better-auth/client";
import { organizationClient } from "better-auth/client/plugins";

/** Browser/server auth client (sign-in, sign-up, org + invite mutations). */
export const authClient = createAuthClient({
  plugins: [organizationClient()],
});
