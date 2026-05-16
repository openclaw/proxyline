import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import test from "node:test";
import type { Dispatcher } from "undici";
import {
  createAmbientNodeProxyAgent,
  hasAmbientNodeProxyConfigured,
  installGlobalProxy,
  installProxyline,
  isProxylineDispatcher,
  openProxyConnectTunnel,
  ProxylineError,
  redactProxyUrl,
  type ProxylineEvent,
} from "../src/index.js";
import { formatConnectAuthority } from "../src/connect.js";
import { bindNodeHttpMethod, CALLER_AGENT_TLS_OPTION_KEYS } from "../src/node-http.js";

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

function undiciAgentOptions(dispatcher: Dispatcher): Record<string, unknown> {
  const optionsSymbol = Object.getOwnPropertySymbols(dispatcher)
    .find((symbol) => symbol.description === "options");
  assert.ok(optionsSymbol);
  return (dispatcher as unknown as Record<symbol, unknown>)[optionsSymbol] as Record<string, unknown>;
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

test("managed mode supports dynamic scoped bypass registrations", () => {
  const proxy = installGlobalProxy({
    mode: "managed",
    proxyUrl: "https://proxy.example:8443",
  });

  try {
    assert.equal(proxy.explain("ws://gateway.localhost:18789/", { surface: "websocket" }).kind, "proxied");

    const result = proxy.withBypass(
      { url: "ws://gateway.localhost:18789/" },
      () => proxy.explain("ws://gateway.localhost:18789/", { surface: "websocket" }),
    );

    assert.equal(result.kind, "direct");
    assert.equal(result.reason, "managed-proxy-bypass-policy");
    assert.equal(proxy.explain("ws://gateway.localhost:18789/", { surface: "websocket" }).kind, "proxied");
  } finally {
    proxy.stop();
  }
});

test("managed mode keeps dynamic bypass active for async callbacks", async () => {
  const proxy = installGlobalProxy({
    mode: "managed",
    proxyUrl: "https://proxy.example:8443",
  });

  try {
    const result = await proxy.withBypass(
      { url: "ws://gateway.localhost:18789/" },
      async () => {
        await Promise.resolve();
        return proxy.explain("ws://gateway.localhost:18789/", { surface: "websocket" });
      },
    );

    assert.equal(result.kind, "direct");
    assert.equal(result.reason, "managed-proxy-bypass-policy");
    assert.equal(proxy.explain("ws://gateway.localhost:18789/", { surface: "websocket" }).kind, "proxied");
  } finally {
    proxy.stop();
  }
});

test("managed mode withBypass does not leak to concurrent callers", async () => {
  const proxy = installGlobalProxy({
    mode: "managed",
    proxyUrl: "https://proxy.example:8443",
  });
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });

  try {
    const resultPromise = proxy.withBypass(
      { url: "ws://gateway.localhost:18789/" },
      async () => {
        await pending;
        return proxy.explain("ws://gateway.localhost:18789/", { surface: "websocket" });
      },
    );

    assert.equal(proxy.explain("ws://gateway.localhost:18789/", { surface: "websocket" }).kind, "proxied");
    release();
    const result = await resultPromise;
    assert.equal(result.kind, "direct");
    assert.equal(result.reason, "managed-proxy-bypass-policy");
  } finally {
    proxy.stop();
  }
});

test("managed mode withBypass preserves promise-like callback results", async () => {
  const proxy = installGlobalProxy({
    mode: "managed",
    proxyUrl: "https://proxy.example:8443",
  });

  try {
    let callbackPromise: Promise<ReturnType<typeof proxy.explain>> | undefined;
    const result = proxy.withBypass(
      { url: "ws://gateway.localhost:18789/" },
      () => {
        callbackPromise = Promise.resolve()
          .then(() => proxy.explain("ws://gateway.localhost:18789/", { surface: "websocket" }));
        return callbackPromise;
      },
    );

    assert.equal(result, callbackPromise);
    assert.equal((await result).kind, "direct");
  } finally {
    proxy.stop();
  }
});

test("node HTTPS method patch uses option host overrides for destination SNI", () => {
  let captured: Record<string, unknown> | undefined;
  const request = {
    once() {
      return request;
    },
  } as unknown as http.ClientRequest;
  const method = bindNodeHttpMethod(
    (() => request) as typeof http.request,
    (options) => {
      captured = { ...options };
      return new http.Agent();
    },
  );

  method(new URL("https://url-host.example/"), { hostname: "option-host.example" });

  assert.equal(captured?.servername, "option-host.example");
});

test("node HTTPS method patch keeps URL host SNI when URL options use host", () => {
  let captured: Record<string, unknown> | undefined;
  const request = {
    once() {
      return request;
    },
  } as unknown as http.ClientRequest;
  const method = bindNodeHttpMethod(
    (() => request) as typeof http.request,
    (options) => {
      captured = { ...options };
      return new http.Agent();
    },
  );

  method(new URL("https://url-host.example/"), { host: "[::1]:443" });

  assert.equal(captured?.servername, "url-host.example");
});

test("node HTTPS method patch avoids destination SNI for bracketed IP host requests", () => {
  let captured: Record<string, unknown> | undefined;
  const request = {
    once() {
      return request;
    },
  } as unknown as http.ClientRequest;
  const method = bindNodeHttpMethod(
    (() => request) as typeof http.request,
    (options) => {
      captured = { ...options };
      return new http.Agent();
    },
  );

  method({ protocol: "https:", host: "[::1]:443" });

  assert.equal(captured?.servername, undefined);
});

test("managed mode reuses compatible active runtime and replaces on request", () => {
  const bypassPolicy = ({ url }: { url: string }) => new URL(url).hostname === "gateway.localhost";
  const proxy = installGlobalProxy({
    mode: "managed",
    proxyUrl: "https://proxy.example:8443",
    bypassPolicy,
    undici: { allowH2: false, bodyTimeout: 1_000 },
  });

  try {
    const reused = installGlobalProxy({
      mode: "managed",
      proxyUrl: "https://proxy.example:8443",
      bypassPolicy,
      ifActive: "reuse-compatible",
      undici: { allowH2: false, bodyTimeout: 1_000 },
    });

    assert.equal(reused, proxy);
    assert.throws(
      () =>
        installGlobalProxy({
          mode: "managed",
          proxyUrl: "https://other-proxy.example:8443",
          ifActive: "reuse-compatible",
        }),
      (error: unknown) =>
        error instanceof ProxylineError && error.code === "RUNTIME_ALREADY_ACTIVE",
    );

    const replacement = installGlobalProxy({
      mode: "managed",
      proxyUrl: "https://replacement.example:8443",
      ifActive: "replace",
    });
    assert.notEqual(replacement, proxy);
    assert.equal(replacement.proxyUrl, "https://replacement.example:8443/");
    replacement.stop();
  } finally {
    proxy.stop();
  }
});

test("ambient mode rejects compatible reuse when env snapshot changes", () => {
  withProxyEnv({ HTTP_PROXY: "http://old-proxy.example:8080" }, () => {
    const proxy = installGlobalProxy({ mode: "ambient" });
    try {
      process.env.HTTP_PROXY = "http://new-proxy.example:8080";

      assert.throws(
        () => installGlobalProxy({ mode: "ambient", ifActive: "reuse-compatible" }),
        (error: unknown) =>
          error instanceof ProxylineError && error.code === "RUNTIME_ALREADY_ACTIVE",
      );
    } finally {
      proxy.stop();
    }
  });
});

test("Proxyline undici dispatchers are branded", () => {
  const proxy = installGlobalProxy({
    mode: "managed",
    proxyUrl: "https://proxy.example:8443",
  });

  try {
    assert.equal(isProxylineDispatcher(proxy.createUndiciDispatcher()), true);
  } finally {
    proxy.stop();
  }
});

test("stopped helper undici dispatchers preserve zero timeout options", async () => {
  const proxy = installGlobalProxy({
    mode: "managed",
    proxyUrl: "https://proxy.example:8443",
    undici: { bodyTimeout: 0, headersTimeout: 0 },
  });
  proxy.stop();

  const dispatcher = proxy.createUndiciDispatcher();
  try {
    const options = undiciAgentOptions(dispatcher);

    assert.equal(options.bodyTimeout, 0);
    assert.equal(options.headersTimeout, 0);
  } finally {
    await dispatcher.close();
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
