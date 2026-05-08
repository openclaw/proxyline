# Proxyline

Process-global proxy routing for Node.js.

Proxyline is intended to make proxy behavior explicit, observable, and hard to
bypass accidentally. The first target is Node applications that need one
managed egress policy across `node:http`, `node:https`, fetch/undici, WebSocket
clients, and explicit HTTP CONNECT tunnels.

The API models two safety postures:

- `managed`: proxy routing is a security policy. Setup failures must fail
  closed instead of silently going direct.
- `ambient`: respect ordinary `HTTP_PROXY` / `HTTPS_PROXY` style environment
  configuration as best-effort compatibility. This mode is currently only a
  non-active diagnostic posture unless a proxy URL is passed explicitly.

## Coverage

- Managed mode installs a process-global proxy runtime for Node
  `http.request`, `http.get`, `https.request`, and `https.get`.
- Caller-provided Node HTTP agents are replaced in managed mode, so ordinary
  per-request direct agents do not bypass the configured proxy.
- Process-global undici/fetch routing is installed with `setGlobalDispatcher`.
- WebSocket clients that accept a Node `agent` can use
  `proxy.createWebSocketAgent()`.
- `openProxyConnectTunnel()` opens explicit HTTP CONNECT tunnels for callers
  such as HTTP/2 clients that need direct socket ownership.
- Proxy endpoint TLS can be scoped with `proxyTls.ca` or `proxyTls.caFile`.
- Decision logs and diagnostics redact proxy credentials, query strings, and
  fragments.

## Install

Not published yet.

```bash
pnpm add @jesse-merhi/proxyline
```

## Usage Sketch

```ts
import { installGlobalProxy } from "@jesse-merhi/proxyline";

const proxy = installGlobalProxy({
  mode: "managed",
  proxyUrl: "https://proxy.corp.example:8443",
  proxyTls: {
    caFile: "/etc/proxy-ca.pem",
  },
  onEvent: (event) => {
    console.debug(event);
  },
});

console.log(proxy.explain("https://api.example.com/"));
```

Pass the WebSocket helper to clients that expose a Node `agent` option:

```ts
import WebSocket from "ws";
import { installGlobalProxy } from "@jesse-merhi/proxyline";

const proxy = installGlobalProxy({
  mode: "managed",
  proxyUrl: "http://127.0.0.1:8080",
});

const socket = new WebSocket("wss://events.example.com/", {
  agent: proxy.createWebSocketAgent(),
});
```

Open a scoped CONNECT tunnel when a library needs a socket instead of an agent:

```ts
import { openProxyConnectTunnel } from "@jesse-merhi/proxyline";

const socket = await openProxyConnectTunnel({
  proxyUrl: "https://proxy.corp.example:8443",
  proxyTls: {
    caFile: "/etc/proxy-ca.pem",
  },
  targetHost: "api.example.com",
  targetPort: 443,
  timeoutMs: 2_000,
});
```

Call `proxy.stop()` during shutdown or tests to restore the original Node
HTTP(S) methods, global agents, and undici global dispatcher.

## E2E Lab

The test suite includes an in-process proxy lab derived from a local standalone
proxy harness. It runs a target HTTP server and a forward proxy on random ports,
then verifies:

- absolute-form HTTP proxy requests;
- HTTP CONNECT tunnel routing;
- denial of configured paths;
- loopback blocking with explicit test allowlists;
- HTTPS proxy endpoints with scoped CA trust;
- Node HTTP global routing, forced agent override, undici/fetch routing,
  WebSocket agent routing, and explicit CONNECT socket routing.

Run it with:

```bash
pnpm check
```

## Limits

Proxyline is a Node process runtime, not an operating-system sandbox. Code can
still bypass it by using raw `net`, raw `tls`, custom native networking, or a
library that owns a private transport stack and does not use Node HTTP(S),
undici's global dispatcher, or an agent/dispatcher/socket hook supplied by the
caller.

Code that captured original `http.request` or `https.request` references before
Proxyline was installed can also bypass the runtime. Install Proxyline before
loading third-party integrations when proxy routing is a security policy.
