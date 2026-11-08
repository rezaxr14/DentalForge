/**
 * Transport security for Postgres is decided from the connection URL alone (src/shared/db/ssl.ts).
 *
 * Regression for the CI failure on 1410f49: pg.ts decided on `process.env.CI === "true"`, but the smoke script starts
 * `next start` with a hand-built environment that has no CI, so a production server pointed at a local Postgres without
 * TLS demanded verified TLS and the app reported "db down" (9 smoke checks failed).
 */
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { getEnv } from "@/shared/config/env";
import { resolveDbTransport } from "@/shared/db/ssl";

const REMOTE = "postgresql://app.ref:s3cret@aws-1-eu.pooler.example.com:6543/postgres";
const LOCAL = "postgresql://traceforge:traceforge@localhost:5433/traceforge";
const prod = { production: true } as const;
const dev = { production: false } as const;
const VERIFIED = { rejectUnauthorized: true };
const UNVERIFIED = { rejectUnauthorized: false };

describe("resolveDbTransport", () => {
  const savedCi = process.env.CI;
  afterEach(() => {
    if (savedCi === undefined) delete process.env.CI;
    else process.env.CI = savedCi;
  });

  it("does not depend on the CI variable (the bug): same answer for unset, 1, true, false", () => {
    const urls = [LOCAL, REMOTE, `${REMOTE}?sslmode=no-verify`, `${LOCAL}?sslmode=disable`];
    for (const url of urls) {
      const answers = [undefined, "", "1", "true", "false"].map((ci) => {
        if (ci === undefined) delete process.env.CI;
        else process.env.CI = ci;
        return JSON.stringify([resolveDbTransport(url, prod), resolveDbTransport(url, dev)]);
      });
      expect(new Set(answers).size, url).toBe(1);
    }
  });

  it("a production server pointed at a loopback or socket database uses no TLS (smoke, docker, local demo)", () => {
    for (const url of [
      LOCAL,
      "postgresql://u:p@127.0.0.1:5432/d",
      "postgresql://u:p@127.9.8.7:5432/d",
      "postgresql://u:p@[::1]:5432/d",
      "postgres://u:p@LOCALHOST/d",
      "postgresql:///d?host=/var/run/postgresql",
      "postgresql://u:p@/d?host=/var/run/postgresql", // credentials + empty host: WHATWG URL throws, the socket parameter still decides
      "postgresql://u:p@db.example.com/d?host=%2Fvar%2Frun%2Fpostgresql",
      "postgresql:///d",
    ]) {
      expect(resolveDbTransport(url, prod).ssl, url).toBe(false);
    }
  });

  it("without sslmode a remote host gets verified TLS in production and none otherwise", () => {
    expect(resolveDbTransport(REMOTE, prod).ssl).toEqual(VERIFIED);
    expect(resolveDbTransport(REMOTE, dev).ssl).toBe(false);
    // a look-alike is not loopback
    expect(resolveDbTransport("postgresql://u:p@localhost.evil.example:5432/d", prod).ssl).toEqual(VERIFIED);
    expect(resolveDbTransport("postgresql://u:p@127.0.0.1.evil.example:5432/d", prod).ssl).toEqual(VERIFIED);
    // an unreadable URL (WHATWG URL rejects credentials with an empty host) is treated as remote: the safe side
    expect(resolveDbTransport("not a url", prod).ssl).toEqual(VERIFIED);
    expect(resolveDbTransport("postgresql://u:p@/d", prod).ssl).toEqual(VERIFIED);
  });

  it("an explicit sslmode wins over everything else, in production and outside it", () => {
    for (const opts of [prod, dev]) {
      expect(resolveDbTransport(`${REMOTE}?sslmode=disable`, opts).ssl).toBe(false);
      expect(resolveDbTransport(`${LOCAL}?sslmode=require`, opts).ssl).toEqual(VERIFIED); // even on loopback
      expect(resolveDbTransport(`${REMOTE}?sslmode=no-verify`, opts).ssl).toEqual(UNVERIFIED);
      for (const mode of ["require", "verify-ca", "verify-full", "REQUIRE"]) {
        expect(resolveDbTransport(`${REMOTE}?sslmode=${mode}`, opts).ssl, mode).toEqual(VERIFIED);
      }
      // the value is case-insensitive and a recognised value never warns
      expect(resolveDbTransport(`${REMOTE}?sslmode=NO-VERIFY`, opts).ssl).toEqual(UNVERIFIED);
      expect(resolveDbTransport(`${REMOTE}?sslmode=DISABLE`, opts).ssl).toBe(false);
      expect(resolveDbTransport(`${REMOTE}?sslmode=REQUIRE`, opts).warning).toBeUndefined();
    }
  });

  it("prefer, allow and unknown values never weaken to unverified TLS, and say so", () => {
    for (const mode of ["prefer", "allow"]) {
      const t = resolveDbTransport(`${REMOTE}?sslmode=${mode}`, prod);
      expect(t.ssl).toEqual(VERIFIED);
      expect(t.warning).toContain(mode);
    }
    const typo = resolveDbTransport(`${REMOTE}?sslmode=requirre`, prod);
    expect(typo.ssl).toEqual(VERIFIED);
    expect(typo.warning).toContain("requirre");
    expect(resolveDbTransport(`${REMOTE}?sslmode=verify-full`, prod).warning).toBeUndefined();
    expect(resolveDbTransport(REMOTE, prod).warning).toBeUndefined();
  });

  it("removes sslmode wherever it is and keeps the rest of the string byte for byte", () => {
    const cred = "postgresql://role.ref:p%40ss%3Aw%2Frd%25@aws-1-eu.pooler.example.com:6543/postgres";
    const cases: Array<[string, string]> = [
      [`${cred}?sslmode=no-verify`, cred],
      [`${cred}?sslmode=no-verify&application_name=tf`, `${cred}?application_name=tf`],
      [`${cred}?application_name=tf&sslmode=no-verify`, `${cred}?application_name=tf`],
      [`${cred}?a=1&sslmode=no-verify&b=2`, `${cred}?a=1&b=2`],
      [`${cred}?SSLMODE=disable&b=2`, `${cred}?b=2`],
      [cred, cred],
      [`${cred}?options=-c%20search_path%3Dpublic`, `${cred}?options=-c%20search_path%3Dpublic`],
    ];
    for (const [input, expected] of cases) {
      expect(resolveDbTransport(input, prod).connectionString, input).toBe(expected);
    }
  });

  it("what pg ends up using is what we decided: the URL we hand over cannot override ssl (pg lets sslmode in the URL win)", () => {
    const urls = [
      LOCAL,
      REMOTE,
      ...["disable", "require", "verify-ca", "verify-full", "no-verify", "prefer", "allow"].map((m) => `${REMOTE}?sslmode=${m}`),
    ];
    for (const url of urls) {
      const t = resolveDbTransport(url, prod);
      const client = new pg.Client({ connectionString: t.connectionString, ssl: t.ssl }); // constructing does not connect
      const effective = (client as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;
      expect(effective, url).toEqual(t.ssl);
    }
  });
});

describe("a production-mode pool reaches the test database (no TLS, no CI flag)", () => {
  it("connects with the resolved transport and runs a query", async () => {
    const savedCi = process.env.CI;
    delete process.env.CI; // exactly what `next start` sees under scripts/smoke-degradation.mjs
    try {
      const { connectionString, ssl } = resolveDbTransport(getEnv().DATABASE_URL, prod);
      expect(ssl).toBe(false);
      const pool = new pg.Pool({ connectionString, ssl, connectionTimeoutMillis: 3000 });
      try {
        const r = await pool.query("select 1 as one");
        expect(r.rows[0]).toEqual({ one: 1 });
      } finally {
        await pool.end();
      }
    } finally {
      if (savedCi !== undefined) process.env.CI = savedCi;
    }
  });
});
