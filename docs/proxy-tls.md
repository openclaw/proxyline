# Proxy TLS

`proxyTls` scopes CA trust **for the proxy endpoint only**. It does not loosen TLS for the destination, and it does not affect Node's default trust store.

## Why scope CA trust

Corporate proxies often present TLS certificates signed by a private CA. Two common approaches that Proxyline avoids:

- Setting `NODE_EXTRA_CA_CERTS` — process-wide trust change, affects every TLS handshake, easy to forget.
- Setting `NODE_TLS_REJECT_UNAUTHORIZED=0` — disables verification entirely, destroys security.

Proxyline instead supplies a `ca` value **only** to the agent that talks to the proxy. Destination handshakes continue using the system trust store and the caller's `ca` / `rejectUnauthorized` settings.

## Options

```ts
type ProxylineTlsOptions = Readonly<{
  ca?: string;     // PEM contents
  caFile?: string; // path; read with fs.readFileSync(path, "utf8")
}>;
```

Pass exactly one. `ca` wins when both are provided. The resolved PEM is forwarded to:

- The internal Proxyline Node agent used for `node:http` and `node:https`.
- Proxyline's managed undici dispatcher or ambient dispatcher.
- The `tls.connect` call inside `openProxyConnectTunnel` when the proxy URL is `https://`.

## Recipes

### From disk

```ts
installGlobalProxy({
  mode: "managed",
  proxyUrl: "https://proxy.corp.example:8443",
  proxyTls: { caFile: "/etc/proxy-ca.pem" },
});
```

### Inline PEM

```ts
import { readFileSync } from "node:fs";

const ca = readFileSync("/etc/proxy-ca.pem", "utf8");

installGlobalProxy({
  mode: "managed",
  proxyUrl: "https://proxy.corp.example:8443",
  proxyTls: { ca },
});
```

### Pre-resolving for your own code

```ts
import { resolveProxyTlsCa } from "@openclaw/proxyline";

const ca = resolveProxyTlsCa({ caFile: "/etc/proxy-ca.pem" });
// ca is a PEM string, or undefined if no options were supplied
```

## Per-proxy connection controls

For a Node helper agent, `resolveProxyConnectOptions(proxyUrl)` can return a
prepared DNS `lookup`, proxy client `cert`/`key`/`passphrase`, a TLS `servername`,
`rejectUnauthorized`, and `ca`. Raw CONNECT callers pass the same fields through
`proxyConnect`. See [the API contract](./api-reference.md#proxyconnectoptions).

These fields configure the proxy hop. They cannot replace the proxy URL's host
or port, inject a Unix socket path, or change the HTTP/1.1 proxy protocol. An
explicit `ca` overrides the existing proxy CA default; it does not change trust
for the tunneled destination.

## Destination TLS

Destination TLS is independent of `proxyTls`. When you call `https.request(url, { ca, rejectUnauthorized, ... })`, those options apply to the destination handshake exactly as Node would normally apply them. Proxyline only lifts them off a caller-supplied `agent` so they survive the agent replacement; see [Surfaces — TLS identity preservation](./surfaces.md#tls-identity-preservation).
