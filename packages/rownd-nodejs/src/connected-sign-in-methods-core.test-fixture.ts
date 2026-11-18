import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from "testcontainers";

export async function startConnectedSignInMethodsCore() {
  const storage = process.env.CONNECTED_METHODS_TEST_CORE_STORAGE ?? "postgres";
  if (storage !== "postgres" && storage !== "memory") {
    throw new Error("CONNECTED_METHODS_TEST_CORE_STORAGE must be postgres or memory");
  }
  const externalCoreURI = process.env.CONNECTED_METHODS_TEST_CORE_URI;
  if (externalCoreURI !== undefined) {
    const parsed = new URL(externalCoreURI);
    // URL normalisation also accepts abbreviated or integer IPs; require an explicit loopback host.
    if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?\/?$/.test(externalCoreURI)
      || externalCoreURI !== externalCoreURI.trim()
      || parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
      || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("CONNECTED_METHODS_TEST_CORE_URI must be an HTTP loopback origin without credentials, path, query or hash");
    }
    return { connectionURI: parsed.origin, stop: async () => {} };
  }

  let network: StartedNetwork | undefined;
  let postgres: StartedTestContainer | undefined;
  let core: StartedTestContainer | undefined;
  const stop = async () => {
    await core?.stop();
    await postgres?.stop();
    await network?.stop();
  };
  try {
    network = await new Network().start();
    if (storage === "postgres") {
      postgres = await new GenericContainer("postgres:14").withNetwork(network).withNetworkAliases("postgres")
        .withEnvironment({ POSTGRES_USER: "supertokens", POSTGRES_PASSWORD: "somepassword", POSTGRES_DB: "supertokens" })
        .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections")).start();
    }
    core = await new GenericContainer("supertokens/supertokens-postgresql").withNetwork(network)
      .withEnvironment(storage === "postgres"
        ? { POSTGRESQL_CONNECTION_URI: "postgresql://supertokens:somepassword@postgres:5432/supertokens" } : {})
      .withExposedPorts(3567).withWaitStrategy(Wait.forHttp("/hello", 3567)).start();
    return { connectionURI: `http://${core.getHost()}:${core.getMappedPort(3567)}`, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function configureConnectedSignInMethodsTestLicense(connectionURI: string) {
  if (process.env.CONNECTED_METHODS_TEST_CORE_STORAGE === "memory") {
    // Core's built-in in-memory storage enables EE features without license activation.
    const response = await fetch(`${connectionURI}/ee/featureflag`);
    if (!response.ok) {
      throw new Error(`In-memory Core test fixture feature check failed (HTTP ${response.status})`);
    }
    const result = await response.json() as { status?: string; features?: string[] };
    if (result.status !== "OK" || !Array.isArray(result.features) || !result.features.includes("account_linking")) {
      throw new Error("In-memory Core test fixture does not expose the required account_linking feature");
    }
    return;
  }
  const response = await fetch(`${connectionURI}/ee/license`, { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ licenseKey: "N2uEOdEzd1XZZ5VBSTGYaM7Ia4s8wAqRWFAxLqTYrB6GQ=vssOLo3c=PkFgcExkaXs=IA-d9UWccoNKsyUgNhOhcKtM1bjC5OLrYRpTAgN-2EbKYsQGGQRQHuUN4EO1V" }) });
  if (!response.ok) {
    throw new Error(`Core test fixture license activation failed (HTTP ${response.status}); an account-linking-capable fixture is required`);
  }
  const result = await response.json() as { status?: string };
  if (result.status !== "OK") {
    throw new Error("Core test fixture license activation did not succeed; an account-linking-capable fixture is required");
  }
}
