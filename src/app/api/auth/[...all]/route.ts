import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/shared/auth";

/** Better Auth catch-all: /api/auth/* (sign-in, sessions, orgs, invites). */
export const { GET, POST } = toNextJsHandler(auth.handler);
