# Modes

Proxyline models two safety postures. The `mode` option selects one explicitly — there is no implicit fallback between them.

## Managed

Managed mode treats proxy routing as a security policy.

- `proxyUrl` is **required**. Omitting it throws `ProxylineError` with code `MANAGED_PROXY_URL_REQUIRED`.
- Only `http://` and `https://` proxy endpoints are accepted. Other schemes throw `UNSUPPORTED_PROXY_PROTOCOL`.
- The managed proxy is forced for every request on the patched surfaces.
- Caller-supplied `http.Agent` or `https.Agent` values are replaced per request. TLS-relevant agent options (`ca`, `cert`, `key`, `ciphers`, `minVersion`, `maxVersion`, `rejectUnauthorized`, etc.) are copied onto the proxy request so destination TLS identity is preserved. See [Surfaces — TLS identity preservation](./surfaces.md#tls-identity-preservation) for the full list.
- The undici global dispatcher is replaced with an `undici.ProxyAgent` pointed at `proxyUrl`.
- Environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, ...) are **ignored**.
- `explain()` returns `kind: "proxied"` with `reason: "managed-proxy-active"` for every URL.

Use managed mode when "go direct" must never be silent. If your network policy demands traffic egress through a specific gateway, this is the posture you want.

```ts
const proxy = installGlobalProxy({
  mode: "managed",
  proxyUrl: "https://proxy.corp.example:8443",
  proxyTls: { caFile: "/etc/proxy-ca.pem" },
});
```

## Ambient

Ambient mode mirrors the conventional "respect the environment" behavior used by most CLI tooling.

- `proxyUrl` is **ignored** if supplied. Configuration comes from `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` (and their lowercase forms).
- The runtime only installs patches when at least one of `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` resolves to a supported `http://` or `https://` proxy endpoint. `proxy.active` is `false` otherwise and the handle behaves as a passive observer.
- Per-request proxy resolution honors protocol-specific variables, falls back to `ALL_PROXY`, and applies `NO_PROXY` matching (suffix, wildcard, exact, IPv6).
- Bare endpoints (no scheme) default to `http://` — e.g. `HTTPS_PROXY=proxy.corp:8080` becomes `http://proxy.corp:8080`.
- The undici global dispatcher becomes Proxyline's ambient dispatcher so `fetch` sees the same routing rules.
- `explain()` returns one of:
  - `kind: "proxied"`, `reason: "ambient-proxy-active"` — a proxy applies.
  - `kind: "direct"`, `reason: "no-proxy-match"` — `NO_PROXY` exempted the host.
  - `kind: "direct"`, `reason: "ambient-proxy-not-configured"` — no supported proxy variables are set, the configured proxy scheme is unsupported, or the URL scheme is unsupported.

Use ambient mode for tooling and CLIs that need best-effort compatibility with whatever the operator has configured.

```ts
const proxy = installGlobalProxy({ mode: "ambient" });
if (!proxy.active) {
  console.warn("no HTTP_PROXY/HTTPS_PROXY/ALL_PROXY set — direct egress");
}
```

## Comparison

| Behavior | `managed` | `ambient` |
| --- | --- | --- |
| Requires `proxyUrl` | yes | no (ignored if passed) |
| Reads env variables | no | yes |
| Honors `NO_PROXY` | no | yes |
| Forces traffic through proxy | yes | only when env says so |
| Replaces caller-supplied agents | yes | yes (when active) |
| Installs undici dispatcher | `ProxyAgent` | Proxyline ambient dispatcher |
| `explain()` direct reason | never | `no-proxy-match` or `ambient-proxy-not-configured` |
| Setup failure mode | throws | inactive but installed |

## Why a strict managed mode

If you mix environment-based configuration with a security policy you get drift: a missing variable, a forgotten `NO_PROXY` entry, or a transient unset turns "always through the proxy" into "sometimes direct." Managed mode refuses to start without the URL and refuses to honor environment overrides, so the policy is encoded in code, not in shell state.
