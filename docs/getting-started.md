# Getting Started

Proxyline targets Node.js 20+. It is published as `@openclaw/proxyline` and ships ESM with TypeScript types.

## Install

```bash
pnpm add @openclaw/proxyline
# or
npm install @openclaw/proxyline
# or
yarn add @openclaw/proxyline
```

## Install Proxyline first

Patches replace `http.request`, `http.get`, `https.request`, `https.get`, `http.globalAgent`, `https.globalAgent`, and the undici global dispatcher. Any module that captured the original references before Proxyline installs will bypass the runtime. Initialize Proxyline before importing third-party HTTP clients when proxy routing is a security policy.

```ts
// entry.ts — first import in your application
import { installGlobalProxy } from "@openclaw/proxyline";

const proxy = installGlobalProxy({
  mode: "managed",
  proxyUrl: "https://proxy.corp.example:8443",
  proxyTls: { caFile: "/etc/proxy-ca.pem" },
});

// only now load the rest of the app
await import("./app.js");
```

## Minimal managed proxy

Managed mode treats proxy routing as policy: setup failures throw, requests are forced through the configured proxy, and caller-supplied `http.Agent` / `https.Agent` instances are replaced per request.

```ts
import { installGlobalProxy } from "@openclaw/proxyline";

const proxy = installGlobalProxy({
  mode: "managed",
  proxyUrl: "https://proxy.corp.example:8443",
  onEvent: (event) => console.debug("[proxyline]", event),
});

const decision = proxy.explain("https://api.example.com/");
console.log(decision.kind, decision.reason, decision.proxyUrl);
```

## Minimal ambient proxy

Ambient mode reads the usual environment variables. With no proxy configured, requests stay direct and `explain()` reports `ambient-proxy-not-configured`.

```bash
export HTTPS_PROXY="http://proxy.corp.example:8080"
export NO_PROXY="metadata.google.internal,127.0.0.1"
```

```ts
import { installGlobalProxy } from "@openclaw/proxyline";

const proxy = installGlobalProxy({ mode: "ambient" });
console.log(proxy.active);            // true if any HTTP_PROXY/HTTPS_PROXY/ALL_PROXY is set
console.log(proxy.proxyUrl);          // redacted URL string when active
```

See [Modes](./modes.md) for the full posture contract and [Environment Variables](./environment-variables.md) for parsing rules.

## Shutdown

Call `proxy.stop()` from your shutdown path (and from tests). It restores the saved Node HTTP(S) methods and global agents, restores the previous undici global dispatcher, and destroys the internal proxy agent. Only one Proxyline runtime can be active at a time; install will throw `RUNTIME_ALREADY_ACTIVE` otherwise.

```ts
process.once("SIGTERM", () => proxy.stop());
process.once("SIGINT", () => proxy.stop());
```

## What to read next

- [Surfaces](./surfaces.md) for per-API behavior, including WebSocket and CONNECT helpers.
- [Observability](./observability.md) to log decisions without leaking credentials.
- [Security](./security.md) for the boundaries of what Proxyline can enforce.
