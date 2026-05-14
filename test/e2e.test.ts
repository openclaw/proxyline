import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import tls from "node:tls";
import { URL } from "node:url";
import test from "node:test";
import { Dispatcher, fetch } from "undici";
import WebSocket from "ws";
import { createWebSocketServer } from "./support/ws-server.js";
import {
  createAmbientNodeProxyAgent,
  installGlobalProxy,
  openProxyConnectTunnel,
} from "../src/index.js";
import { createNodeProxyAgent } from "../src/node-http.js";
import type { ProxyResolver } from "../src/types.js";
import { startProxyLab } from "./support/proxy-lab.js";

function withProxyEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const keys = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ] as const;
  const previous: Record<string, string | undefined> = {};
  for (const key of keys) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
  try {
    return run();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

async function readHttp(url: string, agent?: http.Agent): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = http.get(url, agent ? { agent } : {}, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
  });
}

async function readHttpOptions(
  options: http.RequestOptions,
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = http.get(options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
  });
}

async function readHttps(
  url: string,
  options: https.RequestOptions = {},
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = https.get(url, { ...options, timeout: options.timeout ?? 2_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error(`HTTPS request timed out for ${url}`));
    });
    req.on("error", reject);
  });
}

async function readHttpsOptions(
  options: https.RequestOptions,
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = https.get({ ...options, timeout: options.timeout ?? 2_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error(`HTTPS request timed out for ${String(options.host ?? options.hostname)}`));
    });
    req.on("error", reject);
  });
}

async function withConnectRecorder<T>(
  run: (proxyUrl: string, authorities: string[]) => Promise<T>,
): Promise<T> {
  const authorities: string[] = [];
  const proxy = http.createServer();
  proxy.on("connect", (req, socket) => {
    authorities.push(req.url ?? "");
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`, authorities);
  } finally {
    await new Promise<void>((resolve, reject) => {
      proxy.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function withStalledConnectProxy<T>(
  run: (proxyUrl: string, activeSockets: Set<Duplex>) => Promise<T>,
): Promise<T> {
  const proxyServer = http.createServer();
  const activeSockets = new Set<Duplex>();
  const allSockets = new Set<Duplex>();
  proxyServer.on("connect", (_req, socket) => {
    activeSockets.add(socket);
    allSockets.add(socket);
    socket.once("end", () => {
      activeSockets.delete(socket);
    });
    socket.once("close", () => {
      activeSockets.delete(socket);
      allSockets.delete(socket);
    });
  });
  proxyServer.listen(0, "127.0.0.1");
  await once(proxyServer, "listening");
  const address = proxyServer.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`, activeSockets);
  } finally {
    for (const socket of allSockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      proxyServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

class FakeProxySocket extends Duplex {
  public override _read(): void {}

  public override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (chunk.toString("latin1").startsWith("CONNECT ")) {
      queueMicrotask(() => {
        this.emit("data", Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n"));
      });
    }
    callback();
  }

  public setNoDelay(): this {
    return this;
  }

  public setKeepAlive(): this {
    return this;
  }

  public setTimeout(): this {
    return this;
  }
}

test("ambient mode routes node:http through HTTP_PROXY", async () => {
  const lab = await startProxyLab();
  const proxy = withProxyEnv({ HTTP_PROXY: lab.proxyUrl }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  try {
    const denied = await readHttp(`${lab.targetUrl}/denied`);

    assert.equal(denied.status, 403);
    assert.match(denied.body, /blocked by proxy lab/);
    assert.ok(
      lab.events.some(
        (event) =>
          (event.type === "deny" && event.url.endsWith("/denied")) ||
          (event.type === "deny_connect" && event.path === "/denied"),
      ),
    );
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("managed mode evaluates node:http proxy policy against the socket destination", async () => {
  const lab = await startProxyLab();
  const targetUrl = new URL(lab.targetUrl);
  const proxy = installGlobalProxy({
    mode: "managed",
    proxyUrl: lab.proxyUrl,
    bypassPolicy: ({ url }) => new URL(url).hostname === "localhost",
  });
  try {
    const denied = await readHttpOptions({
      headers: { host: "localhost" },
      hostname: targetUrl.hostname,
      path: "/denied",
      port: targetUrl.port,
      protocol: "http:",
    });

    assert.equal(denied.status, 403);
    assert.match(denied.body, /blocked by proxy lab/);
    assert.ok(lab.events.some((event) => event.type === "deny" && event.url.endsWith("/denied")));
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("managed mode preserves origin-form paths that start with double slash", async () => {
  const lab = await startProxyLab();
  const targetUrl = new URL(lab.targetUrl);
  const proxy = installGlobalProxy({ mode: "managed", proxyUrl: lab.proxyUrl });
  try {
    const response = await readHttpOptions({
      hostname: targetUrl.hostname,
      path: "//double",
      port: targetUrl.port,
      protocol: "http:",
    });

    assert.equal(response.status, 200);
    assert.ok(
      lab.events.some(
        (event) => event.type === "request" && event.url === `${lab.targetUrl}//double`,
      ),
    );
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("ambient mode preserves absolute-form HTTPS request paths on node:http", async () => {
  const lab = await startProxyLab();
  const proxy = withProxyEnv({ HTTPS_PROXY: lab.proxyUrl }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  try {
    const response = await readHttpOptions({
      protocol: "http:",
      hostname: "api.example.test",
      path: "https://api.example.test/graphql",
    });

    assert.equal(response.status, 418);
    assert.equal(response.body, "observed absolute https proxy request\n");
    assert.ok(
      lab.events.some(
        (event) => event.type === "request" && event.url === "https://api.example.test/graphql",
      ),
    );
    assert.ok(
      !lab.events.some(
        (event) => event.type === "request" && event.url.includes("http://api.example.testhttps://"),
      ),
    );
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("ambient mode routes node:https through HTTPS_PROXY", async () => {
  const lab = await startProxyLab({ secureTarget: true });
  assert.ok(lab.targetCa);
  const proxy = withProxyEnv({ HTTPS_PROXY: lab.proxyUrl }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  try {
    const allowed = await readHttps(`${lab.targetUrl}/allowed`, {
      ca: lab.targetCa,
    });

    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, "allowed via target\n");
    assert.ok(lab.events.some((event) => event.type === "connect"));
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("managed mode uses port 443 for default-port node:https CONNECT targets", async () => {
  await withConnectRecorder(async (proxyUrl, authorities) => {
    const proxy = installGlobalProxy({ mode: "managed", proxyUrl });
    try {
      await assert.rejects(readHttps("https://example.test/allowed", { timeout: 1_000 }));
      assert.deepEqual(authorities, ["example.test:443"]);
    } finally {
      proxy.stop();
    }
  });
});

test("node helper agents route object-form HTTPS requests as secure endpoints", async () => {
  await withConnectRecorder(async (proxyUrl, authorities) => {
    const resolver: ProxyResolver = {
      active: true,
      describeProxy: () => proxyUrl,
      explain: () => {
        throw new Error("not used");
      },
      getProxyForUrl: () => proxyUrl,
    };
    const agent = createNodeProxyAgent(resolver, undefined);
    try {
      await assert.rejects(
        readHttpsOptions({
          agent,
          hostname: "example.test",
          path: "/allowed",
          timeout: 1_000,
        }),
      );
      assert.deepEqual(authorities, ["example.test:443"]);
    } finally {
      agent.destroy();
    }
  });
});

test("node helper agents infer default HTTPS ports with stack traces disabled", async () => {
  await withConnectRecorder(async (proxyUrl, authorities) => {
    const resolver: ProxyResolver = {
      active: true,
      describeProxy: () => proxyUrl,
      explain: () => {
        throw new Error("not used");
      },
      getProxyForUrl: () => proxyUrl,
    };
    const agent = createNodeProxyAgent(resolver, undefined);
    const originalStackTraceLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    try {
      await assert.rejects(readHttps("https://example.test/allowed", { agent, timeout: 1_000 }));
      assert.deepEqual(authorities, ["example.test:443"]);
    } finally {
      Error.stackTraceLimit = originalStackTraceLimit;
      agent.destroy();
    }
  });
});

test("node helper agents infer default HTTPS ports with non-number stack trace limits", async () => {
  await withConnectRecorder(async (proxyUrl, authorities) => {
    const resolver: ProxyResolver = {
      active: true,
      describeProxy: () => proxyUrl,
      explain: () => {
        throw new Error("not used");
      },
      getProxyForUrl: () => proxyUrl,
    };
    const agent = createNodeProxyAgent(resolver, undefined);
    const errorConstructor = Error as unknown as { stackTraceLimit: unknown };
    const originalStackTraceLimit = errorConstructor.stackTraceLimit;
    errorConstructor.stackTraceLimit = undefined;
    try {
      await assert.rejects(readHttps("https://example.test/allowed", { agent, timeout: 1_000 }));
      assert.deepEqual(authorities, ["example.test:443"]);
    } finally {
      errorConstructor.stackTraceLimit = originalStackTraceLimit;
      agent.destroy();
    }
  });
});

test("node helper agents infer default HTTPS ports with custom stack formatters", async () => {
  await withConnectRecorder(async (proxyUrl, authorities) => {
    const resolver: ProxyResolver = {
      active: true,
      describeProxy: () => proxyUrl,
      explain: () => {
        throw new Error("not used");
      },
      getProxyForUrl: () => proxyUrl,
    };
    const agent = createNodeProxyAgent(resolver, undefined);
    const originalPrepareStackTrace = Error.prepareStackTrace;
    Error.prepareStackTrace = () => [];
    try {
      await assert.rejects(readHttps("https://example.test/allowed", { agent, timeout: 1_000 }));
      assert.deepEqual(authorities, ["example.test:443"]);
    } finally {
      Error.prepareStackTrace = originalPrepareStackTrace;
      agent.destroy();
    }
  });
});

test("managed mode times out stalled node:https CONNECT handshakes", async () => {
  await withStalledConnectProxy(async (proxyUrl, activeSockets) => {
    const proxy = installGlobalProxy({
      mode: "managed",
      proxyUrl,
    });
    try {
      await assert.rejects(readHttps("https://example.test/allowed", { timeout: 50 }), /timed out/);
      for (let attempt = 0; attempt < 20 && activeSockets.size > 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(activeSockets.size, 0);
    } finally {
      proxy.stop();
    }
  });
});

test("managed mode honors req.setTimeout during stalled node:https CONNECT handshakes", async () => {
  await withStalledConnectProxy(async (proxyUrl, activeSockets) => {
    const proxy = installGlobalProxy({
      mode: "managed",
      proxyUrl,
    });
    try {
      await assert.rejects(
        new Promise<void>((resolve, reject) => {
          const req = https.get("https://example.test/allowed", () => {
            resolve();
          });
          req.setTimeout(50, () => {
            req.destroy(new Error("late request timeout"));
          });
          req.on("error", reject);
        }),
        /timeout|timed out/,
      );
      for (let attempt = 0; attempt < 20 && activeSockets.size > 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(activeSockets.size, 0);
    } finally {
      proxy.stop();
    }
  });
});

test("node CONNECT agent detaches its parser before destination TLS", async () => {
  const netMutable = net as unknown as { connect: (...args: unknown[]) => net.Socket };
  const tlsMutable = tls as unknown as { connect: (...args: unknown[]) => tls.TLSSocket };
  const originalNetConnect = netMutable.connect;
  const originalTlsConnect = tlsMutable.connect;
  let proxySocket: FakeProxySocket | undefined;
  let tlsConnects = 0;
  const resolver: ProxyResolver = {
    active: true,
    describeProxy: () => "http://proxy.example:8080/",
    explain: () => {
      throw new Error("not used");
    },
    getProxyForUrl: () => "http://proxy.example:8080/",
  };
  const agent = createNodeProxyAgent(resolver, undefined, "https");
  try {
    netMutable.connect = () => {
      proxySocket = new FakeProxySocket();
      queueMicrotask(() => proxySocket?.emit("connect"));
      return proxySocket as unknown as net.Socket;
    };
    tlsMutable.connect = (...args: unknown[]) => {
      tlsConnects += 1;
      const callback = args.find((arg): arg is () => void => typeof arg === "function");
      const socket = new FakeProxySocket() as unknown as tls.TLSSocket;
      queueMicrotask(() => {
        socket.emit("secureConnect");
        callback?.();
      });
      return socket;
    };

    await new Promise<void>((resolve, reject) => {
      const req = https.get("https://example.test/", { agent, timeout: 1_000 }, () => {});
      req.on("error", reject);
      req.on("socket", () => {
        proxySocket?.emit("data", Buffer.from("encrypted target bytes"));
        setImmediate(() => {
          try {
            assert.equal(tlsConnects, 1);
            req.destroy();
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
    });
  } finally {
    netMutable.connect = originalNetConnect;
    tlsMutable.connect = originalTlsConnect;
    agent.destroy();
  }
});

test("ambient Node proxy helper trusts HTTPS proxy endpoints with scoped proxy TLS", async () => {
  const lab = await startProxyLab({ secureProxy: true, secureTarget: true });
  const proxyCa = lab.proxyCa;
  const targetCa = lab.targetCa;
  assert.ok(proxyCa);
  assert.ok(targetCa);
  const agent = withProxyEnv({ HTTPS_PROXY: lab.proxyUrl }, () =>
    createAmbientNodeProxyAgent({
      protocol: "https",
      proxyTls: { ca: proxyCa },
    }),
  );
  try {
    assert.ok(agent);
    const allowed = await readHttps(`${lab.targetUrl}/allowed`, {
      agent,
      ca: targetCa,
    });

    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, "allowed via target\n");
    assert.ok(lab.events.some((event) => event.type === "connect"));
  } finally {
    agent?.destroy();
    await lab.close();
  }
});

test("ambient Node proxy helper routes HTTP callers even when probing HTTPS by default", async () => {
  const lab = await startProxyLab();
  const agent = withProxyEnv(
    {
      HTTP_PROXY: lab.proxyUrl,
      HTTPS_PROXY: "http://127.0.0.1:9",
    },
    () => createAmbientNodeProxyAgent(),
  );
  try {
    assert.ok(agent);
    const denied = await readHttp(`${lab.targetUrl}/denied`, agent);

    assert.equal(denied.status, 403);
    assert.match(denied.body, /blocked by proxy lab/);
    assert.ok(lab.events.some((event) => event.type === "deny"));
  } finally {
    agent?.destroy();
    await lab.close();
  }
});

test("ambient mode defaults bare HTTPS_PROXY endpoints to HTTP proxy URLs", async () => {
  const lab = await startProxyLab({ secureTarget: true });
  assert.ok(lab.targetCa);
  const bareProxyEndpoint = new URL(lab.proxyUrl).host;
  const proxy = withProxyEnv({ HTTPS_PROXY: bareProxyEndpoint }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  try {
    const allowed = await readHttps(`${lab.targetUrl}/allowed`, {
      ca: lab.targetCa,
    });
    const decision = proxy.explain(`${lab.targetUrl}/allowed`, { surface: "node-https" });

    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, "allowed via target\n");
    assert.equal(decision.kind, "proxied");
    assert.equal(decision.proxyUrl, lab.proxyUrl + "/");
    assert.ok(lab.events.some((event) => event.type === "connect"));
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("ambient mode parses host-header ports for node:https CONNECT targets", async () => {
  const lab = await startProxyLab({ secureTarget: true });
  assert.ok(lab.targetCa);
  const target = new URL(lab.targetUrl);
  const proxy = withProxyEnv({ HTTPS_PROXY: lab.proxyUrl }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  try {
    const allowed = await readHttpsOptions({
      protocol: "https:",
      host: target.host,
      path: "/allowed",
      ca: lab.targetCa,
    });

    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, "allowed via target\n");
    assert.ok(lab.events.some((event) => event.type === "connect" && event.authority === target.host));
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("ambient mode validates HTTPS destination TLS against the target host behind a localhost proxy", async () => {
  const lab = await startProxyLab({
    proxyHost: "127.0.0.1",
    secureTarget: true,
    targetHost: "localhost",
    targetCertificateNames: { dnsNames: ["localhost"], ipAddresses: [] },
  });
  assert.ok(lab.targetCa);
  const proxy = withProxyEnv({ HTTPS_PROXY: lab.proxyUrl }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  try {
    const allowed = await readHttps(`${lab.targetUrl}/allowed`, {
      ca: lab.targetCa,
    });

    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, "allowed via target\n");
    assert.ok(lab.events.some((event) => event.type === "connect"));
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("ambient mode honors lower-case proxy env variables", async () => {
  const lab = await startProxyLab();
  const proxy = withProxyEnv({ http_proxy: lab.proxyUrl }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  try {
    const denied = await readHttp(`${lab.targetUrl}/denied`);

    assert.equal(denied.status, 403);
    assert.ok(lab.events.some((event) => event.type === "deny"));
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("ambient mode routes undici fetch and helper-created agents through the same env proxy", async () => {
  const lab = await startProxyLab();
  const proxy = withProxyEnv({ HTTP_PROXY: lab.proxyUrl }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  const helperAgent = proxy.createNodeAgent();
  try {
    const fetchResponse = await fetch(`${lab.targetUrl}/denied`);
    const helperResponse = await readHttp(`${lab.targetUrl}/denied`, helperAgent);

    assert.equal(fetchResponse.status, 403);
    assert.match(await fetchResponse.text(), /blocked by proxy lab/);
    assert.equal(helperResponse.status, 403);
    assert.ok(
      lab.events.filter(
        (event) =>
          event.type === "deny" ||
          (event.type === "deny_connect" && event.path === "/denied"),
      ).length >= 2,
    );
  } finally {
    helperAgent.destroy();
    proxy.stop();
    await lab.close();
  }
});

test("ambient mode routes global fetch through the same env proxy", async () => {
  const lab = await startProxyLab();
  const proxy = withProxyEnv({ HTTP_PROXY: lab.proxyUrl }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  try {
    const fetchResponse = await globalThis.fetch(`${lab.targetUrl}/denied`);

    assert.equal(fetchResponse.status, 403);
    assert.match(await fetchResponse.text(), /blocked by proxy lab/);
    assert.ok(
      lab.events.some(
        (event) =>
          event.type === "deny" ||
          (event.type === "deny_connect" && event.path === "/denied"),
      ),
    );
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("ambient mode does not reuse a destroyed helper undici dispatcher", async () => {
  const lab = await startProxyLab();
  const proxy = withProxyEnv({ HTTP_PROXY: lab.proxyUrl }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  const dispatcher = proxy.createUndiciDispatcher();
  try {
    await dispatcher.destroy();

    await assert.rejects(fetch(`${lab.targetUrl}/denied`, { dispatcher }));
    assert.equal(lab.events.length, 0);
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("ambient mode routes undici HTTPS fetch through HTTPS_PROXY", async () => {
  const lab = await startProxyLab();
  const proxy = withProxyEnv({ HTTPS_PROXY: lab.proxyUrl }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  try {
    await assert.rejects(fetch("https://127.0.0.1:65000/denied"));

    assert.ok(
      lab.events.some(
        (event) => event.type === "deny_connect" && event.authority === "127.0.0.1:65000",
      ),
    );
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("ambient mode routes undici HTTPS fetch through ALL_PROXY fallback", async () => {
  const lab = await startProxyLab();
  const proxy = withProxyEnv({ ALL_PROXY: lab.proxyUrl }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  try {
    await assert.rejects(fetch("https://127.0.0.1:65000/denied"));

    assert.ok(
      lab.events.some(
        (event) => event.type === "deny_connect" && event.authority === "127.0.0.1:65000",
      ),
    );
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("ambient mode resolves low-level undici absolute-form paths from origin", async () => {
  const lab = await startProxyLab();
  const proxy = withProxyEnv(
    { HTTP_PROXY: lab.proxyUrl, NO_PROXY: "no-proxy.example" },
    () => installGlobalProxy({ mode: "ambient" }),
  );
  const dispatcher = proxy.createUndiciDispatcher();
  try {
    const result = await new Promise<{ body: string; statusCode: number }>((resolve, reject) => {
      let body = "";
      let responseStatusCode = 0;
      dispatcher.dispatch(
        {
          method: "GET",
          origin: lab.targetUrl,
          path: "http://no-proxy.example/denied",
        },
        {
          onData(chunk: Buffer): boolean {
            body += chunk.toString("utf8");
            return true;
          },
          onComplete() {
            resolve({ body, statusCode: responseStatusCode });
          },
          onConnect() {},
          onError: reject,
          onHeaders(statusCode: number, _headers: Buffer[], resume: () => void): boolean {
            responseStatusCode = statusCode;
            resume();
            return true;
          },
        } satisfies Dispatcher.DispatchHandler,
      );
    });

    assert.equal(result.statusCode, 403);
    assert.match(result.body, /blocked by proxy lab/);
    assert.notEqual(lab.events.length, 0);
  } finally {
    await dispatcher.close();
    proxy.stop();
    await lab.close();
  }
});

test("ambient mode lets undici HTTPS NO_PROXY matches go direct", async () => {
  const lab = await startProxyLab();
  const proxy = withProxyEnv({ HTTPS_PROXY: lab.proxyUrl, NO_PROXY: "127.0.0.1" }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  try {
    await assert.rejects(fetch("https://127.0.0.1:65000/denied"));

    assert.equal(lab.events.length, 0);
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("ambient mode does not use HTTP_PROXY for undici HTTPS fetch", async () => {
  const lab = await startProxyLab();
  const proxy = withProxyEnv({ HTTP_PROXY: lab.proxyUrl }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  try {
    await assert.rejects(fetch("https://127.0.0.1:65000/denied"));

    assert.equal(lab.events.length, 0);
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("ambient mode uses ALL_PROXY and redacts credentials in explain output", async () => {
  const lab = await startProxyLab();
  const proxyUrl = new URL(lab.proxyUrl);
  proxyUrl.username = "user";
  proxyUrl.password = "secret";
  const proxy = withProxyEnv({ ALL_PROXY: proxyUrl.href }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  try {
    const denied = await readHttp(`${lab.targetUrl}/denied`);
    const decision = proxy.explain(`${lab.targetUrl}/denied`, { surface: "node-http" });

    assert.equal(denied.status, 403);
    assert.equal(decision.kind, "proxied");
    assert.equal(decision.reason, "ambient-proxy-active");
    assert.equal(decision.proxyUrl, lab.proxyUrl + "/");
    assert.doesNotMatch(JSON.stringify(decision), /user|secret/);
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("ambient mode falls back to ALL_PROXY when HTTP_PROXY scheme is unsupported", async () => {
  const lab = await startProxyLab();
  const proxy = withProxyEnv(
    { HTTP_PROXY: "socks-not-supported://specific.example:1080", ALL_PROXY: lab.proxyUrl },
    () => installGlobalProxy({ mode: "ambient" }),
  );
  try {
    const nodeResponse = await readHttp(`${lab.targetUrl}/denied`);
    const fetchResponse = await fetch(`${lab.targetUrl}/denied`);

    assert.equal(nodeResponse.status, 403);
    assert.equal(fetchResponse.status, 403);
    assert.ok(
      lab.events.filter(
        (event) =>
          event.type === "deny" ||
          (event.type === "deny_connect" && event.path === "/denied"),
      ).length >= 2,
    );
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("ambient mode forwards standard proxy authorization from env proxy URL credentials", async () => {
  const requiredProxyAuthorization = `Basic ${Buffer.from("user:secret").toString("base64")}`;
  const lab = await startProxyLab({ requiredProxyAuthorization });
  const proxyUrl = new URL(lab.proxyUrl);
  proxyUrl.username = "user";
  proxyUrl.password = "secret";
  const proxy = withProxyEnv({ HTTP_PROXY: proxyUrl.href }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  try {
    const denied = await readHttp(`${lab.targetUrl}/denied`);

    assert.equal(denied.status, 403);
    assert.ok(lab.events.some((event) => event.type === "deny"));
    assert.ok(
      !lab.events.some(
        (event) =>
          event.type === "error" &&
          event.message === "missing or invalid proxy authorization",
      ),
    );
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("ambient mode without proxy env goes direct with a diagnostic reason", async () => {
  const lab = await startProxyLab();
  const proxy = withProxyEnv({}, () => installGlobalProxy({ mode: "ambient" }));
  try {
    const deniedDirect = await readHttp(`${lab.targetUrl}/denied`);
    const decision = proxy.explain(`${lab.targetUrl}/denied`, { surface: "node-http" });

    assert.equal(proxy.active, false);
    assert.equal(deniedDirect.status, 200);
    assert.equal(deniedDirect.body, "target denied endpoint reached unexpectedly\n");
    assert.equal(decision.kind, "direct");
    assert.equal(decision.reason, "ambient-proxy-not-configured");
    assert.equal(lab.events.length, 0);
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("ambient mode lets NO_PROXY matches go direct with a diagnostic reason", async () => {
  const lab = await startProxyLab();
  const targetHost = new URL(lab.targetUrl).hostname;
  const proxy = withProxyEnv({ HTTP_PROXY: lab.proxyUrl, NO_PROXY: targetHost }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  try {
    const deniedDirect = await readHttp(`${lab.targetUrl}/denied`);
    const decision = proxy.explain(`${lab.targetUrl}/denied`, { surface: "node-http" });

    assert.equal(deniedDirect.status, 200);
    assert.equal(deniedDirect.body, "target denied endpoint reached unexpectedly\n");
    assert.equal(decision.kind, "direct");
    assert.equal(decision.reason, "no-proxy-match");
    assert.equal(lab.events.length, 0);
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("ambient mode lets bare IPv6 NO_PROXY entries go direct", () => {
  const proxy = withProxyEnv({ HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "::1" }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  try {
    const decision = proxy.explain("http://[::1]:8080/allowed", { surface: "node-http" });

    assert.equal(decision.kind, "direct");
    assert.equal(decision.reason, "no-proxy-match");
  } finally {
    proxy.stop();
  }
});

test("ambient mode lets bare IPv6 NO_PROXY entries go direct for undici fetch", async (t) => {
  const server = http.createServer((_req, res) => {
    res.end("ipv6 direct\n");
  });
  try {
    server.listen(0, "::1");
    await once(server, "listening");
  } catch (error) {
    server.close();
    t.skip(`IPv6 loopback unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const address = server.address() as AddressInfo;
  const proxy = withProxyEnv({ HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "::1" }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  try {
    const response = await fetch(`http://[::1]:${address.port}/`);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ipv6 direct\n");
  } finally {
    proxy.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

test("managed mode routes node:http through the lab proxy and denies blocked paths", async () => {
  const lab = await startProxyLab();
  const proxy = installGlobalProxy({ mode: "managed", proxyUrl: lab.proxyUrl });
  try {
    const allowed = await readHttp(`${lab.targetUrl}/allowed`);
    const denied = await readHttp(`${lab.targetUrl}/denied`);

    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, "allowed via target\n");
    assert.equal(denied.status, 403);
    assert.match(denied.body, /blocked by proxy lab/);
    assert.ok(lab.events.some((event) => event.type === "request" && event.url.endsWith("/allowed")));
    assert.ok(
      lab.events.some(
        (event) =>
          (event.type === "deny" && event.url.endsWith("/denied")) ||
          (event.type === "deny_connect" && event.path === "/denied"),
      ),
    );
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("managed mode overrides a caller-provided direct node:http agent", async () => {
  const lab = await startProxyLab();
  const proxy = installGlobalProxy({ mode: "managed", proxyUrl: lab.proxyUrl });
  const callerAgent = new http.Agent();
  try {
    const denied = await readHttp(`${lab.targetUrl}/denied`, callerAgent);

    assert.equal(denied.status, 403);
    assert.ok(
      lab.events.some(
        (event) =>
          (event.type === "deny" && event.url.endsWith("/denied")) ||
          (event.type === "deny_connect" && event.path === "/denied"),
      ),
    );
  } finally {
    callerAgent.destroy();
    proxy.stop();
    await lab.close();
  }
});

test("stopped handles create direct helper agents", async () => {
  const lab = await startProxyLab();
  const proxy = installGlobalProxy({ mode: "managed", proxyUrl: lab.proxyUrl });
  proxy.stop();
  const helperAgent = proxy.createNodeAgent();
  try {
    const deniedDirect = await readHttp(`${lab.targetUrl}/denied`, helperAgent);

    assert.equal(deniedDirect.status, 200);
    assert.equal(deniedDirect.body, "target denied endpoint reached unexpectedly\n");
    assert.equal(lab.events.length, 0);
  } finally {
    helperAgent.destroy();
    await lab.close();
  }
});

test("stopped handles create direct helper agents for HTTPS", async () => {
  const lab = await startProxyLab({ secureTarget: true });
  assert.ok(lab.targetCa);
  const proxy = installGlobalProxy({ mode: "managed", proxyUrl: lab.proxyUrl });
  proxy.stop();
  const helperAgent = proxy.createNodeAgent();
  try {
    const deniedDirect = await readHttps(`${lab.targetUrl}/denied`, {
      agent: helperAgent,
      ca: lab.targetCa,
    });

    assert.equal(deniedDirect.status, 200);
    assert.equal(deniedDirect.body, "target denied endpoint reached unexpectedly\n");
    assert.equal(lab.events.length, 0);
  } finally {
    helperAgent.destroy();
    await lab.close();
  }
});

test("inactive ambient handles create direct helper agents for HTTPS", async () => {
  const lab = await startProxyLab({ secureTarget: true });
  assert.ok(lab.targetCa);
  const proxy = withProxyEnv({}, () => installGlobalProxy({ mode: "ambient" }));
  const helperAgent = proxy.createNodeAgent();
  try {
    const deniedDirect = await readHttps(`${lab.targetUrl}/denied`, {
      agent: helperAgent,
      ca: lab.targetCa,
    });

    assert.equal(proxy.active, false);
    assert.equal(deniedDirect.status, 200);
    assert.equal(deniedDirect.body, "target denied endpoint reached unexpectedly\n");
    assert.equal(lab.events.length, 0);
  } finally {
    helperAgent.destroy();
    proxy.stop();
    await lab.close();
  }
});

test("stopped handles create direct undici helper dispatchers", async () => {
  const lab = await startProxyLab();
  const proxy = installGlobalProxy({ mode: "managed", proxyUrl: lab.proxyUrl });
  proxy.stop();
  const dispatcher = proxy.createUndiciDispatcher();
  try {
    const deniedDirect = await fetch(`${lab.targetUrl}/denied`, { dispatcher });

    assert.equal(deniedDirect.status, 200);
    assert.equal(await deniedDirect.text(), "target denied endpoint reached unexpectedly\n");
    assert.equal(lab.events.length, 0);
  } finally {
    await dispatcher.close();
    await lab.close();
  }
});

test("stopped handles create direct websocket helper agents", async () => {
  const lab = await startProxyLab();
  const wsServer = await createWebSocketServer();
  const proxy = installGlobalProxy({ mode: "managed", proxyUrl: lab.proxyUrl });
  proxy.stop();
  const helperAgent = proxy.createWebSocketAgent();
  try {
    const ws = new WebSocket(wsServer.url, { agent: helperAgent });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        ws.send("ping");
      });
      ws.once("message", (data) => {
        assert.equal(data.toString(), "echo:ping");
        resolve();
      });
      ws.once("error", reject);
    });
    ws.close();

    assert.equal(lab.events.length, 0);
  } finally {
    helperAgent.destroy();
    await wsServer.close();
    await lab.close();
  }
});

test("stopped handles create direct secure websocket helper agents", async () => {
  const lab = await startProxyLab();
  const wsServer = await createWebSocketServer({ secure: true });
  assert.ok(wsServer.ca);
  const proxy = installGlobalProxy({ mode: "managed", proxyUrl: lab.proxyUrl });
  proxy.stop();
  const helperAgent = proxy.createWebSocketAgent();
  try {
    const ws = new WebSocket(wsServer.url, { agent: helperAgent, ca: wsServer.ca });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        ws.send("ping");
      });
      ws.once("message", (data) => {
        assert.equal(data.toString(), "echo:ping");
        resolve();
      });
      ws.once("error", reject);
    });
    ws.close();

    assert.equal(lab.events.length, 0);
  } finally {
    helperAgent.destroy();
    await wsServer.close();
    await lab.close();
  }
});

test("managed mode preserves caller-provided HTTPS agent TLS options while forcing proxy routing", async () => {
  const lab = await startProxyLab({ secureTarget: true });
  assert.ok(lab.targetCa);
  const proxy = installGlobalProxy({ mode: "managed", proxyUrl: lab.proxyUrl });
  const callerAgent = new https.Agent({ ca: lab.targetCa });
  try {
    const allowed = await readHttps(`${lab.targetUrl}/allowed`, { agent: callerAgent });

    assert.equal(allowed.status, 200);
    assert.equal(allowed.body, "allowed via target\n");
    assert.ok(lab.events.some((event) => event.type === "connect"));
  } finally {
    callerAgent.destroy();
    proxy.stop();
    await lab.close();
  }
});

test("managed mode routes undici fetch through the lab proxy", async () => {
  const lab = await startProxyLab();
  const proxy = installGlobalProxy({ mode: "managed", proxyUrl: lab.proxyUrl });
  try {
    const response = await fetch(`${lab.targetUrl}/denied`);

    assert.equal(response.status, 403);
    assert.match(await response.text(), /blocked by proxy lab/);
    assert.ok(
      lab.events.some(
        (event) =>
          (event.type === "deny" && event.url.endsWith("/denied")) ||
          (event.type === "deny_connect" && event.path === "/denied"),
      ),
    );
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("managed mode bypass policy sends matching node and undici traffic direct", async () => {
  const lab = await startProxyLab();
  const targetHost = new URL(lab.targetUrl).host;
  const proxy = installGlobalProxy({
    mode: "managed",
    proxyUrl: lab.proxyUrl,
    bypassPolicy: ({ url }) => new URL(url).host === targetHost,
  });
  try {
    const nodeDenied = await readHttp(`${lab.targetUrl}/denied`);
    const undiciDenied = await fetch(`${lab.targetUrl}/denied`);

    assert.equal(nodeDenied.status, 200);
    assert.equal(nodeDenied.body, "target denied endpoint reached unexpectedly\n");
    assert.equal(undiciDenied.status, 200);
    assert.equal(await undiciDenied.text(), "target denied endpoint reached unexpectedly\n");
    assert.equal(lab.events.length, 0);
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("managed mode trusts an HTTPS proxy endpoint with scoped CA", async () => {
  const lab = await startProxyLab({ secureProxy: true });
  const proxyCa = lab.proxyCa;
  assert.ok(proxyCa);
  const proxy = installGlobalProxy({
    mode: "managed",
    proxyUrl: lab.proxyUrl,
    proxyTls: { ca: proxyCa },
  });
  try {
    const nodeDenied = await readHttp(`${lab.targetUrl}/denied`);
    const undiciDenied = await fetch(`${lab.targetUrl}/denied`);

    assert.equal(nodeDenied.status, 403);
    assert.equal(undiciDenied.status, 403);
    assert.match(await undiciDenied.text(), /blocked by proxy lab/);
    assert.ok(
      lab.events.filter(
        (event) =>
          (event.type === "deny" && event.url.endsWith("/denied")) ||
          (event.type === "deny_connect" && event.path === "/denied"),
      ).length >= 2,
    );
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("managed mode keeps destination TLS options from weakening HTTPS proxy TLS", async () => {
  const lab = await startProxyLab({ secureProxy: true, secureTarget: true });
  const proxy = installGlobalProxy({ mode: "managed", proxyUrl: lab.proxyUrl });
  const callerAgent = new https.Agent({ rejectUnauthorized: false });
  try {
    await assert.rejects(
      readHttps(`${lab.targetUrl}/allowed`, { agent: callerAgent }),
      /self-signed certificate/,
    );

    assert.equal(lab.events.length, 0);
  } finally {
    callerAgent.destroy();
    proxy.stop();
    await lab.close();
  }
});

test("websocket helper routes ws clients through the lab proxy", async () => {
  const lab = await startProxyLab();
  const wsServer = await createWebSocketServer();
  lab.allowLoopbackAuthority(new URL(wsServer.url).host);
  const proxy = installGlobalProxy({ mode: "managed", proxyUrl: lab.proxyUrl });
  try {
    const ws = new WebSocket(wsServer.url, {
      agent: proxy.createWebSocketAgent(),
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        ws.send("ping");
      });
      ws.once("message", (data) => {
        assert.equal(data.toString(), "echo:ping");
        resolve();
      });
      ws.once("error", reject);
    });
    ws.close();

    assert.ok(lab.events.some((event) => event.type === "connect"));
  } finally {
    proxy.stop();
    await wsServer.close();
    await lab.close();
  }
});

test("managed mode routes ws clients through the global node:http patch", async () => {
  const lab = await startProxyLab();
  const wsServer = await createWebSocketServer();
  const deniedUrl = new URL(wsServer.url);
  deniedUrl.pathname = "/denied";
  lab.allowLoopbackAuthority(deniedUrl.host);
  const proxy = installGlobalProxy({ mode: "managed", proxyUrl: lab.proxyUrl });
  try {
    const ws = new WebSocket(deniedUrl.href);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => {
        reject(new Error("websocket opened directly instead of being denied by the proxy"));
      });
      ws.once("error", () => {
        resolve();
      });
    });

    assert.ok(
      lab.events.some(
        (event) =>
          event.type === "deny_connect" && event.authority === deniedUrl.host && event.path === "/denied",
      ),
    );
  } finally {
    proxy.stop();
    await wsServer.close();
    await lab.close();
  }
});

test("CONNECT helper trusts an HTTPS proxy endpoint with scoped CA", async () => {
  const lab = await startProxyLab({ secureProxy: true });
  const proxyCa = lab.proxyCa;
  assert.ok(proxyCa);
  const target = new URL(lab.targetUrl);
  const socket = await openProxyConnectTunnel({
    proxyUrl: lab.proxyUrl,
    proxyTls: { ca: proxyCa },
    targetHost: target.hostname,
    targetPort: Number(target.port),
    timeoutMs: 1_000,
  });
  try {
    const response = await new Promise<string>((resolve, reject) => {
      let body = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        body += chunk;
      });
      socket.once("end", () => {
        resolve(body);
      });
      socket.once("error", reject);
      socket.write(
        `GET /allowed HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`,
      );
    });

    assert.match(response, /^HTTP\/1\.1 200 OK/m);
    assert.match(response, /allowed via target/);
    assert.ok(
      lab.events.some(
        (event) => event.type === "allow_connect" && event.path === "/allowed",
      ),
    );
  } finally {
    socket.destroy();
    await lab.close();
  }
});

test("CONNECT helper opens an explicit tunnel through the lab proxy", async () => {
  const lab = await startProxyLab();
  const target = new URL(lab.targetUrl);
  const socket = await openProxyConnectTunnel({
    proxyUrl: lab.proxyUrl,
    targetHost: target.hostname,
    targetPort: Number(target.port),
    timeoutMs: 1_000,
  });
  try {
    const response = await new Promise<string>((resolve, reject) => {
      let body = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        body += chunk;
      });
      socket.once("end", () => {
        resolve(body);
      });
      socket.once("error", reject);
      socket.write(
        `GET /allowed HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`,
      );
    });

    assert.match(response, /^HTTP\/1\.1 200 OK/m);
    assert.match(response, /allowed via target/);
    assert.ok(
      lab.events.some(
        (event) => event.type === "allow_connect" && event.path === "/allowed",
      ),
    );
  } finally {
    socket.destroy();
    await lab.close();
  }
});
