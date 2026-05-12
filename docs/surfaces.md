# Surfaces

Proxyline installs at the layer above each network API. It does not own sockets, except via the explicit `openProxyConnectTunnel` helper.

## node:http and node:https

Both modules have their request entry points patched and their `globalAgent` replaced.

Patched methods:

- `http.request`, `http.get`
- `https.request`, `https.get`

Per request, Proxyline:

1. Copies the call's options object so caller state is not mutated.
2. Reads TLS-relevant options off any caller-supplied `agent` and lifts them onto the request options (see [TLS identity preservation](#tls-identity-preservation)).
3. Sets `servername` to the destination hostname when not already set and the hostname is not an IP literal.
4. Builds a fresh `proxy-agent` `ProxyAgent` for the request and assigns it as `options.agent`.
5. Deletes any `createConnection` override so callers cannot punch through to the kernel directly.
6. Destroys the per-request proxy agent when the request closes.

This means caller agents are not just ignored — the per-request agent is replaced before the original method runs, so even libraries that read `req.agent` after construction see the proxy agent.

### TLS identity preservation

When the caller supplied an `https.Agent` with TLS options, the following keys are lifted into the request so the destination TLS handshake still validates correctly:

`ca`, `cert`, `ciphers`, `clientCertEngine`, `crl`, `dhparam`, `ecdhCurve`, `honorCipherOrder`, `key`, `maxVersion`, `minVersion`, `passphrase`, `pfx`, `rejectUnauthorized`, `secureOptions`, `secureProtocol`, `sessionIdContext`.

The destination `servername` is also inferred from the URL or `hostname`/`host` options when the caller did not set one. IP literals are not used as SNI values.

### Absolute-form requests

Some HTTP clients build absolute-form requests themselves (e.g. `path: "https://api.example.com/graphql"`). Proxyline leaves the path intact and forwards it through the proxy unchanged, so libraries that already implement their own proxy handling continue to function.

## undici and fetch

`installGlobalProxy` calls `undici.setGlobalDispatcher` and patches `globalThis.fetch` to use Proxyline's dispatcher with:

- `undici.ProxyAgent` in managed mode, pointed at `proxyUrl` and trusting `proxyTls` when supplied.
- Proxyline's ambient dispatcher in ambient mode, resolving each request against the current install-time `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` snapshot, with the same `proxyTls`.

The original dispatcher and fetch globals are captured and restored on `stop()`.

```ts
import { fetch } from "undici";

await fetch("https://api.example.com/health"); // routed through Proxyline
```

If your code creates its own undici `Agent` or `Dispatcher` and passes it explicitly to `fetch`, that explicit instance wins. Use `proxy.createUndiciDispatcher()` to get a dispatcher pre-wired to the same policy.

Proxyline also replaces `globalThis.Request`, `Response`, `Headers`, and `FormData` with versions from its undici dependency so `globalThis.fetch` receives compatible objects on Node versions where the built-in fetch no longer shares the package dispatcher. Requests created before Proxyline installs are normalized through the standard public `Request` fields. Install Proxyline first if you need non-standard Request internals, such as a dispatcher embedded in a pre-install native `Request`, to be preserved.

## WebSocket

WebSocket clients that accept a Node `agent` option (e.g. `ws`) can route through the proxy via:

```ts
import WebSocket from "ws";

const socket = new WebSocket("wss://events.example.com/", {
  agent: proxy.createWebSocketAgent(),
});
```

When ambient mode is inactive, `createWebSocketAgent()` returns a plain `http.Agent`, so calling code does not need a conditional path.

Clients that do **not** expose an `agent` option but still route their handshake through `http.request` are covered automatically by the global patch.

## HTTP CONNECT tunnel

Some libraries — notably HTTP/2 clients — need ownership of the underlying socket. `openProxyConnectTunnel` performs an `HTTP CONNECT` against the proxy and resolves with a connected `net.Socket` (or `tls.TLSSocket` for HTTPS proxies).

```ts
import { openProxyConnectTunnel } from "@openclaw/proxyline";

const socket = await openProxyConnectTunnel({
  proxyUrl: "https://proxy.corp.example:8443",
  proxyTls: { caFile: "/etc/proxy-ca.pem" },
  targetHost: "api.example.com",
  targetPort: 443,
  timeoutMs: 2_000,
});
```

Properties:

- HTTP and HTTPS proxy endpoints supported. Other schemes throw `UNSUPPORTED_PROXY_PROTOCOL`.
- HTTPS proxies use ALPN `http/1.1`. SNI is the proxy hostname unless that is an IP literal.
- Userinfo in the `proxyUrl` becomes a `Proxy-Authorization: Basic ...` header.
- A bounded `16 KiB` header buffer protects against malicious or runaway proxy responses.
- `timeoutMs` is enforced and emits a `CONNECT_FAILED` error on expiry.
- Bytes the proxy sends after the response headers are re-injected with `socket.unshift()` so the caller sees the full target stream.
- Non-2xx status lines, header overrun, premature close, and socket errors are all surfaced as `ProxylineError` with code `CONNECT_FAILED`.

The helper is standalone — it does not require `installGlobalProxy` to have been called.

## Caller-built agents

A `http.Agent` or `https.Agent` you construct yourself is **replaced** in managed mode and **replaced when active** in ambient mode. The replacement happens inside the patched `http.request` / `https.request` call: by the time the underlying request starts, `options.agent` already points at a proxy agent.

This is intentional: a common bypass is `new https.Agent({ keepAlive: true })` passed per-request. Without replacement the proxy is silently skipped.

To get a proxy-aware agent without going through the patched globals, use:

- `proxy.createNodeAgent()` — an `http.Agent` that proxies HTTP and HTTPS requests.
- `proxy.createUndiciDispatcher()` — an undici `Dispatcher` mirroring the current mode.
- `proxy.createWebSocketAgent()` — an `http.Agent` suitable for WebSocket upgrades.

Helper-created agents and dispatchers are caller-owned. Destroy or close them when the caller is done.

When the runtime is inactive (ambient mode with no env proxy set), these helpers return direct agents/dispatchers.
