import assert from "node:assert/strict";
import http from "node:http";
import { URL } from "node:url";
import test from "node:test";
import { fetch } from "undici";
import WebSocket from "ws";
import { createWebSocketServer } from "./support/ws-server.js";
import { installGlobalProxy, openProxyConnectTunnel } from "../src/index.js";
import { startProxyLab } from "./support/proxy-lab.js";

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
