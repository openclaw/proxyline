# Proxyline 🌐 — Keep every Node request in line.

[![CI](https://img.shields.io/github/actions/workflow/status/openclaw/proxyline/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/openclaw/proxyline/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40openclaw%2Fproxyline?style=flat-square)](https://www.npmjs.com/package/@openclaw/proxyline)
[![Node.js](https://img.shields.io/node/v/%40openclaw%2Fproxyline?style=flat-square)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/openclaw/proxyline?style=flat-square)](./LICENSE)

![Proxyline banner](docs/assets/readme-banner.jpg)

Proxyline installs one process-wide proxy policy across Node's built-in HTTP(S) clients, global fetch and Undici, compatible WebSocket clients, and explicit CONNECT tunnels. It is for Node applications that need one runtime to enforce proxy routing, explain its decisions, and restore the original networking globals.

Documentation is available at [proxyline.dev](https://proxyline.dev).

## Install

```sh
pnpm add @openclaw/proxyline undici@^8.5.0
```

Or with npm:

```sh
npm install @openclaw/proxyline undici@^8.5.0
```

Proxyline requires Node.js 22.19.0 or newer and a host `undici` version in the `>=8.5.0 <9` range. The package is ESM-only and includes TypeScript declarations.

## Quick start

Save this as `proxy.mjs`:

```js
import { installGlobalProxy } from "@openclaw/proxyline";

const proxy = installGlobalProxy({
  mode: "managed",
  proxyUrl: "http://127.0.0.1:3128",
});
console.log(proxy.explain("https://api.example.com/").reason);
proxy.stop();
```

```sh
node proxy.mjs
# managed-proxy-active
```

This asks Proxyline for a routing decision without connecting to the placeholder proxy. Install Proxyline before loading application or plugin code that may capture networking functions.

## Choose a mode

Proxyline has two explicit routing modes:

| Mode | Configuration | Direct traffic |
| --- | --- | --- |
| `managed` | A required `proxyUrl` in code | Only through `bypassPolicy`, `registerBypass()`, or `withBypass()` |
| `ambient` | `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` | Whenever the environment has no matching proxy |

Managed mode fails during setup when its proxy configuration is missing or unsupported. Ambient mode reads the environment once at installation and stays inactive when no supported HTTP or HTTPS proxy is configured. See [Modes](./docs/modes.md) and [Environment Variables](./docs/environment-variables.md) for the complete rules.

## Covered traffic

| Surface | How Proxyline applies the policy |
| --- | --- |
| `node:http` and `node:https` | Patches request methods and replaces global and caller-supplied agents |
| Global fetch and Undici | Installs a global dispatcher and a compatible fetch stack |
| WebSocket clients | Supplies `proxy.createWebSocketAgent()` for clients that accept a Node agent |
| Explicit tunnels | Supplies `openProxyConnectTunnel()` for callers that need the connected socket |

`proxy.createNodeAgent()` and `proxy.createUndiciDispatcher()` expose the same policy to libraries that accept an agent or dispatcher directly. The [surface guide](./docs/surfaces.md) describes ownership, TLS preservation, and cleanup for each API.

## Bypasses and proxy trust

Managed mode supports deliberate direct-routing exceptions. A `bypassPolicy` handles installation-time policy, `registerBypass()` registers an exact process-wide exception, and `withBypass()` limits an exception to one async context. Each decision remains visible through `explain()`.

For an HTTPS proxy with a private CA, use `proxyTls.ca` or `proxyTls.caFile`. That trust applies only to the proxy connection; destination TLS validation remains separate. See [Proxy TLS](./docs/proxy-tls.md).

## Observability and lifecycle

`proxy.explain(url)` reports `proxied` or `direct`, the reason, the surface, and a credential-redacted proxy URL when one applies. The optional `onEvent` callback receives installation, shutdown, and decision events.

Only one Proxyline runtime is active in a process. A second installation fails by default; `ifActive` can reuse a compatible runtime or replace it intentionally. `proxy.stop()` restores the captured Node HTTP(S) methods, global agents, Undici dispatcher, and fetch globals. See [Observability](./docs/observability.md) and the [API Reference](./docs/api-reference.md).

## Security boundary

Proxyline is a Node-process runtime, not an operating-system sandbox. Raw `net` or `tls` sockets, native or private transport stacks, networking functions captured before installation, and DNS traffic are outside its boundary. Combine it with operating-system egress controls when code in the process is not trusted.

Read the [security model](./docs/security.md) before treating managed mode as an enforcement boundary.

## Documentation

- [Getting Started](./docs/getting-started.md)
- [Modes](./docs/modes.md)
- [Surfaces](./docs/surfaces.md)
- [API Reference](./docs/api-reference.md)
- [Environment Variables](./docs/environment-variables.md)
- [Proxy TLS](./docs/proxy-tls.md)
- [Observability](./docs/observability.md)
- [Security](./docs/security.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Testing](./docs/testing.md)

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm docs:build
```

## License

[MIT](./LICENSE)
