import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

/** Browser auth client (sign-in, sign-up, org + invite mutations, useSession). */
export const authClient = createAuthClient({
  plugins: [organizationClient()],
});
