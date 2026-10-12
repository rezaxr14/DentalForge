/**
 * A minimal Redis-5-like server for tests: RESP2 only, and — the point of it — `HELLO` (added in Redis 6) is an
 * unknown command, exactly as on a real Redis 5.0. Implements just enough of the protocol for pub/sub: PING, PUBLISH,
 * SUBSCRIBE, UNSUBSCRIBE, SELECT, QUIT. Anything else is `-ERR unknown command`. Every command received is recorded.
 *
 * It models the handshake behaviour only (it is not a Redis); the real-server suite covers actual semantics.
 */
import { createServer, type Socket } from "node:net";

export interface LegacyRedis {
  port: number;
  url: string;
  /** Every command received, upper-cased name first. */
  commands: string[][];
  close(): Promise<void>;
}

const bulk = (s: string) => `$${Buffer.byteLength(s)}\r\n${s}\r\n`;

export async function startLegacyRedis(): Promise<LegacyRedis> {
  const commands: string[][] = [];
  const sockets = new Set<Socket>();
  const channels = new Map<string, Set<Socket>>();
  const subs = new Map<Socket, Set<string>>();

  const handle = (sock: Socket, args: string[]) => {
    const cmd = (args[0] ?? "").toUpperCase();
    commands.push([cmd, ...args.slice(1)]);
    const mine = subs.get(sock)!;
    switch (cmd) {
      case "PING":
        sock.write(mine.size > 0 ? `*2\r\n${bulk("pong")}${bulk("")}` : "+PONG\r\n");
        break;
      case "SELECT":
        sock.write("+OK\r\n");
        break;
      case "QUIT":
        sock.write("+OK\r\n");
        sock.end();
        break;
      case "SUBSCRIBE":
        for (const ch of args.slice(1)) {
          mine.add(ch);
          if (!channels.has(ch)) channels.set(ch, new Set());
          channels.get(ch)!.add(sock);
          sock.write(`*3\r\n${bulk("subscribe")}${bulk(ch)}:${mine.size}\r\n`);
        }
        break;
      case "UNSUBSCRIBE":
        for (const ch of args.length > 1 ? args.slice(1) : [...mine]) {
          mine.delete(ch);
          channels.get(ch)?.delete(sock);
          sock.write(`*3\r\n${bulk("unsubscribe")}${bulk(ch)}:${mine.size}\r\n`);
        }
        break;
      case "PUBLISH": {
        const [ch = "", msg = ""] = args.slice(1);
        const receivers = channels.get(ch) ?? new Set();
        for (const r of receivers) r.write(`*3\r\n${bulk("message")}${bulk(ch)}${bulk(msg)}`);
        sock.write(`:${receivers.size}\r\n`);
        break;
      }
      default:
        // Redis 5.0 wording; this is what HELLO (and CLIENT SETINFO) get there
        sock.write(`-ERR unknown command \`${args[0] ?? ""}\`, with args beginning with: ${args.slice(1, 4).map((a) => `\`${a}\``).join(", ")}\r\n`);
    }
  };

  const server = createServer((sock) => {
    sockets.add(sock);
    subs.set(sock, new Set());
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        // parse one RESP array of bulk strings
        const text = buf.toString("latin1");
        if (!text.startsWith("*")) return;
        const headEnd = text.indexOf("\r\n");
        if (headEnd < 0) return;
        const n = Number(text.slice(1, headEnd));
        let pos = headEnd + 2;
        const args: string[] = [];
        for (let i = 0; i < n; i++) {
          if (text[pos] !== "$") return;
          const lenEnd = text.indexOf("\r\n", pos);
          if (lenEnd < 0) return;
          const len = Number(text.slice(pos + 1, lenEnd));
          const start = lenEnd + 2;
          if (text.length < start + len + 2) return; // incomplete
          args.push(buf.subarray(start, start + len).toString("utf8"));
          pos = start + len + 2;
        }
        buf = buf.subarray(pos);
        handle(sock, args);
      }
    });
    sock.on("error", () => undefined);
    sock.on("close", () => {
      sockets.delete(sock);
      for (const ch of subs.get(sock) ?? []) channels.get(ch)?.delete(sock);
      subs.delete(sock);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    port,
    url: `redis://127.0.0.1:${port}`,
    commands,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
