/** net.ts — a free host port, for anything that needs to bind one (the check-cms Postgres container, a template leg's stub CMS). */
import { createServer } from "node:net";

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("could not determine a free port")));
      }
    });
  });
}
