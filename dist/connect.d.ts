import net from "node:net";
import tls from "node:tls";
import { type ProxylineTlsOptions } from "./shared.js";
export type OpenProxyConnectTunnelOptions = Readonly<{
    proxyUrl: string | URL;
    proxyTls?: ProxylineTlsOptions;
    targetHost: string;
    targetPort: number;
    timeoutMs?: number;
}>;
type ProxySocket = net.Socket | tls.TLSSocket;
export declare function formatConnectAuthority(targetHost: string, targetPort: number): string;
export declare function openProxyConnectTunnel(options: OpenProxyConnectTunnelOptions): Promise<ProxySocket>;
export {};
//# sourceMappingURL=connect.d.ts.map