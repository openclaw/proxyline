import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import { type AddressInfo } from "node:net";
import { URL } from "node:url";
import test from "node:test";
import { fetch } from "undici";
import WebSocket from "ws";
import { createWebSocketServer } from "./support/ws-server.js";
import { installGlobalProxy, openProxyConnectTunnel } from "../src/index.js";
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
