# Proxyline

Process-global proxy routing for Node.js.

Proxyline patches the network surfaces a Node process can reach without owning a private transport stack, so one policy applies to `node:http`, `node:https`, undici/fetch, WebSocket clients that accept agents, and explicit HTTP CONNECT helpers.

## Start

- [Getting Started](./getting-started.md)
- [Modes](./modes.md)
- [Surfaces](./surfaces.md)
- [API Reference](./api-reference.md)
- [Environment Variables](./environment-variables.md)
- [Proxy TLS](./proxy-tls.md)
- [Observability](./observability.md)
- [Security](./security.md)
- [Troubleshooting](./troubleshooting.md)
- [Testing](./testing.md)

## Install

```bash
pnpm add @openclaw/proxyline
```

## Managed Mode

```ts
import { installGlobalProxy } from "@openclaw/proxyline";

const proxy = installGlobalProxy({
  mode: "managed",
  proxyUrl: "https://proxy.corp.example:8443",
  proxyTls: { caFile: "/etc/proxy-ca.pem" },
});

console.log(proxy.explain("https://api.example.com/"));
```

## Ambient Mode

```ts
import { installGlobalProxy } from "@openclaw/proxyline";

const proxy = installGlobalProxy({ mode: "ambient" });
```
