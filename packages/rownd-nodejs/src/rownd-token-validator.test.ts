import { createServer, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import { createRowndTokenValidator } from "./rownd-token-validator";
import { authenticateExistingRowndMigration, authenticateRowndMigration } from "./migration-email";
import { setRowndClient, setRowndTokenValidator } from "./rownd-repository";

describe("Rownd token verification", () => {
  let server: Server;
  let jwksUrl: string;
  let requests = 0;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let verify: ReturnType<typeof createRowndTokenValidator>;
  const issuedAt = Math.floor(Date.now() / 1000) - 60;
  const validated = { user_id: "user-1", iat: issuedAt };

  afterEach(() => {
    setRowndClient(undefined);
    vi.restoreAllMocks();
  });

  beforeAll(async () => {
    const pair = await generateKeyPair("EdDSA");
    privateKey = pair.privateKey;
    const publicKey = { ...await exportJWK(pair.publicKey), kid: "test-key", alg: "EdDSA", use: "sig" };
    server = createServer((request, response) => {
      if (request.url !== "/keys" || request.method !== "GET") {
        response.writeHead(404).end();
        return;
      }
      requests++;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [publicKey] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test JWKS server has no TCP address");
    jwksUrl = `http://127.0.0.1:${address.port}/keys`;
    verify = createRowndTokenValidator({ audience: "app:my-app", jwksUrl });
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  async function token(input: { issuer?: string; audience?: string; claims?: Record<string, unknown>; expiresIn?: number } = {}) {
    return new SignJWT({ "https://auth.rownd.io/app_user_id": "user-1", iat: issuedAt,
      exp: input.expiresIn ?? issuedAt + 3600, ...input.claims })
      .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
      .setIssuer(input.issuer ?? "https://api.rownd.io")
      .setAudience(input.audience ?? "app:my-app")
      .sign(privateKey);
  }

  it("verifies signed tokens and shares one JWKS fetch across validators", async () => {
    const signed = await token();
    const other = createRowndTokenValidator({ audience: "app:my-app", jwksUrl });
    expect(await Promise.all([verify(signed), other(signed)])).toEqual([validated, validated]);
    expect(requests).toBe(1);
  });

  it("rejects wrong issuer, audience, expiry, absent and malformed app user IDs", async () => {
    for (const invalid of [
      { issuer: "https://evil.example" },
      { audience: "app:other" },
      { expiresIn: Math.floor(Date.now() / 1000) - 60 },
      { claims: { "https://auth.rownd.io/app_user_id": undefined, app_user_id: "user-1" } },
      { claims: { "https://auth.rownd.io/app_user_id": ".." } },
    ]) {
      await expect(verify(await token(invalid))).rejects.toThrow();
    }
  });

  it("rejects tampering, untrusted signing keys and missing app scope", async () => {
    const signed = await token();
    const [header, payload, signature] = signed.split(".");
    await expect(verify(`${header}.${payload}.${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`)).rejects.toThrow();
    const foreign = await generateKeyPair("EdDSA");
    await expect(verify(await new SignJWT({ "https://auth.rownd.io/app_user_id": "user-1" })
      .setProtectedHeader({ alg: "EdDSA", kid: "test-key" }).setIssuer("https://api.rownd.io")
      .setAudience("app:my-app").setIssuedAt().setExpirationTime("1h").sign(foreign.privateKey))).rejects.toThrow();
    expect(() => createRowndTokenValidator({ audience: "" })).toThrow("audience");
  });

  it("requires an app audience without requiring authentication-level claims", async () => {
    await expect(verify(await token({ audience: "app:another-app" }))).rejects.toThrow();
    expect(await verify(await token())).toEqual(validated);
    expect(await verify(await token({ claims: { "https://auth.rownd.io/auth_level": "instant" } }))).toEqual(validated);
    expect(() => createRowndTokenValidator({ audience: "app:my-app", jwksUrl: "http://untrusted.example/keys" })).toThrow("JWKS URL");
  });

  it.each([undefined, "access_token", "refresh_token"])("accepts supported JWT type %s", async (type) => {
    expect(await verify(await token({ claims: { "https://auth.rownd.io/jwt_type": type } }))).toEqual(validated);
  });

  it.each(["id_token", "", null, 123, {}])("rejects unsupported explicit JWT type %j", async (type) => {
    await expect(verify(await token({ claims: { "https://auth.rownd.io/jwt_type": type } })))
      .rejects.toThrow("Unsupported Rownd token type");
  });

  it.each([
    { exp: undefined }, { exp: issuedAt - 1 }, { iat: undefined }, { iat: "invalid" },
  ])("requires expiry and issued-at for signed refresh tokens: %j", async (claims) => {
    await expect(verify(await token({ claims: { "https://auth.rownd.io/jwt_type": "refresh_token", ...claims } })))
      .rejects.toThrow();
  });

  it.each([undefined, "refresh_token"])("enforces live profile cutoff for signed type %s", async (type) => {
    vi.spyOn(UserMetadata, "getUserMetadata").mockResolvedValue({ status: "OK", metadata: {} });
    let cutoff: unknown = undefined;
    const fetchUserInfo = vi.fn(async () => ({
      state: "enabled", auth_level: "verified", data: { user_id: "user-1", email: "user@example.com" },
      verified_data: {}, meta: { tokens_valid_since: cutoff },
    }));
    setRowndClient({ validateToken: verify, fetchUserInfo });
    setRowndTokenValidator(verify);
    const signed = await token({ claims: { "https://auth.rownd.io/jwt_type": type } });
    for (cutoff of [undefined, new Date((issuedAt - 1) * 1000).toISOString(), new Date(issuedAt * 1000).toISOString()]) {
      expect((await authenticateRowndMigration(signed, "public", {})).rowndUserId).toBe("user-1");
    }
    for (cutoff of [new Date(issuedAt * 1000 + 1).toISOString(), "invalid", null, 123]) {
      await expect(authenticateRowndMigration(signed, "public", {})).rejects.toThrow("tokens_valid_since");
    }
    expect(fetchUserInfo).toHaveBeenCalledTimes(7);
    fetchUserInfo.mockClear();
    expect(await authenticateExistingRowndMigration(signed, "public", {})).toBe("user-1");
    expect(fetchUserInfo).not.toHaveBeenCalled();
    setRowndTokenValidator(async () => ({ user_id: "user-1" }));
    cutoff = new Date(issuedAt * 1000).toISOString();
    await expect(authenticateRowndMigration(signed, "public", {})).rejects.toThrow("tokens_valid_since");
  });
});
