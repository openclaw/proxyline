import type { Dispatcher } from "undici";

export const PROXYLINE_DISPATCHER_BRAND = Symbol.for("@openclaw/proxyline.dispatcher");

type ProxylineDispatcher = Dispatcher & {
  [PROXYLINE_DISPATCHER_BRAND]?: true;
};

export function isProxylineDispatcher(dispatcher: unknown): boolean {
  return typeof dispatcher === "object" &&
    dispatcher !== null &&
    (dispatcher as ProxylineDispatcher)[PROXYLINE_DISPATCHER_BRAND] === true;
}
