import assert from "node:assert/strict";
import test from "node:test";
import {
  installGlobalProxy,
  installProxyline,
  ProxylineError,
  redactProxyUrl,
  type ProxylineEvent,
} from "../src/index.js";

test("managed mode requires an explicit proxy URL", () => {
  assert.throws(
    () => installProxyline({ mode: "managed" }),
    (error: unknown) =>
      error instanceof ProxylineError && error.code === "MANAGED_PROXY_URL_REQUIRED",
  );
});

test("managed mode explains proxied decisions without leaking credentials", () => {
  const events: ProxylineEvent[] = [];
  const proxy = installGlobalProxy({
    mode: "managed",
    proxyUrl: "https://user:secret@proxy.example:8443",
    onEvent: (event) => events.push(event),
  });

  try {
    const decision = proxy.explain("https://api.example.com/v1", { surface: "undici" });

    assert.equal(decision.kind, "proxied");
    assert.equal(decision.reason, "managed-proxy-active");
    assert.equal(decision.proxyUrl, "https://proxy.example:8443/");
    assert.deepEqual(events[0], {
      type: "runtime.installed",
      mode: "managed",
      active: true,
      proxyUrl: "https://proxy.example:8443/",
    });
  } finally {
    proxy.stop();
  }
});

test("ambient mode can be inactive and explain direct routing", () => {
  const proxy = installProxyline({ mode: "ambient" });

  const decision = proxy.explain("https://api.example.com/");

  assert.equal(proxy.active, false);
  assert.equal(decision.kind, "direct");
  assert.equal(decision.reason, "ambient-proxy-not-configured");
});

test("ambient mode ignores explicit proxyUrl", () => {
  const proxy = installProxyline({
    mode: "ambient",
    proxyUrl: "https://proxy.example:8443",
  });

  const decision = proxy.explain("https://api.example.com/");

  assert.equal(proxy.active, false);
  assert.equal(decision.kind, "direct");
  assert.equal(decision.reason, "ambient-proxy-not-configured");
});

test("redactProxyUrl removes credentials, search, and hash", () => {
  assert.equal(
    redactProxyUrl("https://user:secret@proxy.example:8443/path?q=1#frag"),
    "https://proxy.example:8443/path",
  );
});
