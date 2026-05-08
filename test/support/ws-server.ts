import { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

export type TestWebSocketServer = {
  url: string;
  close: () => Promise<void>;
};

export async function createWebSocketServer(): Promise<TestWebSocketServer> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      socket.send(`echo:${data.toString()}`);
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}`,
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
    },
  };
}
