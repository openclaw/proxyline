import { AddressInfo } from "node:net";
import https from "node:https";
import { WebSocketServer } from "ws";
import { createProxyTestCertificate } from "./proxy-cert.js";

export type TestWebSocketServer = {
  url: string;
  ca?: string;
  close: () => Promise<void>;
};

export async function createWebSocketServer(
  options: { secure?: boolean } = {},
): Promise<TestWebSocketServer> {
  const certificate = options.secure ? await createProxyTestCertificate() : undefined;
  const httpsServer =
    certificate === undefined
      ? undefined
      : https.createServer({
          cert: certificate.certificate,
          key: certificate.privateKey,
        });
  const server =
    httpsServer === undefined
      ? new WebSocketServer({ host: "127.0.0.1", port: 0 })
      : new WebSocketServer({ server: httpsServer });
  if (httpsServer !== undefined) {
    httpsServer.listen(0, "127.0.0.1");
  }
  await new Promise<void>((resolve) => {
    (httpsServer ?? server).once("listening", resolve);
  });
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      socket.send(`echo:${data.toString()}`);
    });
  });
  const address = (httpsServer ?? server).address() as AddressInfo;
  return {
    url: `${httpsServer === undefined ? "ws" : "wss"}://127.0.0.1:${address.port}`,
    ...(certificate !== undefined ? { ca: certificate.certificate } : {}),
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
      if (httpsServer !== undefined) {
        await new Promise<void>((resolve, reject) => {
          httpsServer.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        });
      }
      await certificate?.cleanup();
    },
  };
}
