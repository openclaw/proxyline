export type ProxylineMode = "managed" | "ambient";

export type ProxylineSurface =
  | "node-http"
  | "node-https"
  | "undici"
  | "websocket"
  | "connect"
  | "unknown";

export type ProxylineTlsOptions = Readonly<{
  ca?: string;
  caFile?: string;
}>;

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
  explain: (url: string | URL, options?: ExplainOptions) => ProxylineDecision;
  stop: () => void;
}>;

export class ProxylineError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ProxylineError";
    this.code = code;
  }
}

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

export function redactProxyUrl(value: string | URL): string {
  const url = value instanceof URL ? new URL(value.href) : new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}

function emit(onEvent: ProxylineOptions["onEvent"], event: ProxylineEvent): void {
  onEvent?.(event);
}

function formatUrl(value: string | URL): string {
  return value instanceof URL ? value.href : new URL(value).href;
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
  const redactedProxyUrl = proxyUrl ? redactProxyUrl(proxyUrl) : undefined;
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
      emit(options.onEvent, { type: "runtime.stopped", mode: options.mode });
    },
  };

  return handle;
}

export const installGlobalProxy = installProxyline;
