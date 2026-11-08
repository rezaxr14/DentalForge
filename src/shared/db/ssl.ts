import type { PoolConfig } from "pg";

/**
 * How the app talks to Postgres, decided from the connection URL alone.
 *
 * It must never depend on a CI flag or on where the process runs: the smoke script starts `next start` with a
 * hand-built environment that has no `CI`, and a production process pointed at a loopback database (smoke,
 * docker compose, a local demo) has no TLS to verify.
 *
 * `pg` parses `sslmode` out of the URL itself and, when it finds one, that result REPLACES an explicit `ssl` option
 * (verified on pg 8.23.1). `prefer`, `allow`, `require` and `verify-ca` all become `verify-full` there, and pg 9 changes
 * their meaning. So the decision is made here, `sslmode` is removed from the string handed to pg, and `ssl` is passed
 * explicitly: the behaviour no longer changes with the pg version.
 *
 * | URL                                         | result                                            |
 * |---------------------------------------------|---------------------------------------------------|
 * | `sslmode=disable`                           | no TLS                                            |
 * | `sslmode=no-verify`                         | TLS, certificate NOT verified (explicit opt-out)  |
 * | `sslmode=require/verify-ca/verify-full`     | TLS, certificate verified                         |
 * | `sslmode=prefer/allow`                      | TLS, certificate verified (pg cannot fall back)   |
 * | any other value                             | TLS, certificate verified, plus a warning         |
 * | no `sslmode`, loopback or unix socket host  | no TLS                                            |
 * | no `sslmode`, any other host                | production: TLS verified; otherwise no TLS        |
 */
export interface DbTransport {
  /** The URL to give to pg, without `sslmode` (everything else is kept byte for byte). */
  connectionString: string;
  ssl: PoolConfig["ssl"];
  /** Something the operator should know, logged once by the caller. */
  warning?: string;
}

const VERIFIED = { rejectUnauthorized: true } as const;
const UNVERIFIED = { rejectUnauthorized: false } as const;

export function resolveDbTransport(url: string, opts: { production: boolean }): DbTransport {
  const [base, query = ""] = splitOnce(url, "?");
  const pairs = query === "" ? [] : query.split("&");
  const mode = pairs.map(readSslMode).find((m): m is string => m !== null)?.toLowerCase();
  const kept = pairs.filter((kv) => readSslMode(kv) === null);
  const connectionString = kept.length > 0 ? `${base}?${kept.join("&")}` : base;

  switch (mode) {
    case undefined:
      return { connectionString, ssl: opts.production && !isLocal(url) ? { ...VERIFIED } : false };
    case "disable":
      return { connectionString, ssl: false };
    case "no-verify":
      return { connectionString, ssl: { ...UNVERIFIED } };
    case "require":
    case "verify-ca":
    case "verify-full":
      return { connectionString, ssl: { ...VERIFIED } };
    case "prefer":
    case "allow":
      return {
        connectionString,
        ssl: { ...VERIFIED },
        warning: `sslmode=${mode} is treated as verify-full (pg cannot fall back to plain TCP); use sslmode=no-verify or disable to be explicit`,
      };
    default:
      return {
        connectionString,
        ssl: { ...VERIFIED },
        warning: `unknown sslmode=${mode}; using verified TLS`,
      };
  }
}

function splitOnce(s: string, sep: string): [string, string?] {
  const i = s.indexOf(sep);
  return i < 0 ? [s] : [s.slice(0, i), s.slice(i + sep.length)];
}

function readSslMode(kv: string): string | null {
  const m = /^sslmode=(.*)$/i.exec(kv);
  return m ? (m[1] ?? "") : null;
}

/** Loopback host, an empty host (unix socket) or `?host=/path`: nothing to verify and nobody on the wire. */
function isLocal(url: string): boolean {
  // Checked on the raw string: `postgresql://user:pw@/db?host=/var/run/postgresql` is a valid libpq URL that WHATWG URL rejects.
  if (/[?&]host=(\/|%2f)/i.test(url)) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // unreadable: treat it as remote, the safe side
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "" || host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}
