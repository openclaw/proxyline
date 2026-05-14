export { openProxyConnectTunnel, type OpenProxyConnectTunnelOptions } from "./connect.js";
export {
  createAmbientNodeProxyAgent,
  hasAmbientNodeProxyConfigured,
  type AmbientNodeProxyAgentOptions,
} from "./node-http.js";
export { installGlobalProxy, installProxyline } from "./runtime.js";
export {
  ProxylineError,
  redactProxyUrl,
  resolveProxyTlsCa,
  type ProxylineTlsOptions,
} from "./shared.js";
export type {
  ExplainOptions,
  ProxylineBypassPolicy,
  ProxylineBypassRequest,
  ProxylineDecision,
  ProxylineEvent,
  ProxylineHandle,
  ProxylineMode,
  ProxylineOptions,
  ProxylineSurface,
} from "./types.js";
