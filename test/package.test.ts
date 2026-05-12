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
