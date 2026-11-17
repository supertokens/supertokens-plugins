const assert = require("node:assert/strict");
const supertokensModule = require("supertokens-node");
const supertokens = supertokensModule.default ?? supertokensModule;
const { version } = require("../package.json");

async function verify() {
  const originalGetUser = supertokens.getUser;
  const originalModuleGetUser = supertokensModule.getUser;
  const originalFetch = globalThis.fetch;
  const event = { id: 123, custom: { enabled: true } };
  const ticket = { id: 456, extra: [null, true] };
  let upstreamStatus = 200;
  supertokens.getUser = async () => ({
    loginMethods: [
      {
        recipeId: "passwordless",
        email: "fixture@example.com",
        tenantIds: ["fixture-tenant"],
      },
    ],
  });
  supertokensModule.getUser = supertokens.getUser;
  globalThis.fetch = async () =>
    new Response(
      upstreamStatus === 404
        ? "Not Found"
        : JSON.stringify({
            attendees: [{ event, attendee_guests: [{ ticket }] }],
          }),
      { status: upstreamStatus },
    );
  try {
    // Exercise shipping entrypoints, not src: source tests cannot detect stale bundles.
    for (const plugin of [
      require("../dist/index.js"),
      await import("../dist/index.mjs"),
    ]) {
      assert.equal(
        plugin.PLUGIN_VERSION,
        version,
        "Bundle version must match package.json",
      );
      const routes = plugin.init({ apiKey: "fixture-key" }).routeHandlers({
        appInfo: { apiBasePath: { getAsStringDangerous: () => "/auth" } },
      });
      assert.equal(routes.status, "OK");
      const route = routes.routeHandlers.find(
        ({ path }) => path === "/auth/plugin/squadup/tickets",
      );
      assert.ok(route, "Tickets route must exist");
      for (upstreamStatus of [200, 404]) {
        let status;
        let body;
        await route.handler(
          { getKeyValueFromQuery: () => undefined },
          {
            setStatusCode: (value) => {
              status = value;
            },
            sendJSONResponse: (value) => {
              body = value;
            },
          },
          {
            getUserId: () => "fixture-user",
            getTenantId: () => "fixture-tenant",
          },
          {},
        );
        assert.equal(
          status,
          200,
          "Valid metadata and upstream 404 must both succeed",
        );
        assert.deepEqual(body, {
          status: "OK",
          events:
            upstreamStatus === 404
              ? []
              : [
                  {
                    ...event,
                    tickets: [{ ...ticket, pdf_url: null, qrcode_str: null }],
                  },
                ],
        });
      }
    }
  } finally {
    supertokens.getUser = originalGetUser;
    supertokensModule.getUser = originalModuleGetUser;
    globalThis.fetch = originalFetch;
  }
  console.log("CJS and ESM package verification passed.");
}

verify().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
