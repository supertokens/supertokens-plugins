import { createRemoteJWKSet, jwtVerify } from "jose";

const defaultJwksUrl = "https://rownd-hub.supertokens.com/.well-known/rownd-jwks.json";
const defaultIssuer = "https://api.rownd.io";
const appUserIdClaim = "https://auth.rownd.io/app_user_id";

export interface RowndTokenValidationConfig {
  /** Trusted application audience; this does not require administrative credentials. */
  audience: string;
  /** Override for a trusted Rownd-compatible key endpoint (for example, a local test server). */
  jwksUrl?: string;
  /** Expected token issuer; defaults to the production Rownd issuer. */
  issuer?: string;
}

// Reuse jose's bounded key cache, cooldown and in-flight fetch across clients for the same endpoint.
const resolvers = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getResolver(url: URL) {
  const key = url.href;
  let resolver = resolvers.get(key);
  if (!resolver) {
    resolver = createRemoteJWKSet(url, { timeoutDuration: 5000 });
    if (resolvers.size >= 32) resolvers.delete(resolvers.keys().next().value!);
    resolvers.set(key, resolver);
  }
  return resolver;
}

export function createRowndTokenValidator(config: RowndTokenValidationConfig) {
  if (typeof config.audience !== "string" || !/^app:[^\s:]+$/.test(config.audience)) {
    throw new Error("Rownd token validation requires a trusted app audience");
  }
  const url = new URL(config.jwksUrl ?? defaultJwksUrl);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
    url.username || url.password || url.hash) {
    throw new Error("Invalid Rownd JWKS URL");
  }
  const issuer = config.issuer ?? defaultIssuer;
  if (typeof issuer !== "string" || !issuer) throw new Error("Invalid Rownd token issuer");
  const resolver = getResolver(url);

  return async (token: string): Promise<{ user_id: string }> => {
    const { payload } = await jwtVerify(token, resolver, {
      issuer,
      audience: config.audience,
      algorithms: ["EdDSA"],
      requiredClaims: ["exp", "iat", appUserIdClaim],
    });
    const userId = payload[appUserIdClaim];
    if (typeof userId !== "string" || !userId || userId.trim() !== userId ||
      [...userId].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      userId === "." || userId === "..") {
      throw new Error("Invalid Rownd token app_user_id");
    }
    return { user_id: userId };
  };
}
