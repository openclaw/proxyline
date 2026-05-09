import fs from "node:fs";
export class ProxylineError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "ProxylineError";
        this.code = code;
    }
}
export function resolveProxyTlsCa(options) {
    if (!options) {
        return undefined;
    }
    if (options.ca !== undefined) {
        return options.ca;
    }
    if (options.caFile !== undefined) {
        return fs.readFileSync(options.caFile, "utf8");
    }
    return undefined;
}
export function redactProxyUrl(value) {
    const url = value instanceof URL ? new URL(value.href) : new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
}
