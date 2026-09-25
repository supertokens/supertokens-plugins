import { createServer, type Server } from "node:http";
import publicKeys from "./rownd-public-jwks.json";

/** Serve a public-only snapshot; tests can supply a generated public JWKS for signed test tokens. */
export async function startRowndJwksServer(keys: { keys: unknown[] } = publicKeys, port = 0): Promise<{
  url: string;
  server: Server;
  close: () => Promise<void>;
  requests: () => number;
}> {
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.url !== "/hub/auth/keys" || request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }
    requests++;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(keys));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("JWKS server has no TCP address");
  return {
    url: `http://127.0.0.1:${address.port}/hub/auth/keys`,
    server,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    requests: () => requests,
  };
}
