# Environment Variables

Ambient mode reads its configuration from the environment at install time. Managed mode does not.

## Variables

| Variable | Used for | Notes |
| --- | --- | --- |
| `HTTP_PROXY` | proxy for `http:` and `ws:` URLs | upper case wins over lower |
| `HTTPS_PROXY` | proxy for `https:` and `wss:` URLs | |
| `ALL_PROXY` | fallback when the protocol-specific variable is unset | |
| `NO_PROXY` | comma- or whitespace-separated list of exemptions | matched against the destination URL |
| `http_proxy` | lowercase alias for `HTTP_PROXY` | upper case wins when both are set |
| `https_proxy` | lowercase alias | |
| `all_proxy` | lowercase alias | |
| `no_proxy` | lowercase alias | |

Empty or whitespace-only values are treated as unset.

## Activation

The ambient runtime is **active** when any of `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` (or their lowercase forms) is set to a non-empty value.

`NO_PROXY` alone does not activate the runtime. With only `NO_PROXY` set, `proxy.active` is `false` and Proxyline installs no patches.

## Snapshot at install

The values are read **once** at `installProxyline` time. Changing `process.env.HTTP_PROXY` afterwards does not retroactively activate or reconfigure Proxyline. Call `proxy.stop()` and re-install if the environment changes.

## Proxy URL parsing

- Bare endpoints (no scheme) default to `http://`. `HTTPS_PROXY=proxy.corp:8080` becomes `http://proxy.corp:8080`.
- `http://` and `https://` are the only accepted schemes. Anything else is ignored.
- Userinfo (`user:pass@`) in the proxy URL becomes a `Proxy-Authorization: Basic` header.

## NO_PROXY matching

Entries are split on commas and whitespace. Matching rules, in order:

1. `*` alone matches everything. The URL goes direct.
2. Entries can include a port: `internal.corp:8443`. When present, the entry only matches the URL's port (defaulting to `80` for `http`/`ws` and `443` for `https`/`wss`).
3. Entries starting with `.` or `*` are suffix matches. `.corp.example` matches `api.corp.example` and `corp.example`. `*.corp.example` is equivalent.
4. Other entries are exact host matches.
5. IPv6 entries may be bracketed (`[::1]:8443`) or bare (`::1`). Bracketed forms are stripped before comparison.
6. Hostnames are lowercased and trailing dots are stripped before comparison.

When a URL matches `NO_PROXY`, `explain()` returns `kind: "direct"`, `reason: "no-proxy-match"`.

## Examples

```bash
# go through the proxy for everything except internal hosts
export HTTPS_PROXY="https://proxy.corp.example:8443"
export NO_PROXY=".corp.example,localhost,127.0.0.1,::1"
```

```bash
# only https traffic via proxy, http stays direct
export HTTPS_PROXY="https://proxy.corp.example:8443"
```

```bash
# fall through to ALL_PROXY for everything
export ALL_PROXY="socks-not-supported://example"   # ignored — only http/https proxies are honored
export ALL_PROXY="http://gateway.corp:3128"        # used for both http and https URLs
```

## Interaction with `fetch`

The undici global dispatcher is installed as `EnvHttpProxyAgent` in ambient mode and is configured with the exact same `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` snapshot Proxyline read at install time. `fetch` and `node:http` therefore agree on the proxy decision for any URL.
