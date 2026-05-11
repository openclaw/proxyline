---
title: Overview
permalink: /
description: "Process-global proxy routing for Node.js. One install routes node:http, node:https, undici/fetch, plus WebSocket and HTTP CONNECT helpers through a single explicit policy."
---

# Proxyline Documentation

Process-global proxy routing for Node.js. Proxyline patches the network surfaces a Node process can reach without owning a private transport stack, so a single policy applies to `node:http`, `node:https`, undici/fetch, WebSocket clients that accept agents, and explicit HTTP CONNECT helpers.

## Contents

- [Getting Started](./getting-started.md) — install, first proxy, shutdown.
- [Modes](./modes.md) — `managed` vs `ambient` safety postures.
- [Surfaces](./surfaces.md) — which network APIs Proxyline covers and how.
- [API Reference](./api-reference.md) — every exported type, function, and field.
- [Environment Variables](./environment-variables.md) — how `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` are interpreted.
- [Proxy TLS](./proxy-tls.md) — scoping CA trust to the proxy endpoint.
- [Observability](./observability.md) — events, `explain()`, credential redaction.
- [Security](./security.md) — threat model, limits, what Proxyline does **not** do.
- [Troubleshooting](./troubleshooting.md) — common failure modes and fixes.
- [Testing](./testing.md) — the in-process proxy lab.

## At a glance

| Surface | Covered | How |
| --- | --- | --- |
| `http.request` / `http.get` | yes | global method patch + global agent swap |
| `https.request` / `https.get` | yes | global method patch + global agent swap |
| `fetch` / undici global dispatcher | yes | `setGlobalDispatcher` |
| WebSocket clients accepting a Node `agent` | yes | `proxy.createWebSocketAgent()` |
| WebSocket clients without an `agent` option | partial | upgrade reuses patched `http.request` |
| Explicit HTTP CONNECT socket | yes | `openProxyConnectTunnel()` |
| Caller-built `http.Agent` / `https.Agent` | overridden in managed mode | per-request agent replacement |
| Raw `net.connect` / `tls.connect` | no | out of scope — see [Security](./security.md) |
| Native or third-party transport stacks | no | out of scope — see [Security](./security.md) |
