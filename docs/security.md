# Security

Proxyline is a Node-process runtime, not an operating-system sandbox. Understanding what it does — and what it cannot do — is essential before relying on it as a policy.

## Assurance model

Proxyline's runtime assurances assume it is installed before application and plugin networking code is loaded. Install it as the first import in the process when proxy routing is part of the security posture.

These assurances apply to the surfaces Proxyline patches or helpers it creates. They do not apply to code that captured networking functions before installation, raw sockets, native transports, or separate bundled transport stacks.

## What Proxyline enforces

In **managed** mode, Proxyline forces traffic through the configured proxy on the surfaces it covers:

- `http.request` / `http.get` / `http.globalAgent`
- `https.request` / `https.get` / `https.globalAgent`
- The undici global dispatcher (i.e. `fetch`)
- WebSocket clients that accept a Node `agent`, via `proxy.createWebSocketAgent()` or by reusing the patched `http.request` during the upgrade
- Explicit HTTP CONNECT when callers opt in to `openProxyConnectTunnel`

Caller-supplied `http.Agent` / `https.Agent` instances are replaced per request, and `createConnection` overrides are stripped. TLS-relevant agent options are lifted onto the request so destination TLS still validates correctly.

In **ambient** mode the same surfaces are covered when at least one supported `http://` or `https://` proxy endpoint is set through `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY`; unsupported proxy schemes are ignored, and `NO_PROXY` is honored.

## What Proxyline cannot enforce

Anything that does not flow through the patched APIs:

- Direct `net.connect` or `tls.connect` calls. Code that opens raw sockets is not seen by Proxyline.
- Native modules with private transport stacks (e.g. some database drivers, gRPC C bindings).
- Libraries that import and call `undici.fetch` directly with their own explicit `Dispatcher`. Proxyline's managed `globalThis.fetch` strips explicit dispatchers, but it cannot rewrite every imported undici function reference.
- DNS resolution itself. Proxyline tells the proxy a hostname; DNS-based exfiltration via the local resolver is out of scope.
- Sockets opened **before** `installProxyline` ran. Existing keepalive connections continue to use whatever transport they were created with.
- Module references captured before `installProxyline` ran. Anything that stored `http.request` in a local variable at import time keeps the un-patched reference.
- Non-standard internals on native `Request` objects created before `installProxyline` ran. Proxyline can normalize standard Request fields, but runtimes do not expose every internal field consistently.

For a process-wide proxy enforcement policy, combine Proxyline with operating-system level controls (egress firewall rules, network namespaces, seccomp, or a sidecar proxy).

## Install order matters

Install Proxyline as the **first** import in your application entry point. Anything that imports `node:http`, `node:https`, `undici`, or a wrapper library before Proxyline is initialized may have already captured the original method references. The patches still apply to future calls into `http.request` etc., but a stale captured reference will bypass them.

```ts
// entry.ts
import { installGlobalProxy } from "@openclaw/proxyline";

installGlobalProxy({ mode: "managed", proxyUrl: process.env.PROXY_URL! });

// only after install:
await import("./app.js");
```

## Process-wide singleton

Only one Proxyline runtime can be installed at a time. A second `installProxyline` call throws `ProxylineError` with code `RUNTIME_ALREADY_ACTIVE`. Call `proxy.stop()` to restore originals before installing a new runtime.

This is deliberate: two competing proxy patches would race on `http.request` and `globalAgent`, and the loser would silently bypass the winner.

## Credential handling

- Userinfo in proxy URLs becomes a `Proxy-Authorization: Basic` header on every CONNECT / absolute-form request.
- Userinfo, search, and fragment are stripped from any URL Proxyline reports back to the caller (`handle.proxyUrl`, `decision.proxyUrl`, `runtime.installed`).
- `redactProxyUrl` is exported so callers can apply the same rule to URLs they log themselves.

## Threat model summary

| Threat | Mitigated | Notes |
| --- | --- | --- |
| Library passes a direct `http.Agent` per request | yes (managed) | Replaced before the request runs |
| Library passes a direct `Dispatcher` to managed `globalThis.fetch` | yes | Explicit dispatchers are stripped |
| Library calls imported `undici.fetch` with a direct `Dispatcher` | no | Imported function references are outside the global fetch patch |
| Library uses `net.connect` directly | no | Out of scope |
| Library captured `http.request` at import time | no (if before install) | Install Proxyline first |
| Environment variable set after install | no | Snapshot at install time |
| Proxy credentials leaked into logs | yes (in Proxyline output) | Use `redactProxyUrl` for caller logs |
| Process-wide CA trust drift | yes | `proxyTls` is scoped to the proxy endpoint |

## Reporting

Security issues: open a private advisory at <https://github.com/openclaw/proxyline/security/advisories>. Do not open public issues for unpatched problems.
