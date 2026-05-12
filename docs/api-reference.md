# API Reference

Every public export, with the exact shape from `src/index.ts` and `src/connect.ts`.

## Functions

### `installProxyline(options): ProxylineHandle`

Aliased as `installGlobalProxy`. Installs the runtime and returns a handle.

- Throws `ProxylineError` with code `MANAGED_PROXY_URL_REQUIRED` if `mode: "managed"` is used without a `proxyUrl`.
- Throws `ProxylineError` with code `UNSUPPORTED_PROXY_PROTOCOL` if managed-mode `proxyUrl` is not `http://` or `https://`.
- Throws `ProxylineError` with code `RUNTIME_ALREADY_ACTIVE` if another Proxyline runtime is already installed in the same process.

In managed mode (and active ambient mode), `installProxyline`:

- Captures originals for `http.request`, `http.get`, `http.globalAgent`, `https.request`, `https.get`, `https.globalAgent`.
- Captures the current undici global dispatcher and fetch globals.
- Installs patched `http.request`/`get`, `https.request`/`get`.
- Replaces `http.globalAgent` and `https.globalAgent` with a `proxy-agent` `ProxyAgent`.
- Calls `undici.setGlobalDispatcher` with a `ProxyAgent` (managed) or Proxyline's ambient dispatcher (ambient), and patches `globalThis.fetch` plus `Request`, `Response`, `Headers`, and `FormData` to use that dispatcher-compatible fetch stack.
- Emits `runtime.installed`.

In inactive ambient mode (no supported proxy env variables), no patches are installed; the handle returns a passive observer with `active: false`.

### `openProxyConnectTunnel(options): Promise<net.Socket | tls.TLSSocket>`

Opens a one-shot HTTP CONNECT tunnel through a proxy. See [Surfaces — HTTP CONNECT tunnel](./surfaces.md#http-connect-tunnel).

### `redactProxyUrl(value: string | URL): string`

Strips userinfo, search, and fragment from a URL. Used internally to keep events and decisions free of credentials. Safe to use on log lines you build yourself.

```ts
redactProxyUrl("https://user:secret@proxy.example:8443/path?q=1#frag");
// → "https://proxy.example:8443/path"
```

### `resolveProxyTlsCa(options): string | undefined`

Resolves a `ProxylineTlsOptions` value to a PEM string by reading `caFile` from disk if needed. Returns `undefined` when no CA material is supplied. Exposed so callers can pre-resolve before passing values into their own TLS-using code.

## Classes

### `ProxylineError extends Error`

```ts
class ProxylineError extends Error {
  readonly code: string;
  readonly name: "ProxylineError";
}
```

Codes:

- `MANAGED_PROXY_URL_REQUIRED` — `mode: "managed"` was used without `proxyUrl`.
- `UNSUPPORTED_PROXY_PROTOCOL` — proxy URL scheme is not `http://` or `https://`.
- `RUNTIME_ALREADY_ACTIVE` — another Proxyline runtime is already installed.
- `CONNECT_FAILED` — `openProxyConnectTunnel` failed (bad response, timeout, header overrun, or socket error).
- `INVALID_CONNECT_TARGET` — `openProxyConnectTunnel` received an empty or unsafe target host, invalid bracket syntax, or an invalid target port.

## Types

### `ProxylineMode`

```ts
type ProxylineMode = "managed" | "ambient";
```

See [Modes](./modes.md).

### `ProxylineSurface`

```ts
type ProxylineSurface =
  | "node-http"
  | "node-https"
  | "undici"
  | "websocket"
  | "connect"
  | "unknown";
```

Used in `explain()` decisions and event payloads to identify which network surface a decision is for. Pass it via `explain(url, { surface })`.

### `ProxylineOptions`

```ts
type ProxylineOptions = Readonly<{
  mode: ProxylineMode;
  proxyUrl?: string | URL;
  proxyTls?: ProxylineTlsOptions;
  onEvent?: (event: ProxylineEvent) => void;
}>;
```

- `mode` — required. `"managed"` or `"ambient"`.
- `proxyUrl` — required in managed mode, ignored in ambient mode. Managed-mode URLs must be `http://` or `https://`.
- `proxyTls` — CA trust scoped to the proxy endpoint. See [Proxy TLS](./proxy-tls.md).
- `onEvent` — callback fired with every `ProxylineEvent`.

### `ProxylineTlsOptions`

```ts
type ProxylineTlsOptions = Readonly<{
  ca?: string;     // PEM string
  caFile?: string; // path read with fs.readFileSync(..., "utf8")
}>;
```

When both are provided, `ca` wins.

### `ProxylineDecision`

```ts
type ProxylineDecision = Readonly<{
  kind: "proxied" | "direct" | "blocked";
  reason: string;
  surface: ProxylineSurface;
  url: string;
  proxyUrl?: string; // redacted
}>;
```

Known `reason` values:

- `"managed-proxy-active"` — managed mode applied.
- `"ambient-proxy-active"` — ambient mode resolved a proxy from env.
- `"ambient-proxy-not-configured"` — ambient mode has no proxy env set, or the URL scheme is unsupported.
- `"no-proxy-match"` — the URL matched `NO_PROXY`.
- `"runtime-stopped"` — `explain()` was called after `stop()`.

`kind: "blocked"` is reserved for future explicit deny rules; the current implementation does not produce blocked decisions.

### `ProxylineEvent`

```ts
type ProxylineEvent =
  | Readonly<{ type: "runtime.installed"; mode: ProxylineMode; active: boolean; proxyUrl?: string }>
  | Readonly<{ type: "runtime.stopped"; mode: ProxylineMode }>
  | Readonly<{ type: "decision"; decision: ProxylineDecision }>
  | Readonly<{ type: "warning"; code: string; message: string }>;
```

`decision` events fire from inside `explain()`. `runtime.installed` and `runtime.stopped` fire from `installProxyline` and `handle.stop()` respectively. `warning` is reserved for future runtime diagnostics.

### `ExplainOptions`

```ts
type ExplainOptions = Readonly<{
  surface?: ProxylineSurface;
}>;
```

### `ProxylineHandle`

```ts
type ProxylineHandle = Readonly<{
  mode: ProxylineMode;
  active: boolean;
  proxyUrl?: string;
  createNodeAgent: () => http.Agent;
  createUndiciDispatcher: () => Dispatcher;
  createWebSocketAgent: () => http.Agent;
  explain: (url: string | URL, options?: ExplainOptions) => ProxylineDecision;
  stop: () => void;
}>;
```

- `mode` — the mode this handle was installed with.
- `active` — `true` when the runtime is installed and forcing/respecting a proxy.
- `proxyUrl` — redacted proxy URL string when active.
- `createNodeAgent()` — proxy-aware `http.Agent` for ad-hoc node:http(s) use. Returns a direct agent when inactive or after `stop()`.
- `createUndiciDispatcher()` — proxy-aware undici `Dispatcher`. Returns a direct `UndiciAgent()` when ambient-inactive or after `stop()`.
- `createWebSocketAgent()` — same as `createNodeAgent()` but typed for WebSocket clients.
- `explain(url, options?)` — returns a `ProxylineDecision` and emits a `decision` event.
- `stop()` — restores the captured Node HTTP(S) stack, undici dispatcher, and fetch globals, destroys Proxyline-owned runtime agents/dispatchers, emits `runtime.stopped`. Idempotent.

### `OpenProxyConnectTunnelOptions`

```ts
type OpenProxyConnectTunnelOptions = Readonly<{
  proxyUrl: string | URL;
  proxyTls?: ProxylineTlsOptions;
  targetHost: string;
  targetPort: number;
  timeoutMs?: number;
}>;
```

- `proxyUrl` — `http://` or `https://`. Userinfo becomes a `Proxy-Authorization: Basic` header.
- `proxyTls` — CA trust for HTTPS proxies. See [Proxy TLS](./proxy-tls.md).
- `targetHost` / `targetPort` — what to ask the proxy to connect to.
- `timeoutMs` — overall budget for the CONNECT handshake.
