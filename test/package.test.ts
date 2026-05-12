import assert from "node:assert/strict";
import test from "node:test";
import { Agent as UndiciAgent } from "undici";
import { installGlobalProxy } from "../dist/index.js";
import { startProxyLab } from "./support/proxy-lab.js";

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

test("package entrypoint patches and restores fetch globals together", async () => {
  const originalFetch = globalThis.fetch;
  const originalFormData = globalThis.FormData;
  const originalHeaders = globalThis.Headers;
  const originalRequest = globalThis.Request;
  const originalResponse = globalThis.Response;
  const preInstallRequest = new originalRequest("data:text/plain,preinstall");
  const proxy = withProxyEnv(
    { HTTP_PROXY: "http://127.0.0.1:9" },
    () => installGlobalProxy({ mode: "ambient" }),
  );
  try {
    assert.notEqual(globalThis.fetch, originalFetch);
    assert.notEqual(globalThis.FormData, originalFormData);
    assert.notEqual(globalThis.Headers, originalHeaders);
    assert.notEqual(globalThis.Request, originalRequest);
    assert.notEqual(globalThis.Response, originalResponse);

    const request = new globalThis.Request("data:text/plain,ok");
    const response = await globalThis.fetch(request);
    const preInstallResponse = await globalThis.fetch(preInstallRequest);

    assert.ok(response instanceof globalThis.Response);
    assert.ok(response.headers instanceof globalThis.Headers);
    assert.equal(await response.text(), "ok");
    assert.ok(preInstallResponse instanceof globalThis.Response);
    assert.ok(preInstallResponse.headers instanceof globalThis.Headers);
    assert.equal(await preInstallResponse.text(), "preinstall");
  } finally {
    proxy.stop();
  }

  assert.equal(globalThis.fetch, originalFetch);
  assert.equal(globalThis.FormData, originalFormData);
  assert.equal(globalThis.Headers, originalHeaders);
  assert.equal(globalThis.Request, originalRequest);
  assert.equal(globalThis.Response, originalResponse);
});

test("package entrypoint global fetch encodes FormData as multipart", async () => {
  const proxy = withProxyEnv(
    { HTTP_PROXY: "http://127.0.0.1:9" },
    () => installGlobalProxy({ mode: "ambient" }),
  );
  try {
    const formData = new globalThis.FormData();
    formData.set("field", "value");
    const request = new globalThis.Request("data:text/plain,ok", {
      body: formData,
      method: "POST",
    });

    assert.match(request.headers.get("content-type") ?? "", /^multipart\/form-data; boundary=/);
  } finally {
    proxy.stop();
  }
});

test("package entrypoint global fetch keeps explicit dispatcher override behavior", async () => {
  const lab = await startProxyLab();
  const proxy = withProxyEnv(
    { HTTP_PROXY: lab.proxyUrl },
    () => installGlobalProxy({ mode: "ambient" }),
  );
  const directDispatcher = new UndiciAgent();
  try {
    const init = { dispatcher: directDispatcher };
    const responseUnknown: unknown = await Reflect.apply(globalThis.fetch, globalThis, [
      `${lab.targetUrl}/denied`,
      init,
    ]);
    if (!(responseUnknown instanceof globalThis.Response)) {
      throw new Error("global fetch returned a non-Response value");
    }
    const response = responseUnknown;

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "target denied endpoint reached unexpectedly\n");
    assert.equal(lab.events.length, 0);
  } finally {
    await directDispatcher.close();
    proxy.stop();
    await lab.close();
  }
});

test("package entrypoint managed fetch ignores explicit dispatcher overrides", async () => {
  const lab = await startProxyLab();
  const proxy = installGlobalProxy({ mode: "managed", proxyUrl: lab.proxyUrl });
  const directDispatcher = new UndiciAgent();
  try {
    const init = { dispatcher: directDispatcher };
    const responseUnknown: unknown = await Reflect.apply(globalThis.fetch, globalThis, [
      `${lab.targetUrl}/denied`,
      init,
    ]);
    if (!(responseUnknown instanceof globalThis.Response)) {
      throw new Error("global fetch returned a non-Response value");
    }
    const response = responseUnknown;

    assert.equal(response.status, 403);
    assert.match(await response.text(), /blocked by proxy lab/);
    assert.notEqual(lab.events.length, 0);

    lab.events.splice(0);
    const inheritedInit = Object.create({ dispatcher: directDispatcher });
    const inheritedResponseUnknown: unknown = await Reflect.apply(globalThis.fetch, globalThis, [
      `${lab.targetUrl}/denied`,
      inheritedInit,
    ]);
    if (!(inheritedResponseUnknown instanceof globalThis.Response)) {
      throw new Error("global fetch returned a non-Response value");
    }
    const inheritedResponse = inheritedResponseUnknown;

    assert.equal(inheritedResponse.status, 403);
    assert.match(await inheritedResponse.text(), /blocked by proxy lab/);
    assert.notEqual(lab.events.length, 0);

    lab.events.splice(0);
    const inheritedPostInit = Object.create({
      body: "inherited-body",
      dispatcher: directDispatcher,
      method: "POST",
    });
    const inheritedPostResponseUnknown: unknown = await Reflect.apply(globalThis.fetch, globalThis, [
      `${lab.targetUrl}/echo`,
      inheritedPostInit,
    ]);
    if (!(inheritedPostResponseUnknown instanceof globalThis.Response)) {
      throw new Error("global fetch returned a non-Response value");
    }
    const inheritedPostResponse = inheritedPostResponseUnknown;

    assert.equal(inheritedPostResponse.status, 200);
    assert.equal(await inheritedPostResponse.text(), "inherited-body");
    assert.notEqual(lab.events.length, 0);

    lab.events.splice(0);
    const requestUnknown: unknown = Reflect.construct(globalThis.Request, [
      `${lab.targetUrl}/denied`,
      { dispatcher: directDispatcher },
    ]);
    if (!(requestUnknown instanceof globalThis.Request)) {
      throw new Error("failed to create Request");
    }
    const requestResponse = await globalThis.fetch(requestUnknown);

    assert.equal(requestResponse.status, 403);
    assert.match(await requestResponse.text(), /blocked by proxy lab/);
    assert.notEqual(lab.events.length, 0);
  } finally {
    await directDispatcher.close();
    proxy.stop();
    await lab.close();
  }
});

test("package entrypoint preserves standard options on preinstall Requests", async () => {
  const lab = await startProxyLab();
  const requestUnknown: unknown = Reflect.construct(globalThis.Request, [
    `${lab.targetUrl}/redirect`,
    { redirect: "manual" },
  ]);
  if (!(requestUnknown instanceof globalThis.Request)) {
    throw new Error("failed to create preinstall Request");
  }
  const request = requestUnknown;
  const proxy = withProxyEnv(
    { HTTP_PROXY: lab.proxyUrl },
    () => installGlobalProxy({ mode: "ambient" }),
  );
  try {
    const response = await globalThis.fetch(request);

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/allowed");
    await response.text();
    assert.notEqual(lab.events.length, 0);
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("package entrypoint lets fetch init body replace a consumed preinstall Request body", async () => {
  const lab = await startProxyLab();
  const requestUnknown: unknown = Reflect.construct(globalThis.Request, [
    `${lab.targetUrl}/echo`,
    { body: "original", method: "POST" },
  ]);
  if (!(requestUnknown instanceof globalThis.Request)) {
    throw new Error("failed to create preinstall Request");
  }
  const request = requestUnknown;
  assert.equal(await request.text(), "original");
  const proxy = withProxyEnv(
    { HTTP_PROXY: lab.proxyUrl },
    () => installGlobalProxy({ mode: "ambient" }),
  );
  try {
    const response = await globalThis.fetch(request, { body: "replacement" });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "replacement");
  } finally {
    proxy.stop();
    await lab.close();
  }
});

test("package entrypoint streams preinstall Request bodies without buffering first", async () => {
  const lab = await startProxyLab();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("streamed"));
      controller.close();
    },
  });
  const requestUnknown: unknown = Reflect.construct(globalThis.Request, [
    `${lab.targetUrl}/echo`,
    { body, duplex: "half", method: "POST" },
  ]);
  if (!(requestUnknown instanceof globalThis.Request)) {
    throw new Error("failed to create preinstall Request");
  }
  const request = requestUnknown;
  Object.defineProperty(request, "arrayBuffer", {
    value: () => {
      throw new Error("preinstall Request body was buffered");
    },
  });
  const proxy = withProxyEnv(
    { HTTP_PROXY: lab.proxyUrl },
    () => installGlobalProxy({ mode: "ambient" }),
  );
  try {
    const response = await globalThis.fetch(request);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "streamed");
  } finally {
    proxy.stop();
    await lab.close();
  }
});
