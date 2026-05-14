import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import {
  readProxyEnv,
  resolveAmbientProxyForUrl,
  type ProxyEnvSnapshot,
} from "./env.js";
import { ProxylineError, resolveProxyTlsCa, type ProxylineTlsOptions } from "./shared.js";
import type { ProxyResolver } from "./types.js";

export type NodeHttpRequestOptions = http.RequestOptions & https.RequestOptions & {
  agent?: http.Agent | false;
};

type NodeHttpMethod = typeof http.request;
type NodeAgentFactory = (options: NodeHttpRequestOptions) => http.Agent;
type NodeAgentOptions = http.AgentOptions & https.AgentOptions;
type NodeAgentRequestOptions = http.RequestOptions & https.RequestOptions & {
  secureEndpoint?: boolean;
};
type NodeAddRequestAgent = http.Agent & {
  addRequest(req: http.ClientRequest, options: NodeAgentRequestOptions): void;
};
type NodeAgentWithOptions = http.Agent & {
  options?: NodeAgentOptions;
};
type NodeProxyAgentOptions = NodeAgentOptions & {
  defaultProtocol?: "http" | "https";
  getProxyForUrl: (url: string, request?: http.ClientRequest) => string;
  proxyTls?: ProxylineTlsOptions;
};

const MAX_CONNECT_RESPONSE_HEADER_BYTES = 16 * 1024;
const nodeAgentDefaultPorts = new WeakMap<object, number>();

export const CALLER_AGENT_TLS_OPTION_KEYS = [
  "ca",
  "cert",
  "ciphers",
  "clientCertEngine",
  "crl",
  "dhparam",
  "ecdhCurve",
  "honorCipherOrder",
  "key",
  "maxVersion",
  "minVersion",
  "passphrase",
  "pfx",
  "rejectUnauthorized",
  "secureOptions",
  "secureProtocol",
  "sessionIdContext",
] as const;

export type NodeHttpStackSnapshot = {
  httpRequest: typeof http.request;
  httpGet: typeof http.get;
  httpGlobalAgent: typeof http.globalAgent;
  httpsRequest: typeof https.request;
  httpsGet: typeof https.get;
  httpsGlobalAgent: typeof https.globalAgent;
};

function copyNodeHttpOptions(value: unknown): NodeHttpRequestOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return { ...(value as NodeHttpRequestOptions) };
}

function readAgentOptions(agent: http.Agent | false | undefined): NodeAgentOptions | undefined {
  if (agent === undefined || agent === false) {
    return undefined;
  }
  return (agent as NodeAgentWithOptions).options;
}

function preserveCallerAgentOptions(options: NodeHttpRequestOptions): void {
  const agentOptions = readAgentOptions(options.agent);
  if (agentOptions === undefined) {
    return;
  }
  for (const key of CALLER_AGENT_TLS_OPTION_KEYS) {
    const value = agentOptions[key];
    if (value !== undefined && options[key as keyof NodeHttpRequestOptions] === undefined) {
      options[key as keyof NodeHttpRequestOptions] = value as never;
    }
  }
}

function inferDestinationHostname(
  url: string | URL | undefined,
  options: NodeHttpRequestOptions,
): string | undefined {
  if (url !== undefined) {
    return url instanceof URL ? url.hostname : new URL(url).hostname;
  }
  if (typeof options.hostname === "string") {
    return options.hostname;
  }
  if (typeof options.host === "string") {
    return options.host.replace(/:\d*$/, "");
  }
  return undefined;
}

function preserveDestinationTlsIdentity(
  url: string | URL | undefined,
  options: NodeHttpRequestOptions,
): void {
  if (options.servername !== undefined) {
    return;
  }
  const hostname = inferDestinationHostname(url, options);
  if (!hostname) {
    return;
  }
  if (net.isIP(hostname) === 0) {
    options.servername = hostname;
  }
}

export function bindNodeHttpMethod<TMethod extends NodeHttpMethod>(
  originalMethod: TMethod,
  createAgent: NodeAgentFactory,
): TMethod {
  return ((...args: unknown[]) => {
    let url: string | URL | undefined;
    let options: NodeHttpRequestOptions;
    let callback: unknown;
    const firstArg = args[0];
    if (typeof firstArg === "string" || firstArg instanceof URL) {
      url = firstArg;
      if (typeof args[1] === "function") {
        options = {};
        callback = args[1];
      } else {
        options = copyNodeHttpOptions(args[1]);
        callback = args[2];
      }
    } else {
      options = copyNodeHttpOptions(firstArg);
      callback = args[1];
    }

    preserveCallerAgentOptions(options);
    preserveDestinationTlsIdentity(url, options);
    const agent = createAgent(options);
    options.agent = agent;
    delete options.createConnection;
    if (url !== undefined) {
      const request = originalMethod(url, options, callback as (res: http.IncomingMessage) => void);
      request.once("close", () => {
        agent.destroy();
      });
      return request;
    }
    const request = originalMethod(options, callback as (res: http.IncomingMessage) => void);
    request.once("close", () => {
      agent.destroy();
    });
    return request;
  }) as TMethod;
}

function proxyHost(proxy: URL): string {
  return (proxy.hostname || proxy.host).replace(/^\[|\]$/g, "");
}

function proxyPort(proxy: URL): number {
  if (proxy.port) {
    return Number(proxy.port);
  }
  return proxy.protocol === "https:" ? 443 : 80;
}

function proxyAuthorization(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) {
    return undefined;
  }
  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function proxyConnectOptions(
  proxy: URL,
  proxyTls: ProxylineTlsOptions | undefined,
): net.TcpNetConnectOpts | tls.ConnectionOptions {
  const host = proxyHost(proxy);
  const base = {
    host,
    port: proxyPort(proxy),
  };
  if (proxy.protocol !== "https:") {
    return base;
  }
  const ca = resolveProxyTlsCa(proxyTls);
  return {
    ...base,
    ALPNProtocols: ["http/1.1"],
    ...(net.isIP(host) === 0 ? { servername: host } : {}),
    ...(ca !== undefined ? { ca } : {}),
  };
}

function assertSupportedNodeProxyProtocol(proxy: URL): void {
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
    throw new ProxylineError(
      "UNSUPPORTED_PROXY_PROTOCOL",
      `Node HTTP agents support http:// and https:// proxy endpoints: ${proxy.protocol}`,
    );
  }
}

function requestProtocol(req: http.ClientRequest, options: NodeAgentRequestOptions): string {
  const isWebSocket = isWebSocketRequest(req);
  if (isSecureEndpoint(options)) {
    return isWebSocket ? "wss:" : "https:";
  }
  return isWebSocket ? "ws:" : "http:";
}

function normalizedPort(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

function normalizedPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }
  const integer = Number(value);
  return Number.isInteger(integer) && integer > 0 ? integer : undefined;
}

function requestAuthority(options: NodeAgentRequestOptions): string {
  const rawHost = options.hostname ?? options.host ?? "localhost";
  const parsed = splitHostPort(String(rawHost));
  const host = parsed.host || "localhost";
  const port = parsed.port ?? normalizedPort(options.port);
  const authorityHost = net.isIPv6(host) ? `[${host}]` : host;
  return port === undefined ? authorityHost : `${authorityHost}:${port}`;
}

function requestUrl(req: http.ClientRequest, options: NodeAgentRequestOptions): string {
  if (/^(?:https?|wss?):\/\//i.test(req.path)) {
    return new URL(req.path).href;
  }
  const path = req.path.startsWith("/") ? req.path : `/${req.path}`;
  return `${requestProtocol(req, options)}//${requestAuthority(options)}${path}`;
}

function setProxyRequestHeaders(req: http.ClientRequest, proxy: URL, keepAlive: boolean): void {
  const authorization = proxyAuthorization(proxy);
  if (authorization !== undefined) {
    req.setHeader("Proxy-Authorization", authorization);
  }
  if (!req.hasHeader("Proxy-Connection")) {
    req.setHeader("Proxy-Connection", keepAlive ? "Keep-Alive" : "close");
  }
}

function setForwardProxyRequestPath(
  req: http.ClientRequest & { _header?: string | null },
  options: NodeAgentRequestOptions,
): void {
  req._header = null;
  req.path = requestUrl(req, options);
}

function connectToProxy(
  proxy: URL,
  proxyTls: ProxylineTlsOptions | undefined,
): net.Socket | tls.TLSSocket {
  const options = proxyConnectOptions(proxy, proxyTls);
  return proxy.protocol === "https:"
    ? tls.connect(options as tls.ConnectionOptions)
    : net.connect(options as net.NetConnectOpts);
}

function isWebSocketRequest(req: http.ClientRequest): boolean {
  return String(req.getHeader("upgrade") ?? "").toLowerCase() === "websocket";
}

function isSecureEndpoint(options: NodeAgentRequestOptions): boolean {
  return (
    options.secureEndpoint === true ||
    options.protocol === "https:" ||
    options.protocol === "wss:" ||
    options.defaultPort === 443
  );
}

function shouldTunnelRequest(req: http.ClientRequest, options: NodeAgentRequestOptions): boolean {
  return isSecureEndpoint(options) || isWebSocketRequest(req);
}

function splitHostPort(value: string): { host: string; port?: number } {
  const bracketed = value.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    return {
      host: bracketed[1] ?? "",
      ...(bracketed[2] !== undefined ? { port: Number(bracketed[2]) } : {}),
    };
  }
  const lastColon = value.lastIndexOf(":");
  const hasSingleColon = lastColon !== -1 && value.indexOf(":") === lastColon;
  if (hasSingleColon) {
    const possiblePort = value.slice(lastColon + 1);
    if (/^\d+$/.test(possiblePort)) {
      return { host: value.slice(0, lastColon), port: Number(possiblePort) };
    }
  }
  return { host: value };
}

function connectTarget(options: NodeAgentRequestOptions): { host: string; port: number } {
  const rawHost = options.hostname ?? options.host;
  if (typeof rawHost !== "string") {
    throw new ProxylineError("INVALID_CONNECT_TARGET", "CONNECT target is missing host.");
  }
  const parsed = splitHostPort(rawHost);
  const port = parsed.port ?? Number(options.port);
  if (!parsed.host || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ProxylineError("INVALID_CONNECT_TARGET", "CONNECT target is missing host or port.");
  }
  return { host: parsed.host, port };
}

function destinationTlsConnectOptions(
  options: NodeAgentRequestOptions,
  socket: net.Socket,
): tls.ConnectionOptions {
  const target = connectTarget(options);
  const tlsOptions = { ...options, socket } as tls.ConnectionOptions & Record<string, unknown>;
  tlsOptions.host = target.host;
  delete tlsOptions.path;
  delete tlsOptions.port;
  delete tlsOptions.secureEndpoint;
  delete tlsOptions.agent;
  return tlsOptions;
}

class ProxylineHttpForwardAgent extends http.Agent {
  public readonly options: NodeAgentOptions;
  readonly #keepAlive: boolean;
  readonly #proxy: URL;
  readonly #proxyTls: ProxylineTlsOptions | undefined;

  public constructor(proxy: URL, options: NodeAgentOptions, proxyTls: ProxylineTlsOptions | undefined) {
    super(options);
    this.options = options;
    this.#keepAlive = options.keepAlive === true;
    this.#proxy = proxy;
    this.#proxyTls = proxyTls;
  }

  public addRequest(req: http.ClientRequest, options: NodeAgentRequestOptions): void {
    setForwardProxyRequestPath(req as http.ClientRequest & { _header?: string | null }, options);
    setProxyRequestHeaders(req, this.#proxy, this.#keepAlive);
    (http.Agent.prototype as unknown as NodeAddRequestAgent).addRequest.call(this, req, options);
  }

  public override createConnection(
    _options: NodeAgentRequestOptions,
    callback?: (error: Error | null, socket: net.Socket) => void,
  ): net.Socket {
    const socket = connectToProxy(this.#proxy, this.#proxyTls);
    if (callback !== undefined) {
      const onError = (error: Error): void => {
        callback(error, socket);
      };
      const onConnected = (): void => {
        socket.off("error", onError);
        callback(null, socket);
      };
      socket.once(this.#proxy.protocol === "https:" ? "secureConnect" : "connect", onConnected);
      socket.once("error", onError);
    }
    return socket;
  }
}

class ProxylineConnectAgent extends http.Agent {
  public readonly options: NodeAgentOptions;
  readonly #keepAlive: boolean;
  readonly #pendingRequests = new WeakMap<NodeAgentRequestOptions, http.ClientRequest>();
  readonly #pendingRequestQueue: http.ClientRequest[] = [];
  readonly #proxy: URL;
  readonly #proxyTls: ProxylineTlsOptions | undefined;

  public constructor(proxy: URL, options: NodeAgentOptions, proxyTls: ProxylineTlsOptions | undefined) {
    super(options);
    this.options = options;
    this.#keepAlive = options.keepAlive === true;
    this.#proxy = proxy;
    this.#proxyTls = proxyTls;
  }

  public addRequest(req: http.ClientRequest, options: NodeAgentRequestOptions): void {
    this.#pendingRequests.set(options, req);
    this.#pendingRequestQueue.push(req);
    req.once("socket", () => this.#removePendingRequest(req));
    req.once("close", () => this.#removePendingRequest(req));
    try {
      (http.Agent.prototype as unknown as NodeAddRequestAgent).addRequest.call(this, req, options);
    } catch (error) {
      this.#pendingRequests.delete(options);
      this.#removePendingRequest(req);
      throw error;
    }
  }

  #removePendingRequest(req: http.ClientRequest): void {
    const index = this.#pendingRequestQueue.indexOf(req);
    if (index !== -1) {
      this.#pendingRequestQueue.splice(index, 1);
    }
  }

  public override createConnection(
    options: NodeAgentRequestOptions,
    callback?: (error: Error | null, socket: net.Socket) => void,
  ): net.Socket {
    const proxySocket = connectToProxy(this.#proxy, this.#proxyTls);
    const mappedRequest = this.#pendingRequests.get(options);
    const request = mappedRequest ?? this.#pendingRequestQueue.shift();
    this.#pendingRequests.delete(options);
    if (mappedRequest !== undefined) {
      this.#removePendingRequest(mappedRequest);
    }
    if (callback === undefined) {
      proxySocket.destroy();
      throw new ProxylineError("INVALID_CONNECT_CALLBACK", "CONNECT agents require an async socket callback.");
    }

    let pendingTimeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let responseBuffer = Buffer.alloc(0);

    const cleanup = (): void => {
      if (pendingTimeout !== undefined) {
        clearTimeout(pendingTimeout);
        pendingTimeout = undefined;
      }
      proxySocket.off("data", onData);
      proxySocket.off("error", onError);
      proxySocket.off("end", onClosed);
      proxySocket.off("close", onClosed);
      proxySocket.off("connect", onConnected);
      proxySocket.off("secureConnect", onConnected);
      request?.off("abort", onRequestClosed);
      request?.off("close", onRequestClosed);
      request?.off("error", onRequestClosed);
      request?.off("timeout", onRequestTimedOut);
    };

    const finish = (error: Error | null, socket: net.Socket): void => {
      if (settled) {
        if (error === null) {
          socket.destroy();
        }
        return;
      }
      settled = true;
      cleanup();
      callback(error, socket);
    };

    const fail = (error: Error): void => {
      proxySocket.destroy();
      finish(error, proxySocket);
    };

    const onConnected = (): void => {
      let target: { host: string; port: number };
      try {
        target = connectTarget(options);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const { host, port } = target;
      const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
      const headers = [
        `CONNECT ${authority} HTTP/1.1`,
        `Host: ${authority}`,
        `Proxy-Connection: ${this.#keepAlive ? "Keep-Alive" : "close"}`,
      ];
      const authorization = proxyAuthorization(this.#proxy);
      if (authorization !== undefined) {
        headers.push(`Proxy-Authorization: ${authorization}`);
      }
      proxySocket.write([...headers, "", ""].join("\r\n"));
    };

    const onData = (chunk: Buffer): void => {
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      const headerEnd = responseBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        if (responseBuffer.length > MAX_CONNECT_RESPONSE_HEADER_BYTES) {
          fail(new ProxylineError("CONNECT_FAILED", "proxy CONNECT response headers were too large"));
        }
        return;
      }
      const bodyOffset = headerEnd + 4;
      if (bodyOffset > MAX_CONNECT_RESPONSE_HEADER_BYTES) {
        fail(new ProxylineError("CONNECT_FAILED", "proxy CONNECT response headers were too large"));
        return;
      }
      const statusLine = responseBuffer.subarray(0, bodyOffset).toString("latin1").split("\r\n", 1)[0] ?? "";
      if (!/^HTTP\/1\.[01] 2\d\d\b/.test(statusLine)) {
        fail(new ProxylineError("CONNECT_FAILED", statusLine || "proxy returned an invalid CONNECT response"));
        return;
      }
      const tunneledBytes = responseBuffer.subarray(bodyOffset);
      if (tunneledBytes.length > 0) {
        proxySocket.unshift(tunneledBytes);
      }
      if (!isSecureEndpoint(options)) {
        finish(null, proxySocket);
        return;
      }
      const tlsSocket = tls.connect(destinationTlsConnectOptions(options, proxySocket));
      const onTlsError = (error: Error): void => {
        finish(error, tlsSocket);
      };
      const onTlsSecureConnect = (): void => {
        tlsSocket.off("error", onTlsError);
        finish(null, tlsSocket);
      };
      tlsSocket.once("secureConnect", onTlsSecureConnect);
      tlsSocket.once("error", onTlsError);
    };

    const onError = (error: Error): void => {
      fail(error);
    };

    const onClosed = (): void => {
      fail(new ProxylineError("CONNECT_FAILED", "proxy socket closed before CONNECT completed"));
    };

    const onRequestClosed = (): void => {
      if (!settled) {
        fail(new ProxylineError("CONNECT_FAILED", "request closed before proxy CONNECT completed"));
      }
    };

    const onRequestTimedOut = (): void => {
      if (!settled) {
        fail(new ProxylineError("CONNECT_FAILED", "proxy CONNECT timed out"));
      }
    };

    const requestTimeout = (request as { timeout?: unknown } | undefined)?.timeout;
    const timeoutMs = normalizedPositiveInteger(options.timeout ?? requestTimeout);
    if (timeoutMs !== undefined) {
      pendingTimeout = setTimeout(() => {
        request?.emit("timeout");
        if (!settled) {
          fail(new ProxylineError("CONNECT_FAILED", "proxy CONNECT timed out"));
        }
      }, timeoutMs);
      pendingTimeout.unref?.();
    }
    request?.once("abort", onRequestClosed);
    request?.once("close", onRequestClosed);
    request?.once("error", onRequestClosed);
    request?.once("timeout", onRequestTimedOut);

    proxySocket.once(this.#proxy.protocol === "https:" ? "secureConnect" : "connect", onConnected);
    proxySocket.on("data", onData);
    proxySocket.once("error", onError);
    proxySocket.once("end", onClosed);
    proxySocket.once("close", onClosed);

    return undefined as unknown as net.Socket;
  }
}

export class ProxylineNodeProxyAgent extends http.Agent {
  public readonly options: NodeAgentOptions;
  readonly #agents = new Map<string, NodeAddRequestAgent>();
  readonly #defaultProtocol: "http" | "https";
  readonly #getProxyForUrl: (url: string, request?: http.ClientRequest) => string;
  readonly #httpAgent: NodeAddRequestAgent;
  readonly #httpsAgent: NodeAddRequestAgent;
  readonly #proxyTls: ProxylineTlsOptions | undefined;

  public constructor(options: NodeProxyAgentOptions) {
    const { defaultProtocol = "http", getProxyForUrl, proxyTls, ...agentOptions } = options;
    super(agentOptions);
    if (nodeAgentDefaultPorts.get(this) === 80) {
      nodeAgentDefaultPorts.delete(this);
    }
    this.options = agentOptions;
    this.#defaultProtocol = defaultProtocol;
    this.#getProxyForUrl = getProxyForUrl;
    this.#proxyTls = proxyTls;
    this.#httpAgent = new http.Agent(agentOptions) as NodeAddRequestAgent;
    this.#httpsAgent = new https.Agent(agentOptions) as unknown as NodeAddRequestAgent;
  }

  public get defaultPort(): number {
    const stackProtocol = this.#callStackProtocol();
    return nodeAgentDefaultPorts.get(this) ??
      ((stackProtocol ?? this.#defaultProtocol) === "https" ? 443 : 80);
  }

  public set defaultPort(value: number) {
    nodeAgentDefaultPorts.set(this, value);
  }

  public get protocol(): string {
    return `${this.#callStackProtocol() ?? this.#defaultProtocol}:`;
  }

  public set protocol(_value: string) {
    // Node's http.Agent constructor assigns this, but this wrapper is dual-use.
  }

  public getProxyForUrl(url: string, request?: http.ClientRequest): string {
    return this.#getProxyForUrl(url, request);
  }

  #callStackProtocol(): "http" | "https" | undefined {
    const originalStackTraceLimit = Error.stackTraceLimit;
    if (typeof originalStackTraceLimit === "number" && originalStackTraceLimit < 20) {
      // Node reads agent.protocol/defaultPort before addRequest, so this is the only caller signal.
      Error.stackTraceLimit = 20;
    }
    let stack: string | undefined;
    try {
      stack = new Error().stack;
    } finally {
      Error.stackTraceLimit = originalStackTraceLimit;
    }
    if (typeof stack !== "string") {
      return undefined;
    }
    for (const line of stack.split("\n")) {
      if (line.includes("node:https:")) {
        return "https";
      }
      if (line.includes("node:http:")) {
        return "http";
      }
    }
    return undefined;
  }

  public addRequest(req: http.ClientRequest, options: NodeAgentRequestOptions): void {
    const url = requestUrl(req, options);
    const proxy = this.#getProxyForUrl(url, req);
    if (!proxy) {
      (isSecureEndpoint(options) ? this.#httpsAgent : this.#httpAgent).addRequest(req, options);
      return;
    }
    const proxyUrl = new URL(proxy);
    assertSupportedNodeProxyProtocol(proxyUrl);
    const tunnel = shouldTunnelRequest(req, options);
    const key = `${tunnel ? "connect" : "forward"}:${proxyUrl.href}`;
    let agent = this.#agents.get(key);
    if (agent === undefined) {
      const newAgent = tunnel
        ? new ProxylineConnectAgent(proxyUrl, this.options, this.#proxyTls)
        : new ProxylineHttpForwardAgent(proxyUrl, this.options, this.#proxyTls);
      agent = newAgent;
      this.#agents.set(key, agent);
    }
    agent.addRequest(req, options);
  }

  public override destroy(): void {
    for (const agent of this.#agents.values()) {
      agent.destroy();
    }
    this.#agents.clear();
    this.#httpAgent.destroy();
    this.#httpsAgent.destroy();
    super.destroy();
  }
}

export function createNodeProxyAgent(
  resolver: ProxyResolver,
  proxyCa: string | undefined,
  defaultProtocol: "http" | "https" = "http",
): ProxylineNodeProxyAgent {
  return new ProxylineNodeProxyAgent({
    defaultProtocol,
    getProxyForUrl: resolver.getProxyForUrl,
    ...(proxyCa !== undefined ? { proxyTls: { ca: proxyCa } } : {}),
  });
}

export function createDirectNodeAgent(): ProxylineNodeProxyAgent {
  return new ProxylineNodeProxyAgent({
    getProxyForUrl: () => "",
  });
}

export type AmbientNodeProxyAgentOptions = {
  env?: ProxyEnvSnapshot;
  protocol?: "http" | "https";
  proxyTls?: ProxylineTlsOptions;
};

function ambientProbeUrl(protocol: "http" | "https"): string {
  return `${protocol}://proxyline.invalid/`;
}

export function hasAmbientNodeProxyConfigured(
  options: AmbientNodeProxyAgentOptions = {},
): boolean {
  const env = options.env ?? readProxyEnv();
  const protocol = options.protocol ?? "https";
  return resolveAmbientProxyForUrl(ambientProbeUrl(protocol), env) !== undefined;
}

export function createAmbientNodeProxyAgent(
  options: AmbientNodeProxyAgentOptions = {},
): ProxylineNodeProxyAgent | undefined {
  const env = options.env ?? readProxyEnv();
  const protocol = options.protocol ?? "https";
  if (resolveAmbientProxyForUrl(ambientProbeUrl(protocol), env) === undefined) {
    return undefined;
  }
  return new ProxylineNodeProxyAgent({
    defaultProtocol: protocol,
    getProxyForUrl: (url) => resolveAmbientProxyForUrl(url, env) ?? "",
    ...(options.proxyTls !== undefined ? { proxyTls: options.proxyTls } : {}),
  });
}
