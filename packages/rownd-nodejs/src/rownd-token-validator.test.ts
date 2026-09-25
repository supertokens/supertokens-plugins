import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRowndTokenValidator } from "./rownd-token-validator";
import { startRowndJwksServer } from "./fixtures/rownd-jwks-server";

describe("Rownd token verification", () => {
  let server: Awaited<ReturnType<typeof startRowndJwksServer>>;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let verify: ReturnType<typeof createRowndTokenValidator>;

  beforeAll(async () => {
    const pair = await generateKeyPair("EdDSA");
    privateKey = pair.privateKey;
    const publicKey = { ...await exportJWK(pair.publicKey), kid: "test-key", alg: "EdDSA", use: "sig" };
    server = await startRowndJwksServer({ keys: [publicKey] });
    verify = createRowndTokenValidator({ audience: "app:my-app", jwksUrl: server.url });
  });
  afterAll(async () => { await server?.close(); });

  async function token(input: { issuer?: string; audience?: string; claims?: Record<string, unknown>; expiresIn?: string | number } = {}) {
    return new SignJWT({ "https://auth.rownd.io/app_user_id": "user-1", ...input.claims })
      .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
      .setIssuer(input.issuer ?? "https://api.rownd.io")
      .setAudience(input.audience ?? "app:my-app")
      .setIssuedAt()
      .setExpirationTime(input.expiresIn ?? "1h")
      .sign(privateKey);
  }

  it("verifies signed tokens and shares one JWKS fetch across validators", async () => {
    const signed = await token();
    const other = createRowndTokenValidator({ audience: "app:my-app", jwksUrl: server.url });
    expect(await Promise.all([verify(signed), other(signed)])).toEqual([{ user_id: "user-1" }, { user_id: "user-1" }]);
    expect(server.requests()).toBe(1);
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
    expect(await verify(await token())).toEqual({ user_id: "user-1" });
    expect(await verify(await token({ claims: { "https://auth.rownd.io/auth_level": "instant" } }))).toEqual({ user_id: "user-1" });
    expect(() => createRowndTokenValidator({ audience: "app:my-app", jwksUrl: "http://untrusted.example/keys" })).toThrow("JWKS URL");
  });
});
