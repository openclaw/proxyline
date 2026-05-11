import http from "node:http";
import https from "node:https";
import { Agent as UndiciAgent, Dispatcher, errors as undiciErrors, fetch as undiciFetch, getGlobalDispatcher, ProxyAgent as UndiciProxyAgent, setGlobalDispatcher, } from "undici";
import { createAmbientProxyResolver, EMPTY_PROXY_ENV, resolveAmbientProxyForUrl, readProxyEnv, } from "./env.js";
import { bindNodeHttpMethod, createDirectNodeAgent, createNodeProxyAgent, } from "./node-http.js";
import { formatUrl, ProxylineError, redactProxyUrl, resolveProxyTlsCa, } from "./shared.js";
let activeRuntime;
// Node's global fetch types come from bundled undici-types, while the runtime
// implementation intentionally delegates to this package's undici dependency.
const proxylineFetch = undiciFetch;
function normalizeProxyUrl(value) {
    if (value === undefined) {
        return undefined;
    }
    const url = value instanceof URL ? new URL(value.href) : new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new ProxylineError("UNSUPPORTED_PROXY_PROTOCOL", `Proxyline only supports http:// and https:// proxy endpoints in this slice: ${url.protocol}`);
    }
    return url;
}
function emit(onEvent, event) {
    onEvent?.(event);
}
function createManagedProxyResolver(proxyUrl) {
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
function createUndiciProxyDispatcher(options, proxyCa) {
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
    #directDispatcher = new UndiciAgent();
    #env;
    #proxyCa;
    #proxyDispatchers = new Map();
    #closedError;
    constructor(env, proxyCa) {
        super();
        this.#env = env;
        this.#proxyCa = proxyCa;
    }
    dispatch(options, handler) {
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
    close(callback) {
        const closing = this.#closeAll();
        if (callback === undefined) {
            return closing;
        }
        closing.then(callback, callback);
    }
    destroy(errorOrCallback, callback) {
        const error = typeof errorOrCallback === "function" ? null : errorOrCallback ?? null;
        const destroyCallback = typeof errorOrCallback === "function" ? errorOrCallback : callback;
        const destroying = this.#destroyAll(error);
        if (destroyCallback === undefined) {
            return destroying;
        }
        destroying.then(destroyCallback, destroyCallback);
    }
    #proxyDispatcher(proxyUrl) {
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
    async #closeAll() {
        this.#closedError ??= new undiciErrors.ClientClosedError();
        const proxyDispatchers = [...this.#proxyDispatchers.values()];
        this.#proxyDispatchers.clear();
        await Promise.all([
            this.#directDispatcher.close(),
            ...proxyDispatchers.map((dispatcher) => dispatcher.close()),
        ]);
    }
    async #destroyAll(error) {
        this.#closedError ??= error ?? new undiciErrors.ClientDestroyedError();
        const proxyDispatchers = [...this.#proxyDispatchers.values()];
        this.#proxyDispatchers.clear();
        await Promise.all([
            this.#directDispatcher.destroy(error),
            ...proxyDispatchers.map((dispatcher) => dispatcher.destroy(error)),
        ]);
    }
}
function resolveUndiciDispatchUrl(options) {
    if (options.origin !== undefined) {
        return new URL(options.path, options.origin).href;
    }
    try {
        return new URL(options.path).href;
    }
    catch {
        return undefined;
    }
}
function restoreNodeHttpSnapshot(snapshot) {
    http.request = snapshot.httpRequest;
    http.get = snapshot.httpGet;
    http.globalAgent = snapshot.httpGlobalAgent;
    https.request = snapshot.httpsRequest;
    https.get = snapshot.httpsGet;
    https.globalAgent = snapshot.httpsGlobalAgent;
}
function installRuntime(resolver, dispatcherOptions, proxyCa) {
    if (activeRuntime !== undefined) {
        throw new ProxylineError("RUNTIME_ALREADY_ACTIVE", "Proxyline already has an active runtime.");
    }
    const snapshot = {
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
    const installedDispatcher = createUndiciProxyDispatcher(dispatcherOptions, proxyCa);
    const runtime = {
        installedDispatcher,
        nodeAgent,
        originalDispatcher,
        originalFetch,
        snapshot,
    };
    activeRuntime = runtime;
    try {
        http.globalAgent = nodeAgent;
        https.globalAgent = nodeAgent;
        http.request = bindNodeHttpMethod(snapshot.httpRequest, () => createNodeProxyAgent(resolver, proxyCa));
        http.get = bindNodeHttpMethod(snapshot.httpGet, () => createNodeProxyAgent(resolver, proxyCa));
        https.request = bindNodeHttpMethod(snapshot.httpsRequest, () => createNodeProxyAgent(resolver, proxyCa));
        https.get = bindNodeHttpMethod(snapshot.httpsGet, () => createNodeProxyAgent(resolver, proxyCa));
        setGlobalDispatcher(installedDispatcher);
        globalThis.fetch = proxylineFetch;
    }
    catch (error) {
        restoreNodeHttpSnapshot(snapshot);
        setGlobalDispatcher(originalDispatcher);
        globalThis.fetch = originalFetch;
        activeRuntime = undefined;
        void installedDispatcher.destroy();
        nodeAgent.destroy();
        throw error;
    }
    return runtime;
}
function stopRuntime(runtime) {
    if (activeRuntime !== runtime) {
        return;
    }
    restoreNodeHttpSnapshot(runtime.snapshot);
    setGlobalDispatcher(runtime.originalDispatcher);
    globalThis.fetch = runtime.originalFetch;
    void runtime.installedDispatcher.destroy();
    runtime.nodeAgent.destroy();
    activeRuntime = undefined;
}
export function installProxyline(options) {
    const proxyUrl = options.mode === "managed" ? normalizeProxyUrl(options.proxyUrl) : undefined;
    if (options.mode === "managed" && proxyUrl === undefined) {
        throw new ProxylineError("MANAGED_PROXY_URL_REQUIRED", "Proxyline managed mode requires an explicit proxyUrl.");
    }
    let stopped = false;
    const proxyCa = resolveProxyTlsCa(options.proxyTls);
    const ambientEnv = proxyUrl === undefined ? readProxyEnv() : undefined;
    const resolver = proxyUrl !== undefined
        ? createManagedProxyResolver(proxyUrl)
        : createAmbientProxyResolver(ambientEnv ?? EMPTY_PROXY_ENV);
    const redactedProxyUrl = resolver.describeProxy();
    const hasActiveProxy = resolver.active;
    const runtime = hasActiveProxy
        ? installRuntime(resolver, proxyUrl !== undefined
            ? { mode: "managed", proxyUrl: proxyUrl.href }
            : { mode: "ambient", env: ambientEnv ?? EMPTY_PROXY_ENV, active: hasActiveProxy }, proxyCa)
        : undefined;
    emit(options.onEvent, {
        type: "runtime.installed",
        mode: options.mode,
        active: hasActiveProxy,
        ...(redactedProxyUrl ? { proxyUrl: redactedProxyUrl } : {}),
    });
    const handle = {
        mode: options.mode,
        active: hasActiveProxy,
        ...(redactedProxyUrl ? { proxyUrl: redactedProxyUrl } : {}),
        createNodeAgent: () => {
            if (!hasActiveProxy || stopped) {
                return createDirectNodeAgent();
            }
            return createNodeProxyAgent(resolver, proxyCa);
        },
        createUndiciDispatcher: () => stopped
            ? new UndiciAgent()
            : createUndiciProxyDispatcher(proxyUrl !== undefined
                ? { mode: "managed", proxyUrl: proxyUrl.href }
                : { mode: "ambient", env: ambientEnv ?? EMPTY_PROXY_ENV, active: hasActiveProxy }, proxyCa),
        createWebSocketAgent: () => {
            if (!hasActiveProxy || stopped) {
                return createDirectNodeAgent();
            }
            return createNodeProxyAgent(resolver, proxyCa);
        },
        explain: (url, explainOptions) => {
            const decision = stopped
                ? {
                    kind: "direct",
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
