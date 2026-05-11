import fs from "node:fs";

export type ProxylineTlsOptions = Readonly<{
  ca?: string;
  caFile?: string;
}>;

export class ProxylineError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ProxylineError";
    this.code = code;
  }
}

export function resolveProxyTlsCa(options: ProxylineTlsOptions | undefined): string | undefined {
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

export function formatUrl(value: string | URL): string {
  return value instanceof URL ? value.href : new URL(value).href;
}

export function redactProxyUrl(value: string | URL): string {
  const url = value instanceof URL ? new URL(value.href) : new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}
