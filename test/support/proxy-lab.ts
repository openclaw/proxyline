import http from "node:http";
import https from "node:https";
import net from "node:net";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import { createProxyTestCertificate } from "./proxy-cert.js";

export type ProxyLabOptions = {
  proxyHost?: "127.0.0.1" | "localhost";
  requiredProxyAuthorization?: string;
  secureProxy?: boolean;
  secureTarget?: boolean;
  targetHost?: "127.0.0.1" | "localhost";
  targetCertificateNames?: {
    dnsNames?: string[];
    ipAddresses?: string[];
  };
};

export type ProxyLabEvent =
  | {
      type: "request";
      method: string | undefined;
      url: string;
    }
  | {
      type: "allow";
      status: number;
      url: string;
    }
  | {
      type: "deny";
      status: number;
      url: string;
    }
  | {
      type: "connect";
      authority: string;
    }
  | {
      type: "allow_connect";
      authority: string;
      path: string;
    }
  | {
      type: "deny_connect";
      status: number;
      authority: string;
      path: string;
    }
  | {
      type: "error";
      message: string;
      url?: string;
      authority?: string;
    };

export type ProxyLab = {
  proxyUrl: string;
  proxyCa?: string;
  targetUrl: string;
  targetCa?: string;
  events: ProxyLabEvent[];
  allowLoopbackAuthority: (authority: string) => void;
  close: () => Promise<void>;
};

const originalHttpRequest = http.request;
const upstreamDirectAgent = new http.Agent();

type LabServer = http.Server | https.Server;

function listen(server: LabServer, host = "127.0.0.1"): Promise<AddressInfo> {
  server.listen(0, host);
  return once(server, "listening").then(() => server.address() as AddressInfo);
}

function closeServer(server: LabServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
    if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
  });
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.+$/, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "[::1]" ||
    normalized === "::1"
  );
}

export async function startProxyLab(options: ProxyLabOptions = {}): Promise<ProxyLab> {
  const events: ProxyLabEvent[] = [];
  const denyPaths = new Set(["/denied"]);
  const allowLoopbackAuthorities = new Set<string>();
  const sockets = new Set<net.Socket>();

  const trackSocket = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  };

  const onTargetRequest: http.RequestListener = (req, res) => {
    if (req.url === "/allowed") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("allowed via target\n");
      return;
    }
    if (req.url === "/denied") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("target denied endpoint reached unexpectedly\n");
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/allowed" });
      res.end();
      return;
    }
    if (req.url === "/echo") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(Buffer.concat(chunks));
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("target default\n");
  };
  const targetCertificate = options.secureTarget
    ? await createProxyTestCertificate(options.targetCertificateNames)
    : undefined;
  const target = options.secureTarget
    ? https.createServer(
        {
          cert: targetCertificate?.certificate,
          key: targetCertificate?.privateKey,
        },
        onTargetRequest,
      )
    : http.createServer(onTargetRequest);
  const targetHost = options.targetHost ?? "127.0.0.1";
  const targetAddress = await listen(target, targetHost);
  const targetAuthority = `${targetHost}:${targetAddress.port}`;
  allowLoopbackAuthorities.add(targetAuthority);
  allowLoopbackAuthorities.add(`localhost:${targetAddress.port}`);

  const onProxyRequest: http.RequestListener = (clientReq, clientRes) => {
    if (
      options.requiredProxyAuthorization !== undefined &&
      clientReq.headers["proxy-authorization"] !== options.requiredProxyAuthorization
    ) {
      clientReq.resume();
      clientRes.writeHead(407, { "content-type": "text/plain" });
      clientRes.end("proxy authentication required\n");
      events.push({
        type: "error",
        message: "missing or invalid proxy authorization",
        ...(clientReq.url !== undefined ? { url: clientReq.url } : {}),
      });
      return;
    }

    const rawUrl = clientReq.url ?? "";
    let targetUrl: URL;
    try {
      targetUrl = new URL(rawUrl);
    } catch {
      clientReq.resume();
      clientRes.writeHead(400, { "content-type": "text/plain" });
      clientRes.end("expected absolute-form HTTP proxy request\n");
      events.push({ type: "error", message: "invalid absolute URL", url: rawUrl });
      return;
    }

    events.push({ type: "request", method: clientReq.method, url: targetUrl.toString() });

    if (targetUrl.protocol === "https:" && targetUrl.pathname === "/graphql") {
      clientReq.resume();
      clientRes.writeHead(418, { "content-type": "text/plain" });
      clientRes.end("observed absolute https proxy request\n");
      events.push({ type: "allow", status: 418, url: targetUrl.toString() });
      return;
    }

    if (denyPaths.has(targetUrl.pathname)) {
      clientReq.resume();
      clientRes.writeHead(403, { "content-type": "text/plain" });
      clientRes.end("blocked by proxy lab\n");
      events.push({ type: "deny", status: 403, url: targetUrl.toString() });
      return;
    }

    if (isLoopbackHost(targetUrl.hostname) && !allowLoopbackAuthorities.has(targetUrl.host)) {
      clientReq.resume();
      clientRes.writeHead(403, { "content-type": "text/plain" });
      clientRes.end("loopback blocked by proxy lab\n");
      events.push({ type: "deny", status: 403, url: targetUrl.toString() });
      return;
    }

    const upstreamReq = originalHttpRequest(
      targetUrl,
      {
        method: clientReq.method,
        agent: upstreamDirectAgent,
        headers: {
          ...clientReq.headers,
          host: targetUrl.host,
        },
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
        upstreamRes.on("end", () => {
          events.push({
            type: "allow",
            status: upstreamRes.statusCode ?? 0,
            url: targetUrl.toString(),
          });
        });
      },
    );

    upstreamReq.on("error", (err) => {
      clientRes.writeHead(502, { "content-type": "text/plain" });
      clientRes.end(`${err.message}\n`);
      events.push({ type: "error", message: err.message, url: targetUrl.toString() });
    });

    clientReq.pipe(upstreamReq);
  };

  const onProxyConnect = (clientReq: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void => {
    trackSocket(clientSocket);
    const authority = clientReq.url ?? "";
    const [targetHost, targetPortText = "80"] = authority.split(":");
    const targetPort = Number(targetPortText);
    events.push({ type: "connect", authority });

    if (
      options.requiredProxyAuthorization !== undefined &&
      clientReq.headers["proxy-authorization"] !== options.requiredProxyAuthorization
    ) {
      clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      events.push({ type: "error", message: "missing or invalid proxy authorization", authority });
      return;
    }

    if (!targetHost || !Number.isInteger(targetPort) || targetPort <= 0) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      events.push({ type: "error", message: "invalid CONNECT authority", authority });
      return;
    }

    if (isLoopbackHost(targetHost) && !allowLoopbackAuthorities.has(authority)) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      events.push({ type: "deny_connect", status: 403, authority, path: "<authority>" });
      return;
    }

    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    let decided = false;
    let upstreamReady = false;
    let upstreamSocket: net.Socket | undefined;
    const pendingChunks: Buffer[] = head.length > 0 ? [Buffer.from(head)] : [];

    const relayToUpstream = (path: string): void => {
      decided = true;
      const nextUpstreamSocket = net.connect(targetPort, targetHost, () => {
        trackSocket(nextUpstreamSocket);
        upstreamReady = true;
        events.push({ type: "allow_connect", authority, path });
        for (const pending of pendingChunks) {
          nextUpstreamSocket.write(pending);
        }
        pendingChunks.length = 0;
        clientSocket.off("data", decideFromChunk);
        clientSocket.pipe(nextUpstreamSocket);
        nextUpstreamSocket.pipe(clientSocket);
      });

      upstreamSocket = nextUpstreamSocket;
      nextUpstreamSocket.on("error", (err) => {
        events.push({ type: "error", authority, message: err.message });
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      });
    };

    const decideFromChunk = (chunk: Buffer): void => {
      if (decided) {
        if (!upstreamReady) {
          pendingChunks.push(Buffer.from(chunk));
        }
        return;
      }

      if (chunk.length > 0) {
        pendingChunks.push(Buffer.from(chunk));
      }

      const firstByte = pendingChunks[0]?.[0];
      const startsLikeHttp =
        firstByte !== undefined && firstByte >= 0x41 && firstByte <= 0x5a;
      if (!startsLikeHttp) {
        relayToUpstream("<tls-or-binary>");
        return;
      }

      const preview = Buffer.concat(pendingChunks).toString("utf8");
      const lineEnd = preview.indexOf("\r\n");
      if (lineEnd === -1) {
        return;
      }

      const firstLine = preview.slice(0, lineEnd);
      const [, requestTarget = ""] = firstLine.match(/^[A-Z]+\s+([^\s]+)\s+HTTP\//) ?? [];
      if (!requestTarget) {
        relayToUpstream("<unknown>");
        return;
      }

      const path =
        requestTarget.startsWith("http://") || requestTarget.startsWith("https://")
          ? new URL(requestTarget).pathname
          : requestTarget.split("?", 1)[0] ?? "";

      if (denyPaths.has(path)) {
        decided = true;
        clientSocket.write(
          "HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: 21\r\n\r\nblocked by proxy lab\n",
        );
        clientSocket.end();
        events.push({ type: "deny_connect", status: 403, authority, path });
        return;
      }

      relayToUpstream(path);
    };

    clientSocket.on("data", decideFromChunk);
    if (head.length > 0) {
      queueMicrotask(() => decideFromChunk(Buffer.alloc(0)));
    }
    clientSocket.on("error", () => {
      upstreamSocket?.destroy();
    });
  };

  const proxyCertificate = options.secureProxy ? await createProxyTestCertificate() : undefined;
  const proxy = options.secureProxy
    ? https.createServer(
        {
          cert: proxyCertificate?.certificate,
          key: proxyCertificate?.privateKey,
        },
        onProxyRequest,
      )
    : http.createServer(onProxyRequest);
  proxy.on("connect", onProxyConnect);

  const proxyHost = options.proxyHost ?? (options.secureProxy ? "localhost" : "127.0.0.1");
  const proxyAddress = await listen(proxy, proxyHost);

  return {
    proxyUrl: `${options.secureProxy ? "https" : "http"}://${proxyHost}:${proxyAddress.port}`,
    ...(proxyCertificate !== undefined ? { proxyCa: proxyCertificate.certificate } : {}),
    targetUrl: `${options.secureTarget ? "https" : "http"}://${targetHost}:${targetAddress.port}`,
    ...(targetCertificate !== undefined ? { targetCa: targetCertificate.certificate } : {}),
    events,
    allowLoopbackAuthority: (authority) => {
      allowLoopbackAuthorities.add(authority);
    },
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await Promise.all([closeServer(proxy), closeServer(target)]);
      await proxyCertificate?.cleanup();
      await targetCertificate?.cleanup();
    },
  };
}
