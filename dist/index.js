import http from "node:http";
import https from "node:https";
import net from "node:net";
import { ProxyAgent as NodeProxyAgent } from "proxy-agent";
import { Agent as UndiciAgent, EnvHttpProxyAgent, getGlobalDispatcher, ProxyAgent as UndiciProxyAgent, setGlobalDispatcher, } from "undici";
import { ProxylineError, redactProxyUrl, resolveProxyTlsCa, } from "./shared.js";
export { ProxylineError, redactProxyUrl, resolveProxyTlsCa, } from "./shared.js";
export { openProxyConnectTunnel } from "./connect.js";
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
function formatUrl(value) {
    return value instanceof URL ? value.href : new URL(value).href;
}
const CALLER_AGENT_TLS_OPTION_KEYS = [
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
];
let activeRuntime;
const EMPTY_PROXY_ENV = {
    HTTP_PROXY: undefined,
    HTTPS_PROXY: undefined,
    ALL_PROXY: undefined,
    NO_PROXY: undefined,
    http_proxy: undefined,
    https_proxy: undefined,
    all_proxy: undefined,
    no_proxy: undefined,
};
function copyNodeHttpOptions(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return {};
    }
    return { ...value };
}
function readAgentOptions(agent) {
    if (agent === undefined || agent === false) {
        return undefined;
    }
    return agent.options;
}
function preserveCallerAgentOptions(options) {
    const agentOptions = readAgentOptions(options.agent);
    if (agentOptions === undefined) {
        return;
    }
    for (const key of CALLER_AGENT_TLS_OPTION_KEYS) {
        const value = agentOptions[key];
        if (value !== undefined && options[key] === undefined) {
            options[key] = value;
        }
    }
}
function inferDestinationHostname(url, options) {
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
function preserveDestinationTlsIdentity(url, options) {
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
function bindNodeHttpMethod(originalMethod, createAgent) {
    return ((...args) => {
        let url;
        let options;
        let callback;
        const firstArg = args[0];
        if (typeof firstArg === "string" || firstArg instanceof URL) {
            url = firstArg;
            if (typeof args[1] === "function") {
                options = {};
                callback = args[1];
            }
            else {
                options = copyNodeHttpOptions(args[1]);
                callback = args[2];
            }
        }
        else {
            options = copyNodeHttpOptions(firstArg);
            callback = args[1];
        }
        preserveCallerAgentOptions(options);
        preserveDestinationTlsIdentity(url, options);
        const agent = createAgent(options);
        options.agent = agent;
        delete options.createConnection;
        if (url !== undefined) {
            const request = originalMethod(url, options, callback);
            request.once("close", () => {
                agent.destroy();
            });
            return request;
        }
        const request = originalMethod(options, callback);
        request.once("close", () => {
            agent.destroy();
        });
        return request;
    });
}
function readProxyEnv() {
    return {
        HTTP_PROXY: process.env.HTTP_PROXY,
        HTTPS_PROXY: process.env.HTTPS_PROXY,
        ALL_PROXY: process.env.ALL_PROXY,
        NO_PROXY: process.env.NO_PROXY,
        http_proxy: process.env.http_proxy,
        https_proxy: process.env.https_proxy,
        all_proxy: process.env.all_proxy,
        no_proxy: process.env.no_proxy,
    };
}
function normalizeEnvValue(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
function upperProxyEnvKey(key) {
    switch (key) {
        case "http_proxy":
            return "HTTP_PROXY";
        case "https_proxy":
            return "HTTPS_PROXY";
        case "all_proxy":
            return "ALL_PROXY";
        case "no_proxy":
            return "NO_PROXY";
    }
}
function readProxyEnvValue(env, key) {
    return normalizeEnvValue(env[key]) ?? normalizeEnvValue(env[upperProxyEnvKey(key)]);
}
function proxyUrlWithDefaultScheme(proxyUrl, protocol) {
    return proxyUrl.includes("://") ? proxyUrl : `${protocol}://${proxyUrl}`;
}
function defaultPort(protocol) {
    if (protocol === "http:" || protocol === "ws:") {
        return 80;
    }
    if (protocol === "https:" || protocol === "wss:") {
        return 443;
    }
    return 0;
}
function matchesNoProxy(url, env) {
    const rawNoProxy = readProxyEnvValue(env, "no_proxy")?.toLowerCase();
    if (!rawNoProxy) {
        return false;
    }
    if (rawNoProxy === "*") {
        return true;
    }
    const hostname = url.host.replace(/:\d*$/, "").toLowerCase();
    const port = Number.parseInt(url.port, 10) || defaultPort(url.protocol);
    for (const rawEntry of rawNoProxy.split(/[,\s]/)) {
        if (!rawEntry) {
            continue;
        }
        const parsedEntry = rawEntry.match(/^(.+):(\d+)$/);
        let entryHost = parsedEntry?.[1] ?? rawEntry;
        const entryPort = parsedEntry?.[2] ? Number.parseInt(parsedEntry[2], 10) : 0;
        if (entryPort && entryPort !== port) {
            continue;
        }
        if (!/^[.*]/.test(entryHost)) {
            if (hostname === entryHost) {
                return true;
            }
            continue;
        }
        if (entryHost.startsWith("*")) {
            entryHost = entryHost.slice(1);
        }
        if (hostname.endsWith(entryHost)) {
            return true;
        }
    }
    return false;
}
function proxyEnvKeyForProtocol(protocol) {
    if (protocol === "http:" || protocol === "ws:") {
        return "http_proxy";
    }
    if (protocol === "https:" || protocol === "wss:") {
        return "https_proxy";
    }
    return undefined;
}
function resolveAmbientProxyForUrl(url, env) {
    let parsedUrl;
    try {
        parsedUrl = url instanceof URL ? new URL(url.href) : new URL(url);
    }
    catch {
        return undefined;
    }
    const protocol = parsedUrl.protocol;
    if (protocol !== "http:" &&
        protocol !== "https:" &&
        protocol !== "ws:" &&
        protocol !== "wss:") {
        return undefined;
    }
    if (matchesNoProxy(parsedUrl, env)) {
        return undefined;
    }
    const protocolProxyKey = proxyEnvKeyForProtocol(protocol);
    if (protocolProxyKey === undefined) {
        return undefined;
    }
    const proxy = readProxyEnvValue(env, protocolProxyKey) ?? readProxyEnvValue(env, "all_proxy");
    return proxy ? proxyUrlWithDefaultScheme(proxy, protocol.slice(0, -1)) : undefined;
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
function createAmbientProxyResolver(env) {
    const configuredProxy = readProxyEnvValue(env, "http_proxy") ??
        readProxyEnvValue(env, "https_proxy") ??
        readProxyEnvValue(env, "all_proxy");
    return {
        active: configuredProxy !== undefined,
        describeProxy: () => configuredProxy
            ? redactProxyUrl(proxyUrlWithDefaultScheme(configuredProxy, "http"))
            : undefined,
        explain: (url, surface) => {
            const formattedUrl = formatUrl(url);
            const proxyUrl = resolveAmbientProxyForUrl(formattedUrl, env);
            if (proxyUrl !== undefined) {
                return {
                    kind: "proxied",
                    reason: "ambient-proxy-active",
                    surface,
                    url: formattedUrl,
                    proxyUrl: redactProxyUrl(proxyUrl),
                };
            }
            return {
                kind: "direct",
                reason: matchesNoProxy(new URL(formattedUrl), env)
                    ? "no-proxy-match"
                    : "ambient-proxy-not-configured",
                surface,
                url: formattedUrl,
            };
        },
        getProxyForUrl: (url) => resolveAmbientProxyForUrl(url, env) ?? "",
    };
}
function createNodeProxyAgent(resolver, proxyCa, options) {
    return new NodeProxyAgent({
        ...(proxyCa !== undefined ? { ca: proxyCa } : {}),
        ...(options?.cert !== undefined ? { cert: options.cert } : {}),
        ...(options?.ciphers !== undefined ? { ciphers: options.ciphers } : {}),
        ...(options?.clientCertEngine !== undefined ? { clientCertEngine: options.clientCertEngine } : {}),
        ...(options?.crl !== undefined ? { crl: options.crl } : {}),
        ...(options?.dhparam !== undefined ? { dhparam: options.dhparam } : {}),
        ...(options?.ecdhCurve !== undefined ? { ecdhCurve: options.ecdhCurve } : {}),
        ...(options?.honorCipherOrder !== undefined ? { honorCipherOrder: options.honorCipherOrder } : {}),
        ...(options?.key !== undefined ? { key: options.key } : {}),
        ...(options?.maxVersion !== undefined ? { maxVersion: options.maxVersion } : {}),
        ...(options?.minVersion !== undefined ? { minVersion: options.minVersion } : {}),
        ...(options?.passphrase !== undefined ? { passphrase: options.passphrase } : {}),
        ...(options?.pfx !== undefined ? { pfx: options.pfx } : {}),
        ...(options?.rejectUnauthorized !== undefined ? { rejectUnauthorized: options.rejectUnauthorized } : {}),
        ...(options?.secureOptions !== undefined ? { secureOptions: options.secureOptions } : {}),
        ...(options?.secureProtocol !== undefined ? { secureProtocol: options.secureProtocol } : {}),
        ...(options?.servername !== undefined ? { servername: options.servername } : {}),
        ...(options?.sessionIdContext !== undefined ? { sessionIdContext: options.sessionIdContext } : {}),
        getProxyForUrl: resolver.getProxyForUrl,
        httpAgent: new http.Agent(),
        httpsAgent: new https.Agent(),
    });
}
function createUndiciProxyDispatcher(options, proxyCa) {
    if (options.mode === "ambient") {
        if (!options.active) {
            return new UndiciAgent();
        }
        const rawHttpProxy = readProxyEnvValue(options.env, "http_proxy") ?? readProxyEnvValue(options.env, "all_proxy");
        const rawHttpsProxy = readProxyEnvValue(options.env, "https_proxy") ??
            readProxyEnvValue(options.env, "all_proxy");
        const noProxy = readProxyEnvValue(options.env, "no_proxy");
        return new EnvHttpProxyAgent({
            ...(rawHttpProxy !== undefined
                ? { httpProxy: proxyUrlWithDefaultScheme(rawHttpProxy, "http") }
                : {}),
            ...(rawHttpsProxy !== undefined
                ? { httpsProxy: proxyUrlWithDefaultScheme(rawHttpsProxy, "https") }
                : {}),
            ...(noProxy !== undefined ? { noProxy } : {}),
            ...(proxyCa !== undefined ? { proxyTls: { ca: proxyCa } } : {}),
        });
    }
    return new UndiciProxyAgent({
        uri: options.proxyUrl,
        ...(proxyCa !== undefined ? { proxyTls: { ca: proxyCa } } : {}),
    });
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
    const runtime = {
        nodeAgent,
        originalDispatcher,
        snapshot,
    };
    activeRuntime = runtime;
    try {
        http.globalAgent = nodeAgent;
        https.globalAgent = nodeAgent;
        http.request = bindNodeHttpMethod(snapshot.httpRequest, (options) => createNodeProxyAgent(resolver, proxyCa, options));
        http.get = bindNodeHttpMethod(snapshot.httpGet, (options) => createNodeProxyAgent(resolver, proxyCa, options));
        https.request = bindNodeHttpMethod(snapshot.httpsRequest, (options) => createNodeProxyAgent(resolver, proxyCa, options));
        https.get = bindNodeHttpMethod(snapshot.httpsGet, (options) => createNodeProxyAgent(resolver, proxyCa, options));
        setGlobalDispatcher(createUndiciProxyDispatcher(dispatcherOptions, proxyCa));
    }
    catch (error) {
        activeRuntime = undefined;
        nodeAgent.destroy();
        throw error;
    }
    return runtime;
}
function stopRuntime(runtime) {
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
export function installProxyline(options) {
    const proxyUrl = normalizeProxyUrl(options.proxyUrl);
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
            if (!hasActiveProxy) {
                return new http.Agent();
            }
            return createNodeProxyAgent(resolver, proxyCa);
        },
        createUndiciDispatcher: () => createUndiciProxyDispatcher(proxyUrl !== undefined
            ? { mode: "managed", proxyUrl: proxyUrl.href }
            : { mode: "ambient", env: ambientEnv ?? EMPTY_PROXY_ENV, active: hasActiveProxy }, proxyCa),
        createWebSocketAgent: () => {
            if (!hasActiveProxy) {
                return new http.Agent();
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
