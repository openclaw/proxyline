# Proxyline

Process-global proxy routing for Node.js.

Proxyline is intended to make proxy behavior explicit, observable, and hard to
bypass accidentally. The first target is Node applications that need one
managed egress policy across `node:http`, `node:https`, fetch/undici, WebSocket
clients, and explicit HTTP CONNECT tunnels.

This repository is currently a scaffold. The initial API models the two safety
postures the implementation must preserve:

- `managed`: proxy routing is a security policy. Setup failures must fail
  closed instead of silently going direct.
- `ambient`: respect ordinary `HTTP_PROXY` / `HTTPS_PROXY` style environment
  configuration as best-effort compatibility.

## Planned Coverage

- Node `http.request`, `http.get`, `https.request`, and `https.get`.
- Process global fetch/undici dispatcher.
- WebSocket clients that accept an `agent`.
- Explicit HTTP CONNECT tunnel helper for HTTP/2 clients.
- Scoped TLS options for the proxy endpoint, starting with CA trust.
- Redacted decision logs and route diagnostics.
- Coverage helpers for raw `net`, `tls`, and `http2` call sites.

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
