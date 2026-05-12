import { formatUrl, redactProxyUrl } from "./shared.js";
import type { ProxyResolver } from "./types.js";

export type ProxyEnvKey =
  | "HTTP_PROXY"
  | "HTTPS_PROXY"
  | "ALL_PROXY"
  | "NO_PROXY"
  | "http_proxy"
  | "https_proxy"
  | "all_proxy"
  | "no_proxy";

type LowerProxyEnvKey = "http_proxy" | "https_proxy" | "all_proxy" | "no_proxy";

export type ProxyEnvSnapshot = Readonly<Record<ProxyEnvKey, string | undefined>>;

export const EMPTY_PROXY_ENV: ProxyEnvSnapshot = {
  HTTP_PROXY: undefined,
  HTTPS_PROXY: undefined,
  ALL_PROXY: undefined,
  NO_PROXY: undefined,
  http_proxy: undefined,
  https_proxy: undefined,
  all_proxy: undefined,
  no_proxy: undefined,
};

export function readProxyEnv(): ProxyEnvSnapshot {
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

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function upperProxyEnvKey(key: LowerProxyEnvKey): ProxyEnvKey {
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

export function readProxyEnvValue(
  env: ProxyEnvSnapshot,
  key: LowerProxyEnvKey,
): string | undefined {
  return normalizeEnvValue(env[key]) ?? normalizeEnvValue(env[upperProxyEnvKey(key)]);
}

export function proxyUrlWithDefaultScheme(proxyUrl: string): string {
  return proxyUrl.includes("://") ? proxyUrl : `http://${proxyUrl}`;
}

function normalizeAmbientProxyUrl(proxyUrl: string | undefined): string | undefined {
  if (proxyUrl === undefined) {
    return undefined;
  }
  try {
    const url = new URL(proxyUrlWithDefaultScheme(proxyUrl));
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function defaultPort(protocol: string): number {
  if (protocol === "http:" || protocol === "ws:") {
    return 80;
  }
  if (protocol === "https:" || protocol === "wss:") {
    return 443;
  }
  return 0;
}

function matchesNoProxy(url: URL, env: ProxyEnvSnapshot): boolean {
  const rawNoProxy = readProxyEnvValue(env, "no_proxy")?.toLowerCase();
  if (!rawNoProxy) {
    return false;
  }
  if (rawNoProxy === "*") {
    return true;
  }

  const hostname = normalizeNoProxyHost(url.hostname);
  const port = Number.parseInt(url.port, 10) || defaultPort(url.protocol);
  for (const rawEntry of rawNoProxy.split(/[,\s]/)) {
    if (!rawEntry) {
      continue;
    }
    const { host: parsedHost, port: entryPort } = parseNoProxyEntry(rawEntry);
    let entryHost = normalizeNoProxyHost(parsedHost);
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
    if (
      entryHost.startsWith(".") &&
      (hostname === entryHost.slice(1) || hostname.endsWith(entryHost))
    ) {
      return true;
    }
    if (!entryHost.startsWith(".") && hostname.endsWith(entryHost)) {
      return true;
    }
  }
  return false;
}

function normalizeNoProxyHost(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.+$/, "");
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

function parseNoProxyEntry(entry: string): { host: string; port: number } {
  const bracketedIpv6 = entry.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketedIpv6) {
    return {
      host: bracketedIpv6[1] ?? "",
      port: bracketedIpv6[2] ? Number.parseInt(bracketedIpv6[2], 10) : 0,
    };
  }

  const lastColon = entry.lastIndexOf(":");
  const hasSingleColon = lastColon !== -1 && entry.indexOf(":") === lastColon;
  if (hasSingleColon) {
    const possiblePort = entry.slice(lastColon + 1);
    if (/^\d+$/.test(possiblePort)) {
      return {
        host: entry.slice(0, lastColon),
        port: Number.parseInt(possiblePort, 10),
      };
    }
  }

  return { host: entry, port: 0 };
}

function proxyEnvKeyForProtocol(protocol: string): LowerProxyEnvKey | undefined {
  if (protocol === "http:" || protocol === "ws:") {
    return "http_proxy";
  }
  if (protocol === "https:" || protocol === "wss:") {
    return "https_proxy";
  }
  return undefined;
}

function supportsProxyForUrlProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:" || protocol === "ws:" || protocol === "wss:";
}

function resolveAmbientProxyEnvValue(
  env: ProxyEnvSnapshot,
  key: LowerProxyEnvKey,
): string | undefined {
  return normalizeAmbientProxyUrl(readProxyEnvValue(env, key));
}

export function resolveAmbientProxyForUrl(
  url: string | URL,
  env: ProxyEnvSnapshot,
): string | undefined {
  let parsedUrl: URL;
  try {
    parsedUrl = url instanceof URL ? new URL(url.href) : new URL(url);
  } catch {
    return undefined;
  }
  const protocol = parsedUrl.protocol;
  if (!supportsProxyForUrlProtocol(protocol)) {
    return undefined;
  }
  if (matchesNoProxy(parsedUrl, env)) {
    return undefined;
  }
  const protocolProxyKey = proxyEnvKeyForProtocol(protocol);
  if (protocolProxyKey === undefined) {
    return undefined;
  }
  return (
    resolveAmbientProxyEnvValue(env, protocolProxyKey) ??
    resolveAmbientProxyEnvValue(env, "all_proxy")
  );
}

export function createAmbientProxyResolver(env: ProxyEnvSnapshot): ProxyResolver {
  const configuredProxy =
    resolveAmbientProxyEnvValue(env, "http_proxy") ??
    resolveAmbientProxyEnvValue(env, "https_proxy") ??
    resolveAmbientProxyEnvValue(env, "all_proxy");
  return {
    active: configuredProxy !== undefined,
    describeProxy: () =>
      configuredProxy
        ? redactProxyUrl(proxyUrlWithDefaultScheme(configuredProxy))
        : undefined,
    explain: (url, surface) => {
      const formattedUrl = formatUrl(url);
      const parsedUrl = new URL(formattedUrl);
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
        reason: supportsProxyForUrlProtocol(parsedUrl.protocol) && matchesNoProxy(parsedUrl, env)
          ? "no-proxy-match"
          : "ambient-proxy-not-configured",
        surface,
        url: formattedUrl,
      };
    },
    getProxyForUrl: (url) => resolveAmbientProxyForUrl(url, env) ?? "",
  };
}
