# Troubleshooting

## `ProxylineError: MANAGED_PROXY_URL_REQUIRED`

You used `mode: "managed"` without `proxyUrl`. Managed mode does not fall back to the environment. Supply a URL or switch to `mode: "ambient"`.

## `ProxylineError: UNSUPPORTED_PROXY_PROTOCOL`

`proxyUrl` is not `http://` or `https://`. SOCKS and other transports are not supported.

## `ProxylineError: RUNTIME_ALREADY_ACTIVE`

Two parts of your code called `installProxyline` without an intervening `stop()`. Find the existing handle and reuse it, or call `stop()` before the second install. Common causes: test setup that re-installs on every test, double-invoked entry points, hot-reload tooling that re-evaluates the entry module.

## `ProxylineError: CONNECT_FAILED`

Returned by `openProxyConnectTunnel`. Inspect the message for the immediate cause:

- `proxy CONNECT timed out after Nms` — bump `timeoutMs` or check connectivity to the proxy.
- A status line such as `HTTP/1.1 407 Proxy Authentication Required` — include credentials in `proxyUrl`.
- A status line such as `HTTP/1.1 403 Forbidden` — the proxy refused the destination.
- `proxy socket closed before CONNECT response` — the proxy disconnected. Often a TLS mismatch; verify `proxyTls.ca`.
- `proxy CONNECT response headers exceeded 16384 bytes` — defensive cap. Unexpected from a normal proxy.

## fetch / undici still goes direct

- A library is using its own `Dispatcher` and passing it to `fetch` explicitly. Inspect the `dispatcher` option; it overrides the global one. Use `proxy.createUndiciDispatcher()` if you need a Proxyline-aware dispatcher.
- The library was loaded **before** `installProxyline`. Some libraries cache a dispatcher at import time. Install Proxyline first.

## Caller agent is being ignored

That is the intended managed-mode behavior — caller agents are replaced per request. TLS-relevant options (`ca`, `key`, `cert`, `rejectUnauthorized`, `minVersion`, `maxVersion`, `ciphers`, …) are lifted off the caller's agent so destination TLS still validates. If your option is missing, see [Surfaces — TLS identity preservation](./surfaces.md#tls-identity-preservation) for the full list of preserved keys.

## "ECONNREFUSED" against the proxy

Verify the proxy is reachable from this process:

```bash
curl -v -x "$HTTPS_PROXY" https://api.example.com
```

If `curl` succeeds but Node fails, the most common causes are:

- Wrong scheme (`HTTPS_PROXY=proxy.corp:8080` defaults to `http://proxy.corp:8080`).
- A private CA presented by the proxy that Node does not trust. Use `proxyTls`.
- Code captured `http.request` before Proxyline installed. Install Proxyline first.

## TLS errors against the proxy

The proxy presents a certificate Node does not trust. Pass `proxyTls.caFile` (or `proxyTls.ca`) — see [Proxy TLS](./proxy-tls.md). Do not disable TLS verification process-wide.

## TLS errors against the destination

Proxyline does not modify destination TLS. Use the same `ca` / `cert` / `key` options you would use without a proxy. When passed via an `https.Agent`, Proxyline copies them onto the request automatically.

## Tests interfere with each other

Each test should call `proxy.stop()` in its teardown. Without that, the next install throws `RUNTIME_ALREADY_ACTIVE` and the rest of the suite fails. The patches and the undici dispatcher are global, so leaks affect every concurrent test as well.

## Ambient mode reports `active: false`

No proxy variables are set. Check `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (and their lowercase forms). `NO_PROXY` alone is not enough to activate the runtime. See [Environment Variables](./environment-variables.md).

## `NO_PROXY` is not matching as expected

- Suffix matches need a leading `.` or `*`. `corp.example` matches only the exact host; `.corp.example` matches `api.corp.example`.
- A port suffix (`internal.corp:8443`) restricts the match to that port.
- IPv6 hosts may be bracketed or bare (`[::1]`, `::1`).
- Hostnames are lowercased and trailing dots are stripped before comparison.

When in doubt, use `proxy.explain(url)` — `reason: "no-proxy-match"` confirms the URL was exempted.
