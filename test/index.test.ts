import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import type { Dispatcher } from "undici";
import {
  createAmbientNodeProxyAgent,
  hasAmbientNodeProxyConfigured,
  installGlobalProxy,
  installProxyline,
  openProxyConnectTunnel,
  ProxylineError,
  redactProxyUrl,
  type ProxylineEvent,
} from "../src/index.js";
import { formatConnectAuthority } from "../src/connect.js";
import { CALLER_AGENT_TLS_OPTION_KEYS } from "../src/node-http.js";

function withProxyEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const keys = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ] as const;
  const previous: Record<string, string | undefined> = {};
  for (const key of keys) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
  try {
    return run();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

const dispatchOptions = {
  method: "GET",
  origin: "http://api.example.com",
  path: "/",
} satisfies Dispatcher.DispatchOptions;

function closedDispatchHandler(onError?: (error: Error) => void): Dispatcher.DispatchHandler {
  return {
    onConnect() {},
    onData() {
      return true;
    },
    onComplete() {},
    ...(onError !== undefined ? { onError } : {}),
    onHeaders() {
      return true;
    },
  };
}

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

test("managed mode explains unsupported URL schemes as direct", () => {
  const proxy = installGlobalProxy({
    mode: "managed",
    proxyUrl: "https://proxy.example:8443",
  });

  try {
    const decision = proxy.explain("ftp://api.example.com/resource", { surface: "unknown" });

    assert.equal(decision.kind, "direct");
    assert.equal(decision.reason, "managed-proxy-unsupported-url-scheme");
    assert.equal(decision.proxyUrl, undefined);
  } finally {
    proxy.stop();
  }
});

test("managed mode explains bypass policy matches as direct", () => {
  const proxy = installGlobalProxy({
    mode: "managed",
    proxyUrl: "https://proxy.example:8443",
    bypassPolicy: ({ url }) => new URL(url).hostname === "gateway.localhost",
  });

  try {
    const decision = proxy.explain("ws://gateway.localhost:18789/", { surface: "websocket" });

    assert.equal(decision.kind, "direct");
    assert.equal(decision.reason, "managed-proxy-bypass-policy");
    assert.equal(decision.proxyUrl, undefined);
  } finally {
    proxy.stop();
  }
});

test("managed undici helper close and destroy callbacks mark dispatchers closed", async () => {
  const proxy = installGlobalProxy({
    mode: "managed",
    proxyUrl: "http://127.0.0.1:9",
  });
  try {
    const closedDispatcher = proxy.createUndiciDispatcher();
    await new Promise<void>((resolve) => {
      closedDispatcher.close(resolve);
    });

    assert.throws(() => closedDispatcher.dispatch(dispatchOptions, closedDispatchHandler()));
    let closedError: Error | undefined;
    assert.equal(
      closedDispatcher.dispatch(
        dispatchOptions,
        closedDispatchHandler((error) => {
          closedError = error;
        }),
      ),
      false,
    );
    assert.ok(closedError);

    const destroyedDispatcher = proxy.createUndiciDispatcher();
    const destroyedCause = new Error("destroyed by test");
    await new Promise<void>((resolve) => {
      destroyedDispatcher.destroy(destroyedCause, resolve);
    });

    let destroyedError: Error | undefined;
    assert.equal(
      destroyedDispatcher.dispatch(
        dispatchOptions,
        closedDispatchHandler((error) => {
          destroyedError = error;
        }),
      ),
      false,
    );
    assert.equal(destroyedError, destroyedCause);
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

test("ambient undici helper close and destroy callbacks mark dispatchers closed", async () => {
  const proxy = withProxyEnv({ HTTP_PROXY: "http://127.0.0.1:9" }, () =>
    installGlobalProxy({ mode: "ambient" }),
  );
  try {
    const closedDispatcher = proxy.createUndiciDispatcher();
    await new Promise<void>((resolve) => {
      closedDispatcher.close(resolve);
    });

    assert.throws(() => closedDispatcher.dispatch(dispatchOptions, closedDispatchHandler()));
    let closedError: Error | undefined;
    assert.equal(
      closedDispatcher.dispatch(
        dispatchOptions,
        closedDispatchHandler((error) => {
          closedError = error;
        }),
      ),
      false,
    );
    assert.ok(closedError);

    const destroyedDispatcher = proxy.createUndiciDispatcher();
    const destroyedCause = new Error("destroyed by test");
    await new Promise<void>((resolve) => {
      destroyedDispatcher.destroy(destroyedCause, resolve);
    });

    let destroyedError: Error | undefined;
    assert.equal(
      destroyedDispatcher.dispatch(
        dispatchOptions,
        closedDispatchHandler((error) => {
          destroyedError = error;
        }),
      ),
      false,
    );
    assert.equal(destroyedError, destroyedCause);
  } finally {
    proxy.stop();
  }
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

test("ambient mode treats lower-case proxy env as higher precedence", () => {
  const proxy = withProxyEnv(
    {
      HTTP_PROXY: "http://upper.example:8080",
      http_proxy: "http://lower.example:8080",
    },
    () => installProxyline({ mode: "ambient" }),
  );
  try {
    const decision = proxy.explain("http://api.example.com/");

    assert.equal(decision.kind, "proxied");
    assert.equal(decision.proxyUrl, "http://lower.example:8080/");
  } finally {
    proxy.stop();
  }
});

test("ambient mode ignores unsupported proxy schemes", () => {
  const proxy = withProxyEnv(
    { ALL_PROXY: "socks-not-supported://proxy.example:1080" },
    () => installProxyline({ mode: "ambient" }),
  );
  try {
    assert.equal(proxy.active, false);
  } finally {
    proxy.stop();
  }
});

test("ambient mode falls back to ALL_PROXY when protocol proxy scheme is unsupported", () => {
  const proxy = withProxyEnv(
    {
      HTTP_PROXY: "socks-not-supported://specific.example:1080",
      ALL_PROXY: "http://fallback.example:8080",
    },
    () => installProxyline({ mode: "ambient" }),
  );
  try {
    const decision = proxy.explain("http://api.example.com/");

    assert.equal(proxy.active, true);
    assert.equal(proxy.proxyUrl, "http://fallback.example:8080/");
    assert.equal(decision.kind, "proxied");
    assert.equal(decision.proxyUrl, "http://fallback.example:8080/");
  } finally {
    proxy.stop();
  }
});

test("ambient Node proxy helper only creates an agent when env proxy applies", () => {
  const inactiveAgent = withProxyEnv({}, () => createAmbientNodeProxyAgent());
  assert.equal(inactiveAgent, undefined);

  const httpOnlyHttps = withProxyEnv({ HTTP_PROXY: "http://proxy.example:8080" }, () =>
    createAmbientNodeProxyAgent({ protocol: "https" }),
  );
  assert.equal(httpOnlyHttps, undefined);

  const httpsAgent = withProxyEnv({ HTTPS_PROXY: "http://proxy.example:8080" }, () =>
    createAmbientNodeProxyAgent({ protocol: "https" }),
  );
  try {
    assert.ok(httpsAgent);
  } finally {
    httpsAgent?.destroy();
  }

  const allProxyAgent = withProxyEnv({ ALL_PROXY: "http://proxy.example:8080" }, () =>
    createAmbientNodeProxyAgent({ protocol: "https" }),
  );
  try {
    assert.ok(allProxyAgent);
  } finally {
    allProxyAgent?.destroy();
  }
});

test("ambient Node proxy configured helper honors protocol and no-proxy", () => {
  const hasHttp = withProxyEnv({ HTTP_PROXY: "http://proxy.example:8080" }, () =>
    hasAmbientNodeProxyConfigured({ protocol: "http" }),
  );
  const hasHttps = withProxyEnv({ HTTP_PROXY: "http://proxy.example:8080" }, () =>
    hasAmbientNodeProxyConfigured({ protocol: "https" }),
  );
  const bypassed = withProxyEnv(
    { HTTPS_PROXY: "http://proxy.example:8080", NO_PROXY: "proxyline.invalid" },
    () => hasAmbientNodeProxyConfigured({ protocol: "https" }),
  );

  assert.equal(hasHttp, true);
  assert.equal(hasHttps, false);
  assert.equal(bypassed, false);
});

test("ambient Node proxy configured helper honors wildcard no-proxy", () => {
  const bypassed = withProxyEnv(
    { HTTPS_PROXY: "http://proxy.example:8080", NO_PROXY: "*" },
    () => hasAmbientNodeProxyConfigured({ protocol: "https" }),
  );

  assert.equal(bypassed, false);
});

test("ambient Node proxy helper uses the provided env snapshot for routing", () => {
  const agent = withProxyEnv({}, () =>
    createAmbientNodeProxyAgent({
      env: {
        HTTP_PROXY: undefined,
        HTTPS_PROXY: "http://snapshot.example:8080",
        ALL_PROXY: undefined,
        NO_PROXY: undefined,
        http_proxy: undefined,
        https_proxy: undefined,
        all_proxy: undefined,
        no_proxy: undefined,
      },
    }),
  );
  try {
    assert.ok(agent);
    assert.equal(
      agent.getProxyForUrl("https://api.example.com/", undefined as never),
      "http://snapshot.example:8080/",
    );
  } finally {
    agent?.destroy();
  }
});

test("ambient mode explains unsupported URL schemes as not configured", () => {
  const proxy = withProxyEnv(
    { HTTP_PROXY: "http://proxy.example:8080", NO_PROXY: "corp.example" },
    () => installProxyline({ mode: "ambient" }),
  );
  try {
    const decision = proxy.explain("ftp://corp.example/resource");

    assert.equal(decision.kind, "direct");
    assert.equal(decision.reason, "ambient-proxy-not-configured");
  } finally {
    proxy.stop();
  }
});

test("ambient mode suffix no-proxy entries also match the root host", () => {
  for (const noProxy of [".corp.example", "*.corp.example"]) {
    const proxy = withProxyEnv(
      { HTTP_PROXY: "http://proxy.example:8080", NO_PROXY: noProxy },
      () => installProxyline({ mode: "ambient" }),
    );
    try {
      const decision = proxy.explain("http://corp.example/");

      assert.equal(decision.kind, "direct");
      assert.equal(decision.reason, "no-proxy-match");
    } finally {
      proxy.stop();
    }
  }
});

test("redactProxyUrl removes credentials, search, and hash", () => {
  assert.equal(
    redactProxyUrl("https://user:secret@proxy.example:8443/path?q=1#frag"),
    "https://proxy.example:8443/path",
  );
});

test("documented TLS preservation keys match runtime list", () => {
  const surfacesDoc = fs.readFileSync("docs/surfaces.md", "utf8").replace(/\r\n/g, "\n");
  const match = surfacesDoc.match(
    /TLS identity preservation[\s\S]*?\n\n(`[^`\n]+`(?:, `[^`\n]+`)*)\./,
  );
  assert.ok(match);
  const documentedKeys = match[1]?.split(", ").map((key) => key.replace(/`/g, ""));

  assert.deepEqual(documentedKeys, [...CALLER_AGENT_TLS_OPTION_KEYS]);
});

test("CONNECT authority formatting rejects unsafe hosts and brackets IPv6", () => {
  assert.equal(formatConnectAuthority("::1", 443), "[::1]:443");
  assert.equal(formatConnectAuthority("[::1]", 443), "[::1]:443");
  assert.throws(
    () => formatConnectAuthority("", 443),
    (error: unknown) =>
      error instanceof ProxylineError && error.code === "INVALID_CONNECT_TARGET",
  );
  assert.throws(
    () => formatConnectAuthority("api.example.com\r\nProxy-Authorization: injected", 443),
    (error: unknown) =>
      error instanceof ProxylineError && error.code === "INVALID_CONNECT_TARGET",
  );
  assert.throws(
    () => formatConnectAuthority("api.example.com", 0),
    (error: unknown) =>
      error instanceof ProxylineError && error.code === "INVALID_CONNECT_TARGET",
  );
  assert.throws(
    () => formatConnectAuthority("api.example.com", 65_536),
    (error: unknown) =>
      error instanceof ProxylineError && error.code === "INVALID_CONNECT_TARGET",
  );
  for (const unsafeHost of [
    "[api.example.com",
    "api.example.com]",
    "api.example.com:443",
    "api.example.com/path",
    "user@api.example.com",
    "api.example.com?debug=true",
    "api.example.com#fragment",
  ]) {
    assert.throws(
      () => formatConnectAuthority(unsafeHost, 443),
      (error: unknown) =>
        error instanceof ProxylineError && error.code === "INVALID_CONNECT_TARGET",
    );
  }
});

test("CONNECT helper rejects unsupported proxy schemes with the documented code", async () => {
  await assert.rejects(
    openProxyConnectTunnel({
      proxyUrl: "socks://proxy.example:1080",
      targetHost: "api.example.com",
      targetPort: 443,
    }),
    (error: unknown) =>
      error instanceof ProxylineError && error.code === "UNSUPPORTED_PROXY_PROTOCOL",
  );
});
