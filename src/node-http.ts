import http from "node:http";
import https from "node:https";
import net from "node:net";
import { ProxyAgent as NodeProxyAgent } from "proxy-agent";
import type { ProxyResolver } from "./types.js";

export type NodeHttpRequestOptions = http.RequestOptions & https.RequestOptions & {
  agent?: http.Agent | false;
};

type NodeHttpMethod = typeof http.request;
type NodeAgentFactory = (options: NodeHttpRequestOptions) => http.Agent;
type NodeAgentOptions = http.AgentOptions & https.AgentOptions;
type NodeAgentWithOptions = http.Agent & {
  options?: NodeAgentOptions;
};

export const CALLER_AGENT_TLS_OPTION_KEYS = [
  "ca",
  "cert",
  "ciphers",
  "clientCertEngine",
  "crl",
  "dhparam",
  "ecdhCurve",
  "honorCipherOrder",
  "key",
  "maxVersion",
  "minVersion",
  "passphrase",
  "pfx",
  "rejectUnauthorized",
  "secureOptions",
  "secureProtocol",
  "sessionIdContext",
] as const;

export type NodeHttpStackSnapshot = {
  httpRequest: typeof http.request;
  httpGet: typeof http.get;
  httpGlobalAgent: typeof http.globalAgent;
  httpsRequest: typeof https.request;
  httpsGet: typeof https.get;
  httpsGlobalAgent: typeof https.globalAgent;
};

function copyNodeHttpOptions(value: unknown): NodeHttpRequestOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return { ...(value as NodeHttpRequestOptions) };
}

function readAgentOptions(agent: http.Agent | false | undefined): NodeAgentOptions | undefined {
  if (agent === undefined || agent === false) {
    return undefined;
  }
  return (agent as NodeAgentWithOptions).options;
}

function preserveCallerAgentOptions(options: NodeHttpRequestOptions): void {
  const agentOptions = readAgentOptions(options.agent);
  if (agentOptions === undefined) {
    return;
  }
  for (const key of CALLER_AGENT_TLS_OPTION_KEYS) {
    const value = agentOptions[key];
    if (value !== undefined && options[key as keyof NodeHttpRequestOptions] === undefined) {
      options[key as keyof NodeHttpRequestOptions] = value as never;
    }
  }
}

function inferDestinationHostname(
  url: string | URL | undefined,
  options: NodeHttpRequestOptions,
): string | undefined {
  if (url !== undefined) {
    return url instanceof URL ? url.hostname : new URL(url).hostname;
  }
  if (typeof options.hostname === "string") {
    return options.hostname;
  }
  if (typeof options.host === "string") {
    return options.host.replace(/:\d*$/, "");
  }
  return undefined;
}

function preserveDestinationTlsIdentity(
  url: string | URL | undefined,
  options: NodeHttpRequestOptions,
): void {
  if (options.servername !== undefined) {
    return;
  }
  const hostname = inferDestinationHostname(url, options);
  if (!hostname) {
    return;
  }
  if (net.isIP(hostname) === 0) {
    options.servername = hostname;
  }
}

export function bindNodeHttpMethod<TMethod extends NodeHttpMethod>(
  originalMethod: TMethod,
  createAgent: NodeAgentFactory,
): TMethod {
  return ((...args: unknown[]) => {
    let url: string | URL | undefined;
    let options: NodeHttpRequestOptions;
    let callback: unknown;
    const firstArg = args[0];
    if (typeof firstArg === "string" || firstArg instanceof URL) {
      url = firstArg;
      if (typeof args[1] === "function") {
        options = {};
        callback = args[1];
      } else {
        options = copyNodeHttpOptions(args[1]);
        callback = args[2];
      }
    } else {
      options = copyNodeHttpOptions(firstArg);
      callback = args[1];
    }

    preserveCallerAgentOptions(options);
    preserveDestinationTlsIdentity(url, options);
    const agent = createAgent(options);
    options.agent = agent;
    delete options.createConnection;
    if (url !== undefined) {
      const request = originalMethod(url, options, callback as (res: http.IncomingMessage) => void);
      request.once("close", () => {
        agent.destroy();
      });
      return request;
    }
    const request = originalMethod(options, callback as (res: http.IncomingMessage) => void);
    request.once("close", () => {
      agent.destroy();
    });
    return request;
  }) as TMethod;
}

export function createNodeProxyAgent(
  resolver: ProxyResolver,
  proxyCa: string | undefined,
): NodeProxyAgent {
  return new NodeProxyAgent({
    ...(proxyCa !== undefined ? { ca: proxyCa } : {}),
    getProxyForUrl: resolver.getProxyForUrl,
    httpAgent: new http.Agent(),
    httpsAgent: new https.Agent(),
  });
}
