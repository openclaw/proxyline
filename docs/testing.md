# Testing

Proxyline ships with an in-process **proxy lab** used by its end-to-end tests. The lab spins up a target HTTP(S) server and a forward proxy on random ports, then asserts that requests routed through Proxyline reach the proxy with the right shape.

The lab lives in `test/support/proxy-lab.ts`. It is not exported from the package — copy it into your own test suite if you find it useful.

## Run the suite

```bash
pnpm check       # typecheck + tests + build
pnpm test        # tests only
pnpm typecheck   # type-only
```

`pnpm test` runs `node --test` via `tsx` against `test/index.test.ts` (unit) and `test/e2e.test.ts` (integration).

## What the lab covers

The lab proxy:

- Accepts absolute-form HTTP proxy requests and HTTPS CONNECT tunnels.
- Denies configured paths (e.g. `/denied` returns `403`).
- Blocks loopback authorities by default with an explicit allowlist for the lab's own target.
- Optionally requires a `Proxy-Authorization` header.
- Optionally runs over HTTPS with a freshly generated CA.

The lab target:

- Serves `/allowed` (`200`) and `/denied` (`200` if reached, which the proxy is supposed to prevent).
- Optionally runs over HTTPS with a generated certificate scoped to the test host.

Test coverage exercises:

- Absolute-form HTTP proxy requests
- HTTP CONNECT tunneling
- Path denial via the proxy
- Loopback blocking with explicit allowlists
- HTTPS proxy endpoints with scoped CA trust
- node:http global routing
- Caller-supplied agent override (managed mode)
- HTTPS caller agent TLS option preservation
- undici/fetch routing
- WebSocket agent routing
- Forced upgrade through the patched `http.request`
- Explicit CONNECT socket routing
- Ambient `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (with credentials), lowercase variants, `NO_PROXY` exemptions, IPv6 bypass entries, bare endpoints

## Writing tests against Proxyline

A minimal pattern:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { installGlobalProxy } from "@openclaw/proxyline";

test("explain says the proxy is being used", () => {
  const proxy = installGlobalProxy({
    mode: "managed",
    proxyUrl: "http://127.0.0.1:1",
  });
  try {
    const decision = proxy.explain("https://api.example.com/health");
    assert.equal(decision.kind, "proxied");
    assert.equal(decision.reason, "managed-proxy-active");
  } finally {
    proxy.stop();
  }
});
```

Always call `stop()` in `finally`. The runtime is process-global; a leaked install causes the next test's `installProxyline` to throw `RUNTIME_ALREADY_ACTIVE`.

For ambient-mode tests, scope environment changes with a helper that snapshots and restores `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` (and their lowercase forms). See `test/e2e.test.ts` for the `withProxyEnv` helper used by the suite.
