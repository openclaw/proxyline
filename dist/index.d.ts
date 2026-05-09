import http from "node:http";
import { type Dispatcher } from "undici";
import { type ProxylineTlsOptions } from "./shared.js";
export { ProxylineError, redactProxyUrl, resolveProxyTlsCa, type ProxylineTlsOptions, } from "./shared.js";
export { openProxyConnectTunnel, type OpenProxyConnectTunnelOptions } from "./connect.js";
export type ProxylineMode = "managed" | "ambient";
export type ProxylineSurface = "node-http" | "node-https" | "undici" | "websocket" | "connect" | "unknown";
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
export type ProxylineEvent = Readonly<{
    type: "runtime.installed";
    mode: ProxylineMode;
    active: boolean;
    proxyUrl?: string;
}> | Readonly<{
    type: "runtime.stopped";
    mode: ProxylineMode;
}> | Readonly<{
    type: "decision";
    decision: ProxylineDecision;
}> | Readonly<{
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
export declare function installProxyline(options: ProxylineOptions): ProxylineHandle;
export declare const installGlobalProxy: typeof installProxyline;
//# sourceMappingURL=index.d.ts.map