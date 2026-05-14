# Observability

Proxyline exposes its decisions through two channels: an `onEvent` callback and an `explain()` method on the handle. Both share the same `ProxylineDecision` shape and the same credential-redaction rules.

## Events

Subscribe at install time:

```ts
const proxy = installGlobalProxy({
  mode: "managed",
  proxyUrl: "https://user:secret@proxy.corp.example:8443",
  onEvent: (event) => log(event),
});
```

Event types:

- `runtime.installed` — fired once at install. Includes `mode`, `active`, and the redacted `proxyUrl`.
- `runtime.stopped` — fired from `handle.stop()`. Includes `mode`.
- `decision` — fired from every `explain()` call. Includes the full decision.
- `warning` — reserved for future runtime diagnostics.

`runtime.installed` is the cleanest place to confirm "this is the proxy we're actually using" in logs.

## explain()

Ask Proxyline what it would do for a given URL:

```ts
const decision = proxy.explain("https://api.example.com/v1/users", {
  surface: "undici",
});

// decision.kind: "proxied" | "direct" | "blocked"
// decision.reason: "managed-proxy-active" | "ambient-proxy-active" | ...
// decision.surface: "undici"
// decision.url: "https://api.example.com/v1/users"
// decision.proxyUrl: "https://proxy.corp.example:8443/"   (redacted)
```

`explain()` does not perform a request; it inspects the resolver and returns its verdict. It also emits a `decision` event, so a single callback can capture every explicit routing probe in your logs.

After `stop()`, `explain()` returns `kind: "direct"`, `reason: "runtime-stopped"`.

## Credential redaction

Anywhere Proxyline reports a proxy URL — in `handle.proxyUrl`, `decision.proxyUrl`, and the `runtime.installed` event — it passes the URL through `redactProxyUrl`. That strips userinfo, search, and fragment:

```ts
redactProxyUrl("https://user:secret@proxy.example:8443/path?token=abc#fragment");
// → "https://proxy.example:8443/path"
```

Use it on URLs you log yourself to keep credentials out of operational data.

## Logging recipes

### Per-request decision log

```ts
const proxy = installGlobalProxy({
  mode: "managed",
  proxyUrl: process.env.PROXY_URL!,
  onEvent: (event) => {
    if (event.type === "decision") {
      logger.info({
        url: event.decision.url,
        proxyUrl: event.decision.proxyUrl,
        kind: event.decision.kind,
        reason: event.decision.reason,
        surface: event.decision.surface,
      }, "proxy decision");
    }
  },
});
```

`explain()` is decoupled from real requests, so wire it into the codepaths you actually care about, e.g. inside a fetch wrapper:

```ts
async function loggedFetch(url: string, init?: RequestInit) {
  proxy.explain(url, { surface: "undici" });
  return fetch(url, init);
}
```

### Install / stop audit

```ts
onEvent: (event) => {
  if (event.type === "runtime.installed") {
    logger.info({ mode: event.mode, active: event.active, proxyUrl: event.proxyUrl }, "proxyline up");
  } else if (event.type === "runtime.stopped") {
    logger.info({ mode: event.mode }, "proxyline down");
  }
}
```
