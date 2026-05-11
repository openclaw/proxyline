import net from "node:net";
import tls from "node:tls";
import { ProxylineError, type ProxylineTlsOptions, redactProxyUrl, resolveProxyTlsCa } from "./shared.js";

export type OpenProxyConnectTunnelOptions = Readonly<{
  proxyUrl: string | URL;
  proxyTls?: ProxylineTlsOptions;
  targetHost: string;
  targetPort: number;
  timeoutMs?: number;
}>;

const MAX_CONNECT_RESPONSE_HEADER_BYTES = 16 * 1024;
const INVALID_CONNECT_AUTHORITY_PATTERN = /[\u0000-\u0020\u007f]/;
const INVALID_CONNECT_HOST_DELIMITER_PATTERN = /[/:?#@\\]/;

type ProxySocket = net.Socket | tls.TLSSocket;

function resolveProxyHost(proxy: URL): string {
  return (proxy.hostname || proxy.host).replace(/^\[|\]$/g, "");
}

function resolveProxyPort(proxy: URL): number {
  if (proxy.port) {
    return Number(proxy.port);
  }
  return proxy.protocol === "https:" ? 443 : 80;
}

function resolveProxyAuthorization(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) {
    return undefined;
  }
  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export function formatConnectAuthority(targetHost: string, targetPort: number): string {
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65_535) {
    throw new ProxylineError("INVALID_CONNECT_TARGET", `Invalid CONNECT target port: ${targetPort}`);
  }
  if (!targetHost || INVALID_CONNECT_AUTHORITY_PATTERN.test(targetHost)) {
    throw new ProxylineError("INVALID_CONNECT_TARGET", "CONNECT target host is empty or unsafe.");
  }
  const unbracketedHost =
    targetHost.startsWith("[") && targetHost.endsWith("]")
      ? targetHost.slice(1, -1)
      : targetHost;
  if (net.isIP(unbracketedHost) === 6) {
    return `[${unbracketedHost}]:${targetPort}`;
  }
  if (targetHost.includes("[") || targetHost.includes("]")) {
    throw new ProxylineError("INVALID_CONNECT_TARGET", "CONNECT target host has invalid brackets.");
  }
  if (targetHost.includes(":") || INVALID_CONNECT_HOST_DELIMITER_PATTERN.test(targetHost)) {
    throw new ProxylineError("INVALID_CONNECT_TARGET", "CONNECT target host is not a host name.");
  }
  return `${targetHost}:${targetPort}`;
}

function connectToProxy(proxy: URL, proxyTls: ProxylineTlsOptions | undefined): ProxySocket {
  const host = resolveProxyHost(proxy);
  const connectOptions = {
    host,
    port: resolveProxyPort(proxy),
  };
  if (proxy.protocol === "https:") {
    const ca = resolveProxyTlsCa(proxyTls);
    const servername = net.isIP(host) === 0 ? host : undefined;
    return tls.connect({
      ...connectOptions,
      ALPNProtocols: ["http/1.1"],
      ...(servername !== undefined ? { servername } : {}),
      ...(ca !== undefined ? { ca } : {}),
    });
  }
  if (proxy.protocol === "http:") {
    return net.connect(connectOptions);
  }
  throw new ProxylineError(
    "UNSUPPORTED_PROXY_PROTOCOL",
    `CONNECT tunnels support http:// and https:// proxy endpoints: ${proxy.protocol}`,
  );
}

function writeConnectRequest(socket: net.Socket, proxy: URL, target: string): void {
  const headers = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`, "Proxy-Connection: Keep-Alive"];
  const authorization = resolveProxyAuthorization(proxy);
  if (authorization !== undefined) {
    headers.push(`Proxy-Authorization: ${authorization}`);
  }
  socket.write([...headers, "", ""].join("\r\n"));
}

function failConnect(proxy: URL, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new ProxylineError("CONNECT_FAILED", `Proxy CONNECT failed via ${redactProxyUrl(proxy)}: ${message}`);
}

export async function openProxyConnectTunnel(
  options: OpenProxyConnectTunnelOptions,
): Promise<ProxySocket> {
  const proxy = options.proxyUrl instanceof URL ? new URL(options.proxyUrl.href) : new URL(options.proxyUrl);
  const target = formatConnectAuthority(options.targetHost, options.targetPort);

  return await new Promise<ProxySocket>((resolve, reject) => {
    let settled = false;
    let responseBuffer = Buffer.alloc(0);
    let timeout: NodeJS.Timeout | undefined;
    let socket: ProxySocket | undefined;

    const cleanup = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      socket?.off("data", onData);
      socket?.off("error", onError);
      socket?.off("end", onClosed);
      socket?.off("close", onClosed);
      socket?.off("connect", onConnected);
      socket?.off("secureConnect", onConnected);
    };

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      socket?.destroy();
      reject(failConnect(proxy, error));
    };

    const succeed = (connectedSocket: ProxySocket, tunneledBytes: Buffer | undefined): void => {
      if (settled) {
        connectedSocket.destroy();
        return;
      }
      settled = true;
      cleanup();
      if (tunneledBytes !== undefined && tunneledBytes.length > 0) {
        connectedSocket.unshift(tunneledBytes);
      }
      resolve(connectedSocket);
    };

    const onConnected = (): void => {
      if (socket === undefined) {
        fail(new Error("proxy socket missing after connect"));
        return;
      }
      writeConnectRequest(socket, proxy, target);
    };

    const onData = (chunk: Buffer): void => {
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      const headerEnd = responseBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        if (responseBuffer.length > MAX_CONNECT_RESPONSE_HEADER_BYTES) {
          fail(new Error(`proxy CONNECT response headers exceeded ${MAX_CONNECT_RESPONSE_HEADER_BYTES} bytes`));
        }
        return;
      }

      const bodyOffset = headerEnd + 4;
      if (bodyOffset > MAX_CONNECT_RESPONSE_HEADER_BYTES) {
        fail(new Error(`proxy CONNECT response headers exceeded ${MAX_CONNECT_RESPONSE_HEADER_BYTES} bytes`));
        return;
      }
      const responseHeader = responseBuffer.subarray(0, bodyOffset).toString("latin1");
      const statusLine = responseHeader.split("\r\n", 1)[0] ?? "";
      if (!/^HTTP\/1\.[01] 2\d\d\b/.test(statusLine)) {
        fail(new Error(statusLine || "proxy returned an invalid CONNECT response"));
        return;
      }

      if (socket === undefined) {
        fail(new Error("proxy socket missing after CONNECT response"));
        return;
      }
      const tunneledBytes =
        responseBuffer.length > bodyOffset ? responseBuffer.subarray(bodyOffset) : undefined;
      succeed(socket, tunneledBytes);
    };

    const onError = (error: Error): void => {
      fail(error);
    };

    const onClosed = (): void => {
      fail(new Error("proxy socket closed before CONNECT response"));
    };

    try {
      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timeout = setTimeout(() => {
          fail(new Error(`proxy CONNECT timed out after ${Math.trunc(options.timeoutMs ?? 0)}ms`));
        }, Math.trunc(options.timeoutMs));
      }
      socket = connectToProxy(proxy, options.proxyTls);
      socket.once(proxy.protocol === "https:" ? "secureConnect" : "connect", onConnected);
      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("end", onClosed);
      socket.once("close", onClosed);
    } catch (error) {
      fail(error);
    }
  });
}
