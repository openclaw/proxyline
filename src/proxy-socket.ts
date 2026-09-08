import net from "node:net";
import tls from "node:tls";
import { resolveProxyTlsCa, type ProxylineTlsOptions } from "./shared.js";

/** Connection controls scoped to the proxy hop, never the destination tunnel. */
export type ProxyConnectOptions = Readonly<
  Pick<net.TcpNetConnectOpts, "lookup"> &
  Pick<tls.ConnectionOptions, "ca" | "cert" | "key" | "passphrase" | "servername" | "rejectUnauthorized">
>;

/** Callers validate the HTTP(S) proxy URL before opening its socket. */
export function connectToProxy(
  proxy: URL,
  proxyTls: ProxylineTlsOptions | undefined,
  controls: ProxyConnectOptions = {},
): net.Socket | tls.TLSSocket {
  const host = proxy.hostname.replace(/^\[|\]$/g, "");
  // Copy only supported controls. The selected URL owns host/port, and proxy
  // handshakes require HTTP/1.1 even if a JavaScript caller supplies extra keys.
  const address = {
    host,
    port: proxy.port ? Number(proxy.port) : proxy.protocol === "https:" ? 443 : 80,
    ...(controls.lookup !== undefined ? { lookup: controls.lookup } : {}),
  };
  if (proxy.protocol === "https:") {
    const ca = controls.ca ?? resolveProxyTlsCa(proxyTls);
    const servername = controls.servername ?? (net.isIP(host) === 0 ? host : undefined);
    return tls.connect({
      ...address,
      ALPNProtocols: ["http/1.1"],
      ...(ca !== undefined ? { ca } : {}),
      ...(controls.cert !== undefined ? { cert: controls.cert } : {}),
      ...(controls.key !== undefined ? { key: controls.key } : {}),
      ...(controls.passphrase !== undefined ? { passphrase: controls.passphrase } : {}),
      ...(servername !== undefined ? { servername } : {}),
      // An absent option preserves Node's verification default; explicit
      // undefined would overwrite that default before TLS normalizes it.
      ...(controls.rejectUnauthorized !== undefined
        ? { rejectUnauthorized: controls.rejectUnauthorized }
        : {}),
    });
  }
  return net.connect(address);
}
