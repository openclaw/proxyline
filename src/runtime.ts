import http from "node:http";
import https from "node:https";
import {
  Agent as UndiciAgent,
  Dispatcher,
  FormData as UndiciFormData,
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
  type ProxylineNodeProxyAgent,
} from "./node-http.js";
import {
  formatUrl,
  ProxylineError,
  redactProxyUrl,
  resolveProxyTlsCa,
} from "./shared.js";
import type {
  ProxylineBypassRegistration,
  ProxylineBypassPolicy,
  ProxylineEvent,
  ProxylineHandle,
  ProxylineOptions,
  ProxyResolver,
  ProxylineSurface,
  ProxylineUndiciOptions,
} from "./types.js";
import { PROXYLINE_DISPATCHER_BRAND } from "./dispatcher-brand.js";

type RuntimeInstall = {
  bypassPolicy: ProxylineBypassPolicy | undefined;
  installedDispatcher: Dispatcher;
  mode: ProxylineOptions["mode"];
  nodeHttpAgent: ProxylineNodeProxyAgent;
  nodeHttpsAgent: ProxylineNodeProxyAgent;
  originalDispatcher: Dispatcher;
  originalFetch: typeof globalThis.fetch;
  originalFormData: typeof globalThis.FormData;
  originalHeaders: typeof globalThis.Headers;
  originalRequest: typeof globalThis.Request;
  originalResponse: typeof globalThis.Response;
  proxyCa: string | undefined;
  proxyUrl: string | undefined;
  snapshot: NodeHttpStackSnapshot;
  undiciOptions: ProxylineUndiciOptions | undefined;
};

let activeRuntime: RuntimeInstall | undefined;
let activeHandle: ProxylineHandle | undefined;

type ProxylineDispatcher = Dispatcher & {
  [PROXYLINE_DISPATCHER_BRAND]?: true;
};

// Node's global fetch types come from bundled undici-types, while the runtime
// implementation intentionally delegates to this package's undici dependency.
const proxylineHeaders = UndiciHeaders as unknown as typeof globalThis.Headers;
const proxylineRequest = UndiciRequest as unknown as typeof globalThis.Request;
const proxylineResponse = UndiciResponse as unknown as typeof globalThis.Response;
const proxylineFormData = UndiciFormData as unknown as typeof globalThis.FormData;

type ProxylineRequestInit = {
  body?: unknown;
  cache?: unknown;
  credentials?: unknown;
  dispatcher?: unknown;
  duplex?: "half";
  headers?: unknown;
  integrity?: unknown;
  keepalive?: unknown;
  method?: string;
  mode?: unknown;
  redirect?: unknown;
  referrer?: unknown;
  referrerPolicy?: unknown;
  signal?: unknown;
};

type FetchRequestLike = Readonly<{
  arrayBuffer: () => Promise<ArrayBuffer>;
  body: ReadableStream<Uint8Array> | null;
  cache?: unknown;
  credentials?: unknown;
  headers: InstanceType<typeof globalThis.Headers>;
  integrity?: unknown;
  keepalive?: unknown;
  method: string;
  mode?: unknown;
  redirect?: unknown;
  referrer?: unknown;
  referrerPolicy?: unknown;
  signal?: unknown;
  url: string;
}>;

function getRequestDispatcher(request: FetchRequestLike): unknown {
  for (const symbol of Object.getOwnPropertySymbols(request)) {
    if (symbol.description !== "dispatcher") {
      continue;
    }
    return Reflect.get(request, symbol);
  }
  return undefined;
}

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
  options: { includeBody: boolean; preserveDispatcher: boolean },
): Promise<globalThis.Request> {
  const init: ProxylineRequestInit = {
    headers: request.headers,
    method: request.method,
  };
  if (request.cache !== undefined) {
    init.cache = request.cache;
  }
  if (request.credentials !== undefined) {
    init.credentials = request.credentials;
  }
  if (request.integrity !== undefined) {
    init.integrity = request.integrity;
  }
  if (request.keepalive !== undefined) {
    init.keepalive = request.keepalive;
  }
  if (request.mode !== undefined) {
    init.mode = request.mode;
  }
  if (request.redirect !== undefined) {
    init.redirect = request.redirect;
  }
  if (request.referrer !== undefined) {
    init.referrer = request.referrer;
  }
  if (request.referrerPolicy !== undefined) {
    init.referrerPolicy = request.referrerPolicy;
  }
  if (options.preserveDispatcher) {
    const dispatcher = getRequestDispatcher(request);
    if (dispatcher !== undefined) {
      Reflect.set(init, "dispatcher", dispatcher);
    }
  }
  if (request.signal !== undefined) {
    init.signal = request.signal;
  }
  if (
    options.includeBody &&
    request.body !== null &&
    request.method !== "GET" &&
    request.method !== "HEAD"
  ) {
    init.body = request.body;
    init.duplex = "half";
  }
  const requestUnknown: unknown = Reflect.construct(proxylineRequest, [request.url, init]);
  if (!(requestUnknown instanceof proxylineRequest)) {
    throw new TypeError("Proxyline failed to normalize a fetch Request.");
  }
  return requestUnknown;
}

function requestInitOverridesBody(init: Parameters<typeof globalThis.fetch>[1]): boolean {
  if (typeof init !== "object" || init === null) {
    return false;
  }
  return "body" in init;
}

async function normalizeFetchInput(
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
  options: { preserveDispatcher: boolean },
): Promise<Parameters<typeof globalThis.fetch>[0]> {
  if ((input instanceof proxylineRequest && options.preserveDispatcher) || !isFetchRequestLike(input)) {
    return input;
  }
  return await createProxylineRequestFromRequestLike(input, {
    includeBody: !requestInitOverridesBody(init),
    preserveDispatcher: options.preserveDispatcher,
  });
}

function stripFetchDispatcher(
  init: Parameters<typeof globalThis.fetch>[1],
): Parameters<typeof globalThis.fetch>[1] {
  if (typeof init !== "object" || init === null) {
    return init;
  }
  const sanitized = Object.create(init);
  Reflect.defineProperty(sanitized, "dispatcher", {
    configurable: true,
    enumerable: true,
    value: undefined,
    writable: true,
  });
  return sanitized;
}

const proxylineFetch: typeof globalThis.fetch = async (input, init) => {
  const managedMode = activeRuntime?.mode === "managed";
  const normalizedInput = await normalizeFetchInput(input, init, {
    preserveDispatcher: !managedMode,
  });
  const normalizedInit = managedMode ? stripFetchDispatcher(init) : init;
  const response: unknown = await Reflect.apply(
    undiciFetch,
    undefined,
    normalizedInit === undefined ? [normalizedInput] : [normalizedInput, normalizedInit],
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

function isProxyableUrlProtocol(protocol: string): boolean {
  return protocol === "http:" ||
    protocol === "https:" ||
    protocol === "ws:" ||
    protocol === "wss:";
}

function shouldBypassManagedProxy(
  bypassPolicy: ProxylineBypassPolicy | undefined,
  bypasses: DynamicBypassRegistry,
  url: string | URL,
  surface: ProxylineSurface,
): boolean {
  if (bypasses.has(url, surface)) {
    return true;
  }
  if (bypassPolicy === undefined) {
    return false;
  }
  return bypassPolicy({ surface, url: formatUrl(url) });
}

type DynamicBypassRegistry = {
  add: (registration: ProxylineBypassRegistration) => () => void;
  has: (url: string | URL, surface: ProxylineSurface) => boolean;
};

function bypassKey(url: string | URL, surface: ProxylineSurface | undefined): string {
  return `${surface ?? "*"}\n${formatUrl(url)}`;
}

function createDynamicBypassRegistry(): DynamicBypassRegistry {
  const counts = new Map<string, number>();
  return {
    add: (registration) => {
      const key = bypassKey(registration.url, registration.surface);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      let stopped = false;
      return () => {
        if (stopped) {
          return;
        }
        stopped = true;
        const next = (counts.get(key) ?? 1) - 1;
        if (next <= 0) {
          counts.delete(key);
        } else {
          counts.set(key, next);
        }
      };
    },
    has: (url, surface) =>
      (counts.get(bypassKey(url, surface)) ?? 0) > 0 ||
      (counts.get(bypassKey(url, undefined)) ?? 0) > 0,
  };
}

function createManagedProxyResolver(
  proxyUrl: URL,
  bypassPolicy: ProxylineBypassPolicy | undefined,
  bypasses: DynamicBypassRegistry,
): ProxyResolver {
  const redactedProxyUrl = redactProxyUrl(proxyUrl);
  return {
    active: true,
    describeProxy: () => redactedProxyUrl,
    explain: (url, surface) => {
      const formattedUrl = formatUrl(url);
      if (!isProxyableUrlProtocol(new URL(url).protocol)) {
        return {
          kind: "direct",
          reason: "managed-proxy-unsupported-url-scheme",
          surface,
          url: formattedUrl,
        };
      }
      if (shouldBypassManagedProxy(bypassPolicy, bypasses, url, surface)) {
        return {
          kind: "direct",
          reason: "managed-proxy-bypass-policy",
          surface,
          url: formattedUrl,
        };
      }
      return {
        kind: "proxied",
        reason: "managed-proxy-active",
        surface,
        url: formattedUrl,
        proxyUrl: redactedProxyUrl,
      };
    },
    getProxyForUrl: (url, surface = "unknown") => {
      const protocol = new URL(url).protocol;
      return isProxyableUrlProtocol(protocol) &&
        !shouldBypassManagedProxy(bypassPolicy, bypasses, url, surface)
        ? proxyUrl.href
        : "";
    },
  };
}

type UndiciDispatcherOptions = Readonly<{
  proxyCa: string | undefined;
  undici: ProxylineUndiciOptions | undefined;
}>;

function finitePositiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function resolveUndiciBaseOptions(
  options: ProxylineUndiciOptions | undefined,
): Record<string, unknown> {
  const bodyTimeout = finitePositiveInteger(options?.bodyTimeout);
  const headersTimeout = finitePositiveInteger(options?.headersTimeout);
  return {
    ...(options?.allowH2 !== undefined ? { allowH2: options.allowH2 } : {}),
    ...(bodyTimeout !== undefined ? { bodyTimeout } : {}),
    ...(headersTimeout !== undefined ? { headersTimeout } : {}),
    ...(options?.connect !== undefined
      ? {
          connect: {
            ...(options.connect.autoSelectFamily !== undefined
              ? { autoSelectFamily: options.connect.autoSelectFamily }
              : {}),
            ...(finitePositiveInteger(options.connect.autoSelectFamilyAttemptTimeout) !== undefined
              ? {
                  autoSelectFamilyAttemptTimeout: finitePositiveInteger(
                    options.connect.autoSelectFamilyAttemptTimeout,
                  ),
                }
              : {}),
          },
        }
      : {}),
  };
}

function createUndiciAgent(options: ProxylineUndiciOptions | undefined): UndiciAgent {
  return new UndiciAgent(resolveUndiciBaseOptions(options));
}

function createUndiciProxyAgent(
  proxyUrl: string,
  options: UndiciDispatcherOptions,
): UndiciProxyAgent {
  return new UndiciProxyAgent({
    ...resolveUndiciBaseOptions(options.undici),
    uri: proxyUrl,
    ...(options.proxyCa !== undefined ? { proxyTls: { ca: options.proxyCa } } : {}),
  } as ConstructorParameters<typeof UndiciProxyAgent>[0]);
}

function createUndiciProxyDispatcher(
  options:
    | { mode: "managed"; resolver: ProxyResolver }
    | { mode: "ambient"; env: ProxyEnvSnapshot; active: boolean },
  dispatcherOptions: UndiciDispatcherOptions,
): Dispatcher {
  if (options.mode === "ambient") {
    if (!options.active) {
      return createUndiciAgent(dispatcherOptions.undici);
    }
    return new AmbientUndiciDispatcher(options.env, dispatcherOptions);
  }
  return new ManagedUndiciDispatcher(options.resolver, dispatcherOptions);
}

class ManagedUndiciDispatcher extends Dispatcher {
  public readonly [PROXYLINE_DISPATCHER_BRAND] = true;
  readonly #directDispatcher: UndiciAgent;
  readonly #dispatcherOptions: UndiciDispatcherOptions;
  readonly #proxyDispatchers = new Map<string, UndiciProxyAgent>();
  readonly #resolver: ProxyResolver;
  #closedError: Error | undefined;

  public constructor(resolver: ProxyResolver, dispatcherOptions: UndiciDispatcherOptions) {
    super();
    this.#resolver = resolver;
    this.#dispatcherOptions = dispatcherOptions;
    this.#directDispatcher = createUndiciAgent(dispatcherOptions.undici);
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
    const proxyUrl = url === undefined ? "" : this.#resolver.getProxyForUrl(url, "undici");
    const dispatcher = proxyUrl === "" ? this.#directDispatcher : this.#proxyDispatcher(proxyUrl);
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
    const dispatcher = createUndiciProxyAgent(proxyUrl, this.#dispatcherOptions);
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

class AmbientUndiciDispatcher extends Dispatcher {
  public readonly [PROXYLINE_DISPATCHER_BRAND] = true;
  readonly #directDispatcher: UndiciAgent;
  readonly #dispatcherOptions: UndiciDispatcherOptions;
  readonly #env: ProxyEnvSnapshot;
  readonly #proxyDispatchers = new Map<string, UndiciProxyAgent>();
  #closedError: Error | undefined;

  public constructor(env: ProxyEnvSnapshot, dispatcherOptions: UndiciDispatcherOptions) {
    super();
    this.#env = env;
    this.#dispatcherOptions = dispatcherOptions;
    this.#directDispatcher = createUndiciAgent(dispatcherOptions.undici);
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
    const dispatcher = proxyUrl === undefined ? this.#directDispatcher : this.#proxyDispatcher(proxyUrl);
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
    const dispatcher = createUndiciProxyAgent(proxyUrl, this.#dispatcherOptions);
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
    const origin = options.origin.toString().replace(/\/$/, "");
    const path = options.path.startsWith("/") ? options.path : `/${options.path}`;
    return new URL(`${origin}${path}`).href;
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
    | { mode: "managed"; resolver: ProxyResolver }
    | { mode: "ambient"; env: ProxyEnvSnapshot; active: boolean },
  proxyCa: string | undefined,
  options: {
    bypassPolicy: ProxylineBypassPolicy | undefined;
    proxyUrl: URL | undefined;
    undici: ProxylineUndiciOptions | undefined;
  },
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
  const nodeHttpAgent = createNodeProxyAgent(resolver, proxyCa, "http");
  const nodeHttpsAgent = createNodeProxyAgent(resolver, proxyCa, "https");
  const originalDispatcher = getGlobalDispatcher();
  const originalFetch = globalThis.fetch;
  const originalFormData = globalThis.FormData;
  const originalHeaders = globalThis.Headers;
  const originalRequest = globalThis.Request;
  const originalResponse = globalThis.Response;
  const installedDispatcher = createUndiciProxyDispatcher(dispatcherOptions, {
    proxyCa,
    undici: options.undici,
  });
  const runtime: RuntimeInstall = {
    bypassPolicy: options.bypassPolicy,
    installedDispatcher,
    mode: dispatcherOptions.mode,
    nodeHttpAgent,
    nodeHttpsAgent,
    originalDispatcher,
    originalFetch,
    originalFormData,
    originalHeaders,
    originalRequest,
    originalResponse,
    proxyCa,
    proxyUrl: options.proxyUrl?.href,
    snapshot,
    undiciOptions: options.undici,
  };
  activeRuntime = runtime;
  try {
    http.globalAgent = nodeHttpAgent;
    https.globalAgent = nodeHttpsAgent as unknown as typeof https.globalAgent;
    http.request = bindNodeHttpMethod(snapshot.httpRequest, () =>
      createNodeProxyAgent(resolver, proxyCa, "http"),
    );
    http.get = bindNodeHttpMethod(snapshot.httpGet, () =>
      createNodeProxyAgent(resolver, proxyCa, "http"),
    );
    https.request = bindNodeHttpMethod(snapshot.httpsRequest, () =>
      createNodeProxyAgent(resolver, proxyCa, "https"),
    );
    https.get = bindNodeHttpMethod(snapshot.httpsGet, () =>
      createNodeProxyAgent(resolver, proxyCa, "https"),
    );
    setGlobalDispatcher(installedDispatcher);
    globalThis.fetch = proxylineFetch;
    globalThis.FormData = proxylineFormData;
    globalThis.Headers = proxylineHeaders;
    globalThis.Request = proxylineRequest;
    globalThis.Response = proxylineResponse;
  } catch (error) {
    restoreNodeHttpSnapshot(snapshot);
    setGlobalDispatcher(originalDispatcher);
    globalThis.fetch = originalFetch;
    globalThis.FormData = originalFormData;
    globalThis.Headers = originalHeaders;
    globalThis.Request = originalRequest;
    globalThis.Response = originalResponse;
    activeRuntime = undefined;
    void installedDispatcher.destroy();
    nodeHttpAgent.destroy();
    nodeHttpsAgent.destroy();
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
  globalThis.FormData = runtime.originalFormData;
  globalThis.Headers = runtime.originalHeaders;
  globalThis.Request = runtime.originalRequest;
  globalThis.Response = runtime.originalResponse;
  void runtime.installedDispatcher.destroy();
  runtime.nodeHttpAgent.destroy();
  runtime.nodeHttpsAgent.destroy();
  activeRuntime = undefined;
  activeHandle = undefined;
}

export function installProxyline(options: ProxylineOptions): ProxylineHandle {
  const proxyUrl = options.mode === "managed" ? normalizeProxyUrl(options.proxyUrl) : undefined;
  if (options.mode === "managed" && proxyUrl === undefined) {
    throw new ProxylineError(
      "MANAGED_PROXY_URL_REQUIRED",
      "Proxyline managed mode requires an explicit proxyUrl.",
    );
  }

  const activePolicy = options.ifActive ?? "error";
  if (activeRuntime !== undefined) {
    if (activePolicy === "replace") {
      activeHandle?.stop();
    } else if (
      activePolicy === "reuse-compatible" &&
      activeHandle !== undefined &&
      activeRuntime.mode === options.mode &&
      activeRuntime.proxyUrl === proxyUrl?.href &&
      activeRuntime.proxyCa === resolveProxyTlsCa(options.proxyTls) &&
      activeRuntime.bypassPolicy === options.bypassPolicy &&
      JSON.stringify(activeRuntime.undiciOptions ?? {}) === JSON.stringify(options.undici ?? {})
    ) {
      return activeHandle;
    } else {
      throw new ProxylineError(
        "RUNTIME_ALREADY_ACTIVE",
        "Proxyline already has an active runtime.",
      );
    }
  }

  let stopped = false;
  const proxyCa = resolveProxyTlsCa(options.proxyTls);
  const ambientEnv = proxyUrl === undefined ? readProxyEnv() : undefined;
  const dynamicBypasses = createDynamicBypassRegistry();
  const resolver =
    proxyUrl !== undefined
      ? createManagedProxyResolver(proxyUrl, options.bypassPolicy, dynamicBypasses)
      : createAmbientProxyResolver(ambientEnv ?? EMPTY_PROXY_ENV);
  const redactedProxyUrl = resolver.describeProxy();
  const hasActiveProxy = resolver.active;
  const runtime = hasActiveProxy
    ? installRuntime(
        resolver,
        proxyUrl !== undefined
          ? { mode: "managed", resolver }
          : { mode: "ambient", env: ambientEnv ?? EMPTY_PROXY_ENV, active: hasActiveProxy },
        proxyCa,
        {
          bypassPolicy: options.bypassPolicy,
          proxyUrl,
          undici: options.undici,
        },
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
        ? createUndiciAgent(options.undici)
        : createUndiciProxyDispatcher(
            proxyUrl !== undefined
              ? { mode: "managed", resolver }
              : { mode: "ambient", env: ambientEnv ?? EMPTY_PROXY_ENV, active: hasActiveProxy },
            { proxyCa, undici: options.undici },
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
    registerBypass: (registration) => {
      if (stopped || proxyUrl === undefined) {
        return () => {};
      }
      return dynamicBypasses.add(registration);
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
    withBypass: (registration, run) => {
      const unregister = handle.registerBypass(registration);
      try {
        return run();
      } finally {
        unregister();
      }
    },
  };

  activeHandle = hasActiveProxy ? handle : activeHandle;
  return handle;
}

export const installGlobalProxy = installProxyline;
