import type { ProxyResolver } from "./types.js";
export type ProxyEnvKey = "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY" | "NO_PROXY" | "http_proxy" | "https_proxy" | "all_proxy" | "no_proxy";
type LowerProxyEnvKey = "http_proxy" | "https_proxy" | "all_proxy" | "no_proxy";
export type ProxyEnvSnapshot = Readonly<Record<ProxyEnvKey, string | undefined>>;
export declare const EMPTY_PROXY_ENV: ProxyEnvSnapshot;
export declare function readProxyEnv(): ProxyEnvSnapshot;
export declare function readProxyEnvValue(env: ProxyEnvSnapshot, key: LowerProxyEnvKey): string | undefined;
export declare function proxyUrlWithDefaultScheme(proxyUrl: string): string;
export declare function resolveAmbientProxyForUrl(url: string | URL, env: ProxyEnvSnapshot): string | undefined;
export declare function createAmbientProxyResolver(env: ProxyEnvSnapshot): ProxyResolver;
export {};
//# sourceMappingURL=env.d.ts.map