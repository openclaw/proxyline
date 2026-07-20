# 🌐 Proxyline

![Proxyline banner](docs/assets/readme-banner.jpg)

[![npm](https://img.shields.io/npm/v/%40openclaw%2Fproxyline.svg)](https://www.npmjs.com/package/@openclaw/proxyline)
[![node](https://img.shields.io/node/v/%40openclaw%2Fproxyline.svg)](https://nodejs.org/)
[![license](https://img.shields.io/npm/l/%40openclaw%2Fproxyline.svg)](./LICENSE)

Process-global proxy routing for Node.js. One install replaces `node:http`, `node:https`, the undici/fetch global dispatcher, and provides WebSocket and explicit HTTP CONNECT helpers for the same policy.

Proxyline exists to make proxy behavior **explicit, observable, and hard to bypass accidentally** — so that "all egress goes through this gateway" is something you encode in code rather than hope for from environment variables.

Proxyline's runtime assurances assume it is installed before application and plugin networking code is loaded. Code that captured networking functions before installation, uses raw sockets, or owns a private/native transport stack is outside the normal Proxyline model.

Website: [proxyline.dev](https://proxyline.dev)

## Highlights

- **Two modes.** `managed` forces traffic through a configured proxy and fails closed on bad config. `ambient` reads `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` for tooling that needs environment compatibility.
- **Covers the surfaces that matter.** `http.request`, `http.get`, `https.request`, `https.get`, both global agents, the undici global dispatcher, and helpers for WebSocket agents and HTTP CONNECT sockets.
- **Replaces caller agents.** In managed mode and active ambient mode, a per-request `http.Agent` passed by a library does not bypass the proxy. TLS options on the caller agent (`ca`, `cert`, `key`, `rejectUnauthorized`, …) are preserved so destination TLS still validates.
- **Intentional bypasses only.** Managed mode can accept a `bypassPolicy` callback, process-wide `registerBypass()`, or async-scoped `withBypass()` calls for trusted loopback or control-plane traffic that must stay direct; every bypass is visible through `explain()`.
- **Embeddable runtime controls.** `ifActive` handles process singleton reuse/replacement, `undici` options tune dispatcher defaults, and `isProxylineDispatcher()` identifies Proxyline-owned dispatchers without constructor-name checks.
- **Scoped proxy CA trust.** `proxyTls.ca` / `proxyTls.caFile` trust a private CA for the proxy endpoint only — no `NODE_EXTRA_CA_CERTS` and no `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- **Observable.** `proxy.explain(url)` returns a structured decision (`proxied` / `direct` with a `reason`), and an `onEvent` callback receives `runtime.installed`, `runtime.stopped`, and per-decision events. Proxy URLs are credential-redacted.
- **Restoreable.** `proxy.stop()` restores the captured Node HTTP(S) methods, global agents, undici dispatcher, and fetch globals. The runtime is a process-wide singleton; by default a second active install throws `RUNTIME_ALREADY_ACTIVE`, while `ifActive` can reuse or replace intentionally.

## Install

```bash
pnpm add @openclaw/proxyline
# or
npm install @openclaw/proxyline
```

Requires Node 22.19.0+ and a host `undici` dependency compatible with `>=8.5.0 <9`.

## Quick start

### Managed mode

```ts
import { installGlobalProxy } from "@openclaw/proxyline";

const proxy = installGlobalProxy({
  mode: "managed",
  proxyUrl: "https://proxy.corp.example:8443",
  proxyTls: { caFile: "/etc/proxy-ca.pem" },
  onEvent: (event) => console.debug("[proxyline]", event),
});

console.log(proxy.explain("https://api.example.com/"));
```

### Ambient mode

```ts
import { installGlobalProxy } from "@openclaw/proxyline";

const proxy = installGlobalProxy({ mode: "ambient" });
if (!proxy.active) {
  console.warn("no HTTP_PROXY/HTTPS_PROXY/ALL_PROXY set — egress will be direct");
}
```

### WebSocket

```ts
import WebSocket from "ws";

const socket = new WebSocket("wss://events.example.com/", {
  agent: proxy.createWebSocketAgent(),
});
```

### Explicit HTTP CONNECT

```ts
import { openProxyConnectTunnel } from "@openclaw/proxyline";

const controller = new AbortController();
const socket = await openProxyConnectTunnel({
  proxyUrl: "https://proxy.corp.example:8443",
  proxyTls: { caFile: "/etc/proxy-ca.pem" },
  targetHost: "api.example.com",
  targetPort: 443,
  timeoutMs: 2_000,
  signal: controller.signal,
});
```

### Conditional Node agent

```ts
import { createAmbientNodeProxyAgent } from "@openclaw/proxyline";

const agent = createAmbientNodeProxyAgent({
  protocol: "https",
  proxyTls: { caFile: "/etc/proxy-ca.pem" },
});
```

The helper returns `undefined` when ambient proxy env is not configured, so callers can pass an agent only when needed.
It uses Proxyline's built-in HTTP/HTTPS Node agent, and `proxyTls` applies only to HTTPS proxy endpoints. SOCKS and PAC proxy schemes remain unsupported.

## Product coverage

- `http.request` / `http.get`: covered by global method patching and global agent replacement.
- `https.request` / `https.get`: covered by global method patching and global agent replacement.
- `globalThis.fetch`: covered by the fetch patch, including explicit dispatcher options and later Undici global dispatcher replacement in managed mode.
- Undici global dispatcher: installed for Undici APIs that read the current process dispatcher.
- WebSocket clients accepting a Node `agent`: covered with `proxy.createWebSocketAgent()`.
- Caller-built `http.Agent` / `https.Agent`: overridden in managed and active ambient mode, with TLS options preserved.
- Explicit HTTP CONNECT sockets: covered with `openProxyConnectTunnel()`.
- Raw `net.connect` / `tls.connect`: out of scope; see [Security](./docs/security.md).
- Native or private transport stacks: out of scope; see [Security](./docs/security.md).

## Why not just env vars?

Environment-based proxies are best-effort. A missing variable, a stale shell, a `NO_PROXY` typo, or a library that built its own `Dispatcher` quietly turns "always through the proxy" into "sometimes direct." Proxyline encodes the policy in code, replaces caller-built agents, and exposes a structured decision so logs can prove every request went the right way.

For tooling that *should* honor whatever the operator configured, ambient mode keeps the conventional behavior — with the same observability and the same credential redaction.

## Documentation

Full docs live in [`docs/`](./docs/README.md):

- [Getting Started](./docs/getting-started.md)
- [Modes](./docs/modes.md) — managed vs ambient
- [Surfaces](./docs/surfaces.md) — per-API behavior
- [API Reference](./docs/api-reference.md)
- [Environment Variables](./docs/environment-variables.md)
- [Proxy TLS](./docs/proxy-tls.md)
- [Observability](./docs/observability.md)
- [Security](./docs/security.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Testing](./docs/testing.md)

## Limits

Proxyline is a Node-process runtime, not an operating-system sandbox. Code can still bypass it by using raw `net`, raw `tls`, custom native networking, or a library that owns a private transport stack. Anything that captured `http.request` or `https.request` before Proxyline installed also bypasses it — install before loading third-party integrations when proxy routing is a security policy. See [`docs/security.md`](./docs/security.md) for the full threat model.

## License

[MIT](./LICENSE)
