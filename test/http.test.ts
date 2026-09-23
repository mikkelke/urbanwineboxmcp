import assert from "node:assert/strict";
import { request, type ClientRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { httpOptionsFromEnv, isLoopbackAddress, serveHttp, type HttpHandle as Server } from "../src/http.js";

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
});
const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const MAX_BODY = 64 * 1024;

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface Pending {
  req: ClientRequest;
  reply: Promise<Reply>;
}

function open(server: Server, method: string, headers: Record<string, string>): Pending {
  const { address, port } = server.server.address() as AddressInfo;
  const req = request({ host: address, port, method, path: "/mcp", headers, agent: false });
  const reply = new Promise<Reply>((resolve, reject) => {
    req.setTimeout(3000, () => req.destroy(new Error(`${method} timed out`)));
    req.on("error", reject);
    req.on("response", (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("response aborted")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
  });
  return { req, reply };
}

async function send(server: Server, method: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  const p = open(server, method, headers);
  p.req.end(body);
  try {
    return await p.reply;
  } finally {
    p.req.destroy();
  }
}

async function start(host: string): Promise<Server | undefined> {
  try {
    return await serveHttp(() => new McpServer({ name: "test", version: "0" }), {
      host,
      port: 0,
      maxBodyBytes: MAX_BODY,
      log: () => {},
    });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EADDRNOTAVAIL" || code === "ENOTFOUND" || code === "EAFNOSUPPORT") return undefined;
    throw e;
  }
}

const stop = (server: Server): Promise<void> => server.close();
const portOf = (server: Server): number => (server.server.address() as AddressInfo).port;
const hostOf = (server: Server, name = "localhost"): string => `${name}:${portOf(server)}`;

describe("isLoopbackAddress", () => {
  it("classifies loopback literals", () => {
    for (const a of ["127.0.0.1", "127.0.0.2", "::1", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]) {
      assert.ok(isLoopbackAddress(a), a);
    }
    for (const a of ["0.0.0.0", "::", "10.0.0.1", "localhost", "::ffff:10.0.0.1", "127.0.0.1.nip.io"]) {
      assert.ok(!isLoopbackAddress(a), a);
    }
  });
});

describe("httpOptionsFromEnv", () => {
  const ORIGINAL = { ...process.env };
  const reset = (): void => {
    for (const key of ["MCP_TRANSPORT", "MCP_HTTP_PORT", "MCP_HTTP_HOST"]) delete process.env[key];
  };
  after(() => {
    reset();
    Object.assign(process.env, ORIGINAL);
  });

  it("returns undefined when MCP_TRANSPORT isn't http (stdio stays the default)", () => {
    reset();
    assert.equal(httpOptionsFromEnv(), undefined);
  });

  it("requires a valid MCP_HTTP_PORT", () => {
    reset();
    process.env.MCP_TRANSPORT = "http";
    assert.throws(() => httpOptionsFromEnv(), /MCP_HTTP_PORT/);
  });

  it("defaults MCP_HTTP_HOST to 127.0.0.1", () => {
    reset();
    process.env.MCP_TRANSPORT = "http";
    process.env.MCP_HTTP_PORT = "8787";
    assert.deepEqual(httpOptionsFromEnv(), { host: "127.0.0.1", port: 8787 });
  });

  it("accepts loopback spellings of MCP_HTTP_HOST", () => {
    reset();
    process.env.MCP_TRANSPORT = "http";
    process.env.MCP_HTTP_PORT = "8787";
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1"]) {
      process.env.MCP_HTTP_HOST = host;
      assert.deepEqual(httpOptionsFromEnv(), { host, port: 8787 });
    }
  });

  it("refuses a non-loopback MCP_HTTP_HOST", () => {
    reset();
    process.env.MCP_TRANSPORT = "http";
    process.env.MCP_HTTP_PORT = "8787";
    for (const host of ["0.0.0.0", "10.0.0.5", "example.com", "::"]) {
      process.env.MCP_HTTP_HOST = host;
      assert.throws(() => httpOptionsFromEnv(), /loopback/i, host);
    }
  });
});

describe("loopback bind", () => {
  let server: Server;
  before(async () => {
    server = (await start("127.0.0.1"))!;
  });
  after(() => stop(server));

  const post = (headers: Record<string, string>, body = INIT) =>
    send(server, "POST", { ...MCP_HEADERS, ...headers }, body);

  it("rejects hostile Host headers", async () => {
    for (const host of [
      hostOf(server, "localhost.evil.com"),
      hostOf(server, "127.0.0.1.nip.io"),
      hostOf(server, "evil.com"),
      "LOCALHOST.EVIL.COM",
      "localhost@evil.com",
      "evil.com@localhost",
    ]) {
      assert.equal((await post({ Host: host })).status, 403, host);
    }
  });

  it("rejects hostile, null or malformed Origin", async () => {
    for (const origin of [
      "null",
      "http://evil.com",
      "http://localhost.evil.com:1234",
      "http://user@localhost",
      "http://localhost/path",
      "file://localhost",
    ]) {
      assert.equal((await post({ Host: hostOf(server), Origin: origin })).status, 403, origin);
    }
  });

  it("initializes for every loopback Host spelling, on any port, with or without Origin", async () => {
    for (const host of [
      hostOf(server),
      "localhost:1",
      "LOCALHOST:1",
      "localhost.",
      "127.0.0.1",
      "127.1.2.3:1",
      "[::1]:1",
      "[0:0:0:0:0:0:0:1]:1",
      "[::ffff:127.0.0.1]:1",
    ]) {
      const r = await post({ Host: host });
      assert.equal(r.status, 200, `${host} ${r.body}`);
    }
    assert.equal((await post({ Host: hostOf(server), Origin: "http://LocalHost:5173" })).status, 200);
  });

  it("accepts a body at the limit and rejects one byte more", async () => {
    const atLimit = " ".repeat(MAX_BODY - INIT.length) + INIT;
    assert.equal((await post({ Host: hostOf(server) }, atLimit)).status, 200);
    assert.equal((await post({ Host: hostOf(server) }, " " + atLimit)).status, 413);
  });

  it("returns 413 while an oversized chunked upload is still streaming", async () => {
    const p = open(server, "POST", { ...MCP_HEADERS, Host: hostOf(server) });
    try {
      p.req.write("x".repeat(MAX_BODY + 1));
      const r = await p.reply;
      assert.equal(r.status, 413);
      assert.ok(!p.req.writableEnded);
    } finally {
      p.req.destroy();
    }
  });

  it("returns 404 for a POST whose session was deleted while its body was in flight", async () => {
    const init = await post({ Host: hostOf(server) });
    const id = init.headers["mcp-session-id"] as string;
    const session = { Host: hostOf(server), "mcp-session-id": id, "mcp-protocol-version": "2025-03-26" };
    const p = open(server, "POST", { ...MCP_HEADERS, ...session });
    try {
      await new Promise<void>((resolve) => p.req.write('{"jsonrpc":"2.0","id":2,', () => resolve()));
      await sleep(100);
      assert.equal((await send(server, "DELETE", session)).status, 200);
      p.req.end('"method":"tools/list"}');
      assert.equal((await p.reply).status, 404);
    } finally {
      p.req.destroy();
    }
  });
});

describe("loopback alias binds keep the guard", () => {
  for (const host of ["localhost", "LOCALHOST", "localhost.", "127.0.0.2", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"]) {
    it(host, async (t) => {
      const server = await start(host);
      if (!server) return t.skip(`cannot bind ${host}`);
      try {
        const r = await send(server, "POST", { ...MCP_HEADERS, Host: hostOf(server, "evil.com") }, INIT);
        assert.equal(r.status, 403);
      } finally {
        await stop(server);
      }
    });
  }
});

describe("non-loopback bind", () => {
  it("does not check Host", async () => {
    const server = (await start("0.0.0.0"))!;
    try {
      assert.equal((await send(server, "POST", { ...MCP_HEADERS, Host: "evil.com" }, INIT)).status, 200);
    } finally {
      await stop(server);
    }
  });
});

describe("lifecycle", () => {
  it("removes signal handlers when listening fails", async () => {
    const baseline = process.listenerCount("SIGTERM");
    const server = (await start("127.0.0.1"))!;
    try {
      await assert.rejects(
        serveHttp(() => new McpServer({ name: "t", version: "0" }), {
          host: "127.0.0.1",
          port: portOf(server),
          log: () => {},
        }),
      );
      assert.equal(process.listenerCount("SIGTERM"), baseline + 1);
    } finally {
      await stop(server);
    }
    assert.equal(process.listenerCount("SIGTERM"), baseline);
  });

  it("close() ends open SSE streams and releases the listener", { timeout: 5000 }, async () => {
    const baseline = process.listenerCount("SIGTERM");
    const server = (await start("127.0.0.1"))!;
    const init = await send(server, "POST", { ...MCP_HEADERS, Host: hostOf(server) }, INIT);
    const session = {
      Host: hostOf(server),
      Accept: "text/event-stream",
      "mcp-session-id": init.headers["mcp-session-id"] as string,
      "mcp-protocol-version": "2025-03-26",
    };
    const sse = open(server, "GET", session);
    sse.req.end();
    const opened = await new Promise<number>((resolve) =>
      sse.req.on("response", (res) => resolve(res.statusCode ?? 0)),
    );
    assert.equal(opened, 200);
    try {
      await server.close();
      await sse.reply;
      assert.equal(process.listenerCount("SIGTERM"), baseline);
    } finally {
      sse.req.destroy();
    }
  });
});
