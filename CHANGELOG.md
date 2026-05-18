# Changelog

## 0.3.3 - Unreleased

- Fixed managed `globalThis.fetch` so later Undici global dispatcher replacement cannot bypass the active Proxyline dispatcher.

## 0.3.2 - 2026-05-17

- Fixed managed Undici proxy dispatchers so HTTPS proxy endpoints addressed by IP do not send invalid IP-literal SNI.

## 0.3.1 - 2026-05-16

- Fixed `withBypass()` to scope temporary bypasses to the calling async context instead of process-wide state.
- Fixed HTTPS SNI preservation when Node request options override a URL hostname.
- Hardened package and docs release output by preserving declaration-map sources, shipping product docs, rejecting duplicate docs pages, avoiding lockfile-bypassing prepack installs, and keeping package artifact checks portable on Windows.

## 0.3.0 - 2026-05-15

- Added branded Proxyline dispatcher detection, reusable active-runtime installs, scoped dynamic bypass registration, first-class undici dispatcher tuning options, and a side-effect-light dispatcher detection subpath.
- Fixed async scoped bypass lifetimes, ambient runtime reuse compatibility checks, WebSocket surface matching, and zero-valued undici timeout handling.
- Moved `undici` to a peer dependency so host applications share one global dispatcher runtime with Proxyline.

## 0.2.0 - 2026-05-14

- Added ambient Node proxy helper exports and replaced the `proxy-agent` dependency with Proxyline's scoped HTTP/HTTPS Node agent.
- Added a native Node coverage command and `pnpm check` coverage gates for source lines, branches, and functions.
- Expanded CI to run the coverage-gated check across Ubuntu, macOS, and Windows on Node 20.18.1, 22, 24, and 26.
- Hardened ambient proxy routing, CONNECT target validation, undici dispatcher cleanup, and generated package output after the runtime module split.
- Added managed-mode `bypassPolicy` support so trusted callers can intentionally route selected loopback/control-plane traffic directly while keeping the rest of managed traffic proxied.
- Stopped versioning generated `dist/` output in git; release and package dry-run flows now build `dist/` during `prepack` and still publish generated JavaScript, declarations, and declaration maps.

## 0.1.0 - 2026-05-11

- Initial public release of `@openclaw/proxyline` for process-global proxy routing in Node.js.
- Added managed mode for fail-closed proxy policy with required `proxyUrl`, global `node:http`/`node:https` patching, global agent replacement, and undici/fetch routing through `ProxyAgent`.
- Added ambient mode for `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, lowercase variants, bare proxy endpoints, and `NO_PROXY` exemptions with matching diagnostics.
- Added proxy-aware helpers for Node agents, WebSocket clients, undici dispatchers, and explicit HTTP CONNECT tunnels.
- Added scoped proxy TLS trust via `proxyTls.ca` and `proxyTls.caFile`, preserving destination TLS identity while trusting private proxy CAs.
- Added structured observability with `explain()`, `onEvent`, redacted proxy URLs, install/stop lifecycle events, and per-decision diagnostics.
- Added runtime cleanup with `proxy.stop()` to restore captured Node HTTP(S) methods, global agents, and the undici global dispatcher.
- Added credential-safe proxy authorization handling for proxy URLs with userinfo.
- Added in-process proxy lab coverage for HTTP, HTTPS, CONNECT, WebSocket, undici/fetch, proxy auth, loopback blocking, HTTPS proxies, TLS preservation, and IPv6 `NO_PROXY`.
- Added full documentation for getting started, modes, surfaces, API reference, environment variables, proxy TLS, observability, security, troubleshooting, and testing.
