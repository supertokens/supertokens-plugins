import { startRowndJwksServer } from "../src/fixtures/rownd-jwks-server";

const port = Number(process.env.PORT ?? 3002);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("PORT must be an integer between 0 and 65535");
}

startRowndJwksServer(undefined, port).then(({ url }) => {
  console.log(`Serving the copied public Rownd JWKS at ${url}`);
});
