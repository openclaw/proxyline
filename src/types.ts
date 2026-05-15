import type { Agent as HttpAgent } from "node:http";
import type { Dispatcher } from "undici";
import type { ProxylineTlsOptions } from "./shared.js";

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
  bypassPolicy?: ProxylineBypassPolicy;
  ifActive?: "error" | "reuse-compatible" | "replace";
  onEvent?: (event: ProxylineEvent) => void;
  undici?: ProxylineUndiciOptions;
}>;

export type ProxylineDecision = Readonly<{
  kind: "proxied" | "direct" | "blocked";
  reason: string;
  surface: ProxylineSurface;
  url: string;
  proxyUrl?: string;
}>;

export type ProxylineBypassRequest = Readonly<{
  surface: ProxylineSurface;
  url: string;
}>;

export type ProxylineBypassPolicy = (request: ProxylineBypassRequest) => boolean;

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

export type ProxylineBypassRegistration = Readonly<{
  surface?: ProxylineSurface;
  url: string | URL;
}>;

export type ProxylineUndiciOptions = Readonly<{
  allowH2?: boolean;
  bodyTimeout?: number;
  headersTimeout?: number;
  connect?: Readonly<{
    autoSelectFamily?: boolean;
    autoSelectFamilyAttemptTimeout?: number;
  }>;
}>;

export type ProxylineHandle = Readonly<{
  mode: ProxylineMode;
  active: boolean;
  proxyUrl?: string;
  createNodeAgent: () => HttpAgent;
  createUndiciDispatcher: () => Dispatcher;
  createWebSocketAgent: () => HttpAgent;
  explain: (url: string | URL, options?: ExplainOptions) => ProxylineDecision;
  registerBypass: (registration: ProxylineBypassRegistration) => () => void;
  stop: () => void;
  withBypass: <T>(registration: ProxylineBypassRegistration, run: () => T) => T;
}>;

export type ProxyResolver = Readonly<{
  active: boolean;
  describeProxy: () => string | undefined;
  explain: (url: string | URL, surface: ProxylineSurface) => ProxylineDecision;
  getProxyForUrl: (url: string, surface?: ProxylineSurface) => string;
}>;
