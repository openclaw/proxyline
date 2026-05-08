import http from "node:http";
import https from "node:https";
import { ProxyAgent as NodeProxyAgent } from "proxy-agent";
import {
  Agent as UndiciAgent,
  type Dispatcher,
  getGlobalDispatcher,
  ProxyAgent as UndiciProxyAgent,
  setGlobalDispatcher,
} from "undici";
import {
  ProxylineError,
  redactProxyUrl,
  resolveProxyTlsCa,
  type ProxylineTlsOptions,
} from "./shared.js";

export {
  ProxylineError,
  redactProxyUrl,
  resolveProxyTlsCa,
  type ProxylineTlsOptions,
} from "./shared.js";
export { openProxyConnectTunnel, type OpenProxyConnectTunnelOptions } from "./connect.js";

export type ProxylineMode = "managed" | "ambient";

export type ProxylineSurface =
  | "node-http"
  | "node-https"
  | "undici"
  | "websocket"
  | "connect"
  | "unknown";

export type ProxylineOptions = Readonly<{
  mode: ProxylineMode;
  proxyUrl?: string | URL;
  proxyTls?: ProxylineTlsOptions;
  onEvent?: (event: ProxylineEvent) => void;
}>;

export type ProxylineDecision = Readonly<{
  kind: "proxied" | "direct" | "blocked";
  reason: string;
  surface: ProxylineSurface;
  url: string;
  proxyUrl?: string;
}>;

export type ProxylineEvent =
  | Readonly<{
      type: "runtime.installed";
      mode: ProxylineMode;
      active: boolean;
      proxyUrl?: string;
    }>
  | Readonly<{
      type: "runtime.stopped";
      mode: ProxylineMode;
    }>
  | Readonly<{
      type: "decision";
      decision: ProxylineDecision;
    }>
  | Readonly<{
      type: "warning";
      code: string;
      message: string;
    }>;

export type ExplainOptions = Readonly<{
  surface?: ProxylineSurface;
}>;

export type ProxylineHandle = Readonly<{
  mode: ProxylineMode;
  active: boolean;
  proxyUrl?: string;
  createNodeAgent: () => http.Agent;
  createUndiciDispatcher: () => Dispatcher;
  createWebSocketAgent: () => http.Agent;
  explain: (url: string | URL, options?: ExplainOptions) => ProxylineDecision;
  stop: () => void;
}>;

function normalizeProxyUrl(value: string | URL | undefined): URL | undefined {
  if (value === undefined) {
    return undefined;
  }
  const url = value instanceof URL ? new URL(value.href) : new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProxylineError(
      "UNSUPPORTED_PROXY_PROTOCOL",
      `Proxyline only supports http:// and https:// proxy endpoints in this slice: ${url.protocol}`,
    );
  }
  return url;
}

function emit(onEvent: ProxylineOptions["onEvent"], event: ProxylineEvent): void {
  onEvent?.(event);
}

function formatUrl(value: string | URL): string {
  return value instanceof URL ? value.href : new URL(value).href;
}

type NodeHttpRequestOptions = http.RequestOptions & {
  agent?: http.Agent | false;
};

type NodeHttpMethod = typeof http.request;

type NodeHttpStackSnapshot = {
  httpRequest: typeof http.request;
  httpGet: typeof http.get;
  httpGlobalAgent: typeof http.globalAgent;
  httpsRequest: typeof https.request;
  httpsGet: typeof https.get;
  httpsGlobalAgent: typeof https.globalAgent;
};

type RuntimeInstall = {
  nodeAgent: NodeProxyAgent;
  originalDispatcher: Dispatcher;
  snapshot: NodeHttpStackSnapshot;
};

let activeRuntime: RuntimeInstall | undefined;

function copyNodeHttpOptions(value: unknown): NodeHttpRequestOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return { ...(value as NodeHttpRequestOptions) };
}

function bindNodeHttpMethod<TMethod extends NodeHttpMethod>(
  originalMethod: TMethod,
  agent: http.Agent,
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

    options.agent = agent;
    if (url !== undefined) {
      return originalMethod(url, options, callback as (res: http.IncomingMessage) => void);
    }
    return originalMethod(options, callback as (res: http.IncomingMessage) => void);
  }) as TMethod;
}

function createNodeProxyAgent(proxyUrl: string, proxyCa: string | undefined): NodeProxyAgent {
  return new NodeProxyAgent({
    ...(proxyCa !== undefined ? { ca: proxyCa } : {}),
    getProxyForUrl: (url: string) => {
      const protocol = new URL(url).protocol;
      return protocol === "http:" || protocol === "https:" || protocol === "ws:" || protocol === "wss:"
        ? proxyUrl
        : "";
    },
    httpAgent: new http.Agent(),
    httpsAgent: new https.Agent(),
  });
}

function createUndiciProxyDispatcher(
  proxyUrl: string | undefined,
  proxyCa: string | undefined,
): Dispatcher {
  if (proxyUrl === undefined) {
    return new UndiciAgent();
  }
  return new UndiciProxyAgent({
    uri: proxyUrl,
    ...(proxyCa !== undefined ? { proxyTls: { ca: proxyCa } } : {}),
  });
}

function installRuntime(proxyUrl: string, proxyCa: string | undefined): RuntimeInstall {
  if (activeRuntime !== undefined) {
    throw new ProxylineError("RUNTIME_ALREADY_ACTIVE", "Proxyline already has an active runtime.");
  }
  const snapshot: NodeHttpStackSnapshot = {
    httpRequest: http.request,
    httpGet: http.get,
    httpGlobalAgent: http.globalAgent,
    httpsRequest: https.request,
    httpsGet: https.get,
    httpsGlobalAgent: https.globalAgent,
  };
  const nodeAgent = createNodeProxyAgent(proxyUrl, proxyCa);
  const originalDispatcher = getGlobalDispatcher();
  const runtime: RuntimeInstall = {
    nodeAgent,
    originalDispatcher,
    snapshot,
  };
  activeRuntime = runtime;
  try {
    http.globalAgent = nodeAgent;
    https.globalAgent = nodeAgent;
    http.request = bindNodeHttpMethod(snapshot.httpRequest, nodeAgent);
    http.get = bindNodeHttpMethod(snapshot.httpGet, nodeAgent);
    https.request = bindNodeHttpMethod(snapshot.httpsRequest, nodeAgent);
    https.get = bindNodeHttpMethod(snapshot.httpsGet, nodeAgent);
    setGlobalDispatcher(createUndiciProxyDispatcher(proxyUrl, proxyCa));
  } catch (error) {
    activeRuntime = undefined;
    nodeAgent.destroy();
    throw error;
  }
  return runtime;
}

function stopRuntime(runtime: RuntimeInstall): void {
  if (activeRuntime !== runtime) {
    return;
  }
  http.request = runtime.snapshot.httpRequest;
  http.get = runtime.snapshot.httpGet;
  http.globalAgent = runtime.snapshot.httpGlobalAgent;
  https.request = runtime.snapshot.httpsRequest;
  https.get = runtime.snapshot.httpsGet;
  https.globalAgent = runtime.snapshot.httpsGlobalAgent;
  setGlobalDispatcher(runtime.originalDispatcher);
  runtime.nodeAgent.destroy();
  activeRuntime = undefined;
}

export function installProxyline(options: ProxylineOptions): ProxylineHandle {
  const proxyUrl = normalizeProxyUrl(options.proxyUrl);
  if (options.mode === "managed" && proxyUrl === undefined) {
    throw new ProxylineError(
      "MANAGED_PROXY_URL_REQUIRED",
      "Proxyline managed mode requires an explicit proxyUrl.",
    );
  }

  let stopped = false;
  const proxyCa = resolveProxyTlsCa(options.proxyTls);
  const redactedProxyUrl = proxyUrl ? redactProxyUrl(proxyUrl) : undefined;
  const runtime = proxyUrl !== undefined ? installRuntime(proxyUrl.href, proxyCa) : undefined;
  const hasActiveProxy = redactedProxyUrl !== undefined;
  emit(options.onEvent, {
    type: "runtime.installed",
    mode: options.mode,
    active: hasActiveProxy,
    ...(redactedProxyUrl ? { proxyUrl: redactedProxyUrl } : {}),
  });

  const handle: ProxylineHandle = {
    mode: options.mode,
    active: hasActiveProxy,
    ...(redactedProxyUrl ? { proxyUrl: redactedProxyUrl } : {}),
    createNodeAgent: () => {
      if (proxyUrl === undefined) {
        return new http.Agent();
      }
      return createNodeProxyAgent(proxyUrl.href, proxyCa);
    },
    createUndiciDispatcher: () => createUndiciProxyDispatcher(proxyUrl?.href, proxyCa),
    createWebSocketAgent: () => {
      if (proxyUrl === undefined) {
        return new http.Agent();
      }
      return createNodeProxyAgent(proxyUrl.href, proxyCa);
    },
    explain: (url, explainOptions) => {
      const decision: ProxylineDecision =
        stopped || redactedProxyUrl === undefined
          ? {
              kind: "direct",
              reason: stopped ? "runtime-stopped" : "ambient-proxy-not-configured",
              surface: explainOptions?.surface ?? "unknown",
              url: formatUrl(url),
            }
          : {
              kind: "proxied",
              reason: options.mode === "managed" ? "managed-proxy-active" : "ambient-proxy-active",
              surface: explainOptions?.surface ?? "unknown",
              url: formatUrl(url),
              proxyUrl: redactedProxyUrl,
            };
      emit(options.onEvent, { type: "decision", decision });
      return decision;
    },
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      if (runtime !== undefined) {
        stopRuntime(runtime);
      }
      emit(options.onEvent, { type: "runtime.stopped", mode: options.mode });
    },
  };

  return handle;
}

export const installGlobalProxy = installProxyline;
