import http from "node:http";
import https from "node:https";
import net from "node:net";
import { ProxyAgent as NodeProxyAgent } from "proxy-agent";
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
];
function copyNodeHttpOptions(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return {};
    }
    return { ...value };
}
function readAgentOptions(agent) {
    if (agent === undefined || agent === false) {
        return undefined;
    }
    return agent.options;
}
function preserveCallerAgentOptions(options) {
    const agentOptions = readAgentOptions(options.agent);
    if (agentOptions === undefined) {
        return;
    }
    for (const key of CALLER_AGENT_TLS_OPTION_KEYS) {
        const value = agentOptions[key];
        if (value !== undefined && options[key] === undefined) {
            options[key] = value;
        }
    }
}
function inferDestinationHostname(url, options) {
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
function preserveDestinationTlsIdentity(url, options) {
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
export function bindNodeHttpMethod(originalMethod, createAgent) {
    return ((...args) => {
        let url;
        let options;
        let callback;
        const firstArg = args[0];
        if (typeof firstArg === "string" || firstArg instanceof URL) {
            url = firstArg;
            if (typeof args[1] === "function") {
                options = {};
                callback = args[1];
            }
            else {
                options = copyNodeHttpOptions(args[1]);
                callback = args[2];
            }
        }
        else {
            options = copyNodeHttpOptions(firstArg);
            callback = args[1];
        }
        preserveCallerAgentOptions(options);
        preserveDestinationTlsIdentity(url, options);
        const agent = createAgent(options);
        options.agent = agent;
        delete options.createConnection;
        if (url !== undefined) {
            const request = originalMethod(url, options, callback);
            request.once("close", () => {
                agent.destroy();
            });
            return request;
        }
        const request = originalMethod(options, callback);
        request.once("close", () => {
            agent.destroy();
        });
        return request;
    });
}
export function createNodeProxyAgent(resolver, proxyCa) {
    return new NodeProxyAgent({
        ...(proxyCa !== undefined ? { ca: proxyCa } : {}),
        getProxyForUrl: resolver.getProxyForUrl,
        httpAgent: new http.Agent(),
        httpsAgent: new https.Agent(),
    });
}
export function createDirectNodeAgent() {
    return new NodeProxyAgent({
        getProxyForUrl: () => "",
        httpAgent: new http.Agent(),
        httpsAgent: new https.Agent(),
    });
}
