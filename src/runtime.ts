import http from "node:http";
import https from "node:https";
import { ProxyAgent as NodeProxyAgent } from "proxy-agent";
import {
  Agent as UndiciAgent,
  Dispatcher,
  Headers as UndiciHeaders,
  Request as UndiciRequest,
  Response as UndiciResponse,
  errors as undiciErrors,
  fetch as undiciFetch,
  getGlobalDispatcher,
  ProxyAgent as UndiciProxyAgent,
  setGlobalDispatcher,
} from "undici";
import {
  createAmbientProxyResolver,
  EMPTY_PROXY_ENV,
  resolveAmbientProxyForUrl,
  readProxyEnv,
  type ProxyEnvSnapshot,
} from "./env.js";
import {
  bindNodeHttpMethod,
  createDirectNodeAgent,
  createNodeProxyAgent,
  type NodeHttpStackSnapshot,
} from "./node-http.js";
import {
  formatUrl,
  ProxylineError,
  redactProxyUrl,
  resolveProxyTlsCa,
} from "./shared.js";
import type {
  ProxylineEvent,
  ProxylineHandle,
  ProxylineOptions,
  ProxyResolver,
} from "./types.js";

type RuntimeInstall = {
  installedDispatcher: Dispatcher;
  nodeAgent: NodeProxyAgent;
  originalDispatcher: Dispatcher;
  originalFetch: typeof globalThis.fetch;
  originalHeaders: typeof globalThis.Headers;
  originalRequest: typeof globalThis.Request;
  originalResponse: typeof globalThis.Response;
  snapshot: NodeHttpStackSnapshot;
};

let activeRuntime: RuntimeInstall | undefined;

// Node's global fetch types come from bundled undici-types, while the runtime
// implementation intentionally delegates to this package's undici dependency.
const proxylineHeaders = UndiciHeaders as unknown as typeof globalThis.Headers;
const proxylineRequest = UndiciRequest as unknown as typeof globalThis.Request;
const proxylineResponse = UndiciResponse as unknown as typeof globalThis.Response;

type FetchRequestLike = Readonly<{
  arrayBuffer: () => Promise<ArrayBuffer>;
  body: ReadableStream<Uint8Array> | null;
  headers: InstanceType<typeof globalThis.Headers>;
  method: string;
  signal?: AbortSignal;
  url: string;
}>;

function isFetchRequestLike(value: unknown): value is FetchRequestLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return (
    typeof record.url === "string" &&
    typeof record.method === "string" &&
    typeof record.arrayBuffer === "function" &&
    record.headers !== undefined
  );
}

async function createProxylineRequestFromRequestLike(
  request: FetchRequestLike,
): Promise<globalThis.Request> {
  const init: RequestInit = {
    headers: request.headers,
    method: request.method,
  };
  if (request.signal !== undefined) {
    init.signal = request.signal;
  }
  if (request.body !== null && request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
    init.duplex = "half";
  }
  return new proxylineRequest(request.url, init);
}

async function normalizeFetchInput(
  input: Parameters<typeof globalThis.fetch>[0],
): Promise<Parameters<typeof globalThis.fetch>[0]> {
  if (input instanceof proxylineRequest || !isFetchRequestLike(input)) {
    return input;
  }
  return await createProxylineRequestFromRequestLike(input);
}

const proxylineFetch: typeof globalThis.fetch = async (input, init) => {
  const normalizedInput = await normalizeFetchInput(input);
  const response: unknown = await Reflect.apply(
    undiciFetch,
    undefined,
    init === undefined ? [normalizedInput] : [normalizedInput, init],
  );
  if (!(response instanceof proxylineResponse)) {
    throw new TypeError("Proxyline fetch returned a non-Response value.");
  }
  return response;
};

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

function createManagedProxyResolver(proxyUrl: URL): ProxyResolver {
  const redactedProxyUrl = redactProxyUrl(proxyUrl);
  return {
    active: true,
    describeProxy: () => redactedProxyUrl,
    explain: (url, surface) => ({
      kind: "proxied",
      reason: "managed-proxy-active",
      surface,
      url: formatUrl(url),
      proxyUrl: redactedProxyUrl,
    }),
    getProxyForUrl: (url) => {
      const protocol = new URL(url).protocol;
      return protocol === "http:" ||
        protocol === "https:" ||
        protocol === "ws:" ||
        protocol === "wss:"
        ? proxyUrl.href
        : "";
    },
  };
}

function createUndiciProxyDispatcher(
  options:
    | { mode: "managed"; proxyUrl: string }
    | { mode: "ambient"; env: ProxyEnvSnapshot; active: boolean },
  proxyCa: string | undefined,
): Dispatcher {
  if (options.mode === "ambient") {
    if (!options.active) {
      return new UndiciAgent();
    }
    return new AmbientUndiciDispatcher(options.env, proxyCa);
  }
  return new UndiciProxyAgent({
    uri: options.proxyUrl,
    ...(proxyCa !== undefined ? { proxyTls: { ca: proxyCa } } : {}),
  });
}

class AmbientUndiciDispatcher extends Dispatcher {
  readonly #directDispatcher = new UndiciAgent();
  readonly #env: ProxyEnvSnapshot;
  readonly #proxyCa: string | undefined;
  readonly #proxyDispatchers = new Map<string, UndiciProxyAgent>();
  #closedError: Error | undefined;

  public constructor(env: ProxyEnvSnapshot, proxyCa: string | undefined) {
    super();
    this.#env = env;
    this.#proxyCa = proxyCa;
  }

  public override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    if (this.#closedError !== undefined) {
      if (handler.onError === undefined) {
        throw this.#closedError;
      }
      handler.onError(this.#closedError);
      return false;
    }
    const url = resolveUndiciDispatchUrl(options);
    const proxyUrl = url === undefined ? undefined : resolveAmbientProxyForUrl(url, this.#env);
    const dispatcher =
      proxyUrl === undefined ? this.#directDispatcher : this.#proxyDispatcher(proxyUrl);
    return dispatcher.dispatch(options, handler);
  }

  public override close(callback: () => void): void;
  public override close(): Promise<void>;
  public override close(callback?: () => void): Promise<void> | void {
    const closing = this.#closeAll();
    if (callback === undefined) {
      return closing;
    }
    closing.then(callback, callback);
  }

  public override destroy(): Promise<void>;
  public override destroy(error: Error | null): Promise<void>;
  public override destroy(callback: () => void): void;
  public override destroy(error: Error | null, callback: () => void): void;
  public override destroy(
    errorOrCallback?: Error | null | (() => void),
    callback?: () => void,
  ): Promise<void> | void {
    const error = typeof errorOrCallback === "function" ? null : errorOrCallback ?? null;
    const destroyCallback = typeof errorOrCallback === "function" ? errorOrCallback : callback;
    const destroying = this.#destroyAll(error);
    if (destroyCallback === undefined) {
      return destroying;
    }
    destroying.then(destroyCallback, destroyCallback);
  }

  #proxyDispatcher(proxyUrl: string): UndiciProxyAgent {
    const existing = this.#proxyDispatchers.get(proxyUrl);
    if (existing !== undefined) {
      return existing;
    }
    const dispatcher = new UndiciProxyAgent({
      uri: proxyUrl,
      ...(this.#proxyCa !== undefined ? { proxyTls: { ca: this.#proxyCa } } : {}),
    });
    this.#proxyDispatchers.set(proxyUrl, dispatcher);
    return dispatcher;
  }

  async #closeAll(): Promise<void> {
    this.#closedError ??= new undiciErrors.ClientClosedError();
    const proxyDispatchers = [...this.#proxyDispatchers.values()];
    this.#proxyDispatchers.clear();
    await Promise.all([
      this.#directDispatcher.close(),
      ...proxyDispatchers.map((dispatcher) => dispatcher.close()),
    ]);
  }

  async #destroyAll(error: Error | null): Promise<void> {
    this.#closedError ??= error ?? new undiciErrors.ClientDestroyedError();
    const proxyDispatchers = [...this.#proxyDispatchers.values()];
    this.#proxyDispatchers.clear();
    await Promise.all([
      this.#directDispatcher.destroy(error),
      ...proxyDispatchers.map((dispatcher) => dispatcher.destroy(error)),
    ]);
  }
}

function resolveUndiciDispatchUrl(options: Dispatcher.DispatchOptions): string | undefined {
  if (options.origin !== undefined) {
    return new URL(options.path, options.origin).href;
  }
  try {
    return new URL(options.path).href;
  } catch {
    return undefined;
  }
}

function restoreNodeHttpSnapshot(snapshot: NodeHttpStackSnapshot): void {
  http.request = snapshot.httpRequest;
  http.get = snapshot.httpGet;
  http.globalAgent = snapshot.httpGlobalAgent;
  https.request = snapshot.httpsRequest;
  https.get = snapshot.httpsGet;
  https.globalAgent = snapshot.httpsGlobalAgent;
}

function installRuntime(
  resolver: ProxyResolver,
  dispatcherOptions:
    | { mode: "managed"; proxyUrl: string }
    | { mode: "ambient"; env: ProxyEnvSnapshot; active: boolean },
  proxyCa: string | undefined,
): RuntimeInstall {
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
  const nodeAgent = createNodeProxyAgent(resolver, proxyCa);
  const originalDispatcher = getGlobalDispatcher();
  const originalFetch = globalThis.fetch;
  const originalHeaders = globalThis.Headers;
  const originalRequest = globalThis.Request;
  const originalResponse = globalThis.Response;
  const installedDispatcher = createUndiciProxyDispatcher(dispatcherOptions, proxyCa);
  const runtime: RuntimeInstall = {
    installedDispatcher,
    nodeAgent,
    originalDispatcher,
    originalFetch,
    originalHeaders,
    originalRequest,
    originalResponse,
    snapshot,
  };
  activeRuntime = runtime;
  try {
    http.globalAgent = nodeAgent;
    https.globalAgent = nodeAgent;
    http.request = bindNodeHttpMethod(snapshot.httpRequest, () =>
      createNodeProxyAgent(resolver, proxyCa),
    );
    http.get = bindNodeHttpMethod(snapshot.httpGet, () =>
      createNodeProxyAgent(resolver, proxyCa),
    );
    https.request = bindNodeHttpMethod(snapshot.httpsRequest, () =>
      createNodeProxyAgent(resolver, proxyCa),
    );
    https.get = bindNodeHttpMethod(snapshot.httpsGet, () =>
      createNodeProxyAgent(resolver, proxyCa),
    );
    setGlobalDispatcher(installedDispatcher);
    globalThis.fetch = proxylineFetch;
    globalThis.Headers = proxylineHeaders;
    globalThis.Request = proxylineRequest;
    globalThis.Response = proxylineResponse;
  } catch (error) {
    restoreNodeHttpSnapshot(snapshot);
    setGlobalDispatcher(originalDispatcher);
    globalThis.fetch = originalFetch;
    globalThis.Headers = originalHeaders;
    globalThis.Request = originalRequest;
    globalThis.Response = originalResponse;
    activeRuntime = undefined;
    void installedDispatcher.destroy();
    nodeAgent.destroy();
    throw error;
  }
  return runtime;
}

function stopRuntime(runtime: RuntimeInstall): void {
  if (activeRuntime !== runtime) {
    return;
  }
  restoreNodeHttpSnapshot(runtime.snapshot);
  setGlobalDispatcher(runtime.originalDispatcher);
  globalThis.fetch = runtime.originalFetch;
  globalThis.Headers = runtime.originalHeaders;
  globalThis.Request = runtime.originalRequest;
  globalThis.Response = runtime.originalResponse;
  void runtime.installedDispatcher.destroy();
  runtime.nodeAgent.destroy();
  activeRuntime = undefined;
}

export function installProxyline(options: ProxylineOptions): ProxylineHandle {
  const proxyUrl = options.mode === "managed" ? normalizeProxyUrl(options.proxyUrl) : undefined;
  if (options.mode === "managed" && proxyUrl === undefined) {
    throw new ProxylineError(
      "MANAGED_PROXY_URL_REQUIRED",
      "Proxyline managed mode requires an explicit proxyUrl.",
    );
  }

  let stopped = false;
  const proxyCa = resolveProxyTlsCa(options.proxyTls);
  const ambientEnv = proxyUrl === undefined ? readProxyEnv() : undefined;
  const resolver =
    proxyUrl !== undefined
      ? createManagedProxyResolver(proxyUrl)
      : createAmbientProxyResolver(ambientEnv ?? EMPTY_PROXY_ENV);
  const redactedProxyUrl = resolver.describeProxy();
  const hasActiveProxy = resolver.active;
  const runtime = hasActiveProxy
    ? installRuntime(
        resolver,
        proxyUrl !== undefined
          ? { mode: "managed", proxyUrl: proxyUrl.href }
          : { mode: "ambient", env: ambientEnv ?? EMPTY_PROXY_ENV, active: hasActiveProxy },
        proxyCa,
      )
    : undefined;
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
      if (!hasActiveProxy || stopped) {
        return createDirectNodeAgent();
      }
      return createNodeProxyAgent(resolver, proxyCa);
    },
    createUndiciDispatcher: () =>
      stopped
        ? new UndiciAgent()
        : createUndiciProxyDispatcher(
            proxyUrl !== undefined
              ? { mode: "managed", proxyUrl: proxyUrl.href }
              : { mode: "ambient", env: ambientEnv ?? EMPTY_PROXY_ENV, active: hasActiveProxy },
            proxyCa,
          ),
    createWebSocketAgent: () => {
      if (!hasActiveProxy || stopped) {
        return createDirectNodeAgent();
      }
      return createNodeProxyAgent(resolver, proxyCa);
    },
    explain: (url, explainOptions) => {
      const decision =
        stopped
          ? {
              kind: "direct" as const,
              reason: "runtime-stopped",
              surface: explainOptions?.surface ?? "unknown",
              url: formatUrl(url),
            }
          : resolver.explain(url, explainOptions?.surface ?? "unknown");
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
