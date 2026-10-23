import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installGlobalProxy } from "../src/index.js";
import { createProxyTestCertificate } from "./support/proxy-cert.js";

function request(
  client: typeof http | typeof https,
  options: https.RequestOptions,
  payload?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = client.request(options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("error", reject);
      res.on("end", () => resolve(body));
    });
    req.setTimeout(5_000, () => req.destroy(new Error("Local socket test timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}

for (const mode of ["managed", "ambient"] as const) {
  for (const secure of [false, true]) {
    test(`${mode} mode keeps ${secure ? "HTTPS" : "HTTP"} socketPath on local IPC`,
      { timeout: 20_000 }, async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "pl-"));
        const socketPath = process.platform === "win32"
          ? `\\\\.\\pipe\\proxyline-${randomUUID()}`
          : path.join(directory, "s");
        const certificate = secure ? await createProxyTestCertificate() : undefined;
        const received: string[] = [];
        const handle: http.RequestListener = (req, res) => {
          let body = "";
          req.setEncoding("utf8");
          req.on("data", (chunk: string) => { body += chunk; });
          req.on("end", () => {
            received.push(`${req.method} ${req.url} ${req.headers["x-proxyline-fixture"]} ${body}`);
            res.end("local-ipc");
          });
        };
        const local = certificate
          ? https.createServer({ key: certificate.privateKey, cert: certificate.certificate }, handle)
          : http.createServer(handle);
        const proxied: string[] = [];
        const proxyServer = http.createServer((req, res) => {
          proxied.push(`${req.method} ${req.url}`);
          res.end("network-proxy");
        });
        let runtime: ReturnType<typeof installGlobalProxy> | undefined;
        try {
          local.listen(socketPath);
          await once(local, "listening");
          proxyServer.listen(0, "127.0.0.1");
          await once(proxyServer, "listening");
          const proxyUrl = `http://127.0.0.1:${(proxyServer.address() as AddressInfo).port}`;
          if (mode === "managed") {
            runtime = installGlobalProxy({ mode, proxyUrl });
          } else {
            const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
              "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;
            const previous = names.map((name) => process.env[name]);
            try {
              for (const name of names) delete process.env[name];
              process.env.HTTP_PROXY = proxyUrl;
              process.env.HTTPS_PROXY = proxyUrl;
              runtime = installGlobalProxy({ mode });
            } finally {
              names.forEach((name, index) => {
                if (previous[index] === undefined) delete process.env[name];
                else process.env[name] = previous[index];
              });
            }
          }
          const response = await request(secure ? https : http, {
            socketPath, hostname: "localhost", path: "/local-api", method: "POST",
            headers: { "x-proxyline-fixture": "synthetic-local-marker" },
            ...(certificate ? { ca: certificate.certificate } : {}),
          }, "synthetic-local-payload");
          assert.equal(response, "local-ipc");
          assert.deepEqual(received, ["POST /local-api synthetic-local-marker synthetic-local-payload"]);
          assert.deepEqual(proxied, [], "local IPC reached the network proxy");
          assert.equal(await request(http, {
            hostname: "example.invalid", path: "/network-control", method: "GET",
          }), "network-proxy");
          assert.deepEqual(proxied, ["GET http://example.invalid:80/network-control"]);
        } finally {
          runtime?.stop();
          local.closeAllConnections();
          proxyServer.closeAllConnections();
          await Promise.all([
            new Promise<void>((resolve) => local.close(() => resolve())),
            new Promise<void>((resolve) => proxyServer.close(() => resolve())),
          ]);
          await certificate?.cleanup();
          await rm(directory, { recursive: true, force: true });
        }
      });
  }
}
