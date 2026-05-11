import http from "node:http";
import https from "node:https";
import { ProxyAgent as NodeProxyAgent } from "proxy-agent";
import type { ProxyResolver } from "./types.js";
export type NodeHttpRequestOptions = http.RequestOptions & https.RequestOptions & {
    agent?: http.Agent | false;
};
type NodeHttpMethod = typeof http.request;
type NodeAgentFactory = (options: NodeHttpRequestOptions) => http.Agent;
export declare const CALLER_AGENT_TLS_OPTION_KEYS: readonly ["ca", "cert", "ciphers", "clientCertEngine", "crl", "dhparam", "ecdhCurve", "honorCipherOrder", "key", "maxVersion", "minVersion", "passphrase", "pfx", "rejectUnauthorized", "secureOptions", "secureProtocol", "sessionIdContext"];
export type NodeHttpStackSnapshot = {
    httpRequest: typeof http.request;
    httpGet: typeof http.get;
    httpGlobalAgent: typeof http.globalAgent;
    httpsRequest: typeof https.request;
    httpsGet: typeof https.get;
    httpsGlobalAgent: typeof https.globalAgent;
};
export declare function bindNodeHttpMethod<TMethod extends NodeHttpMethod>(originalMethod: TMethod, createAgent: NodeAgentFactory): TMethod;
export declare function createNodeProxyAgent(resolver: ProxyResolver, proxyCa: string | undefined): NodeProxyAgent;
export declare function createDirectNodeAgent(): NodeProxyAgent;
export {};
//# sourceMappingURL=node-http.d.ts.map