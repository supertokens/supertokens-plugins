import type { TypeProvider } from "supertokens-node/recipe/thirdparty/types";
import { logDebugMessage } from "./logger";

const RETRYABLE_MESSAGES = new Set([
  "Expected 200 OK from the JSON Web Key Set HTTP response",
  "Failed to parse the JSON Web Key Set HTTP response as JSON",
]);
const RETRYABLE_CODES = new Set([
  "ERR_JWKS_TIMEOUT",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

function isRetryableJwksError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return (
    (typeof error.code === "string" && RETRYABLE_CODES.has(error.code)) ||
    (error.code === "ERR_JOSE_GENERIC" &&
      "message" in error &&
      typeof error.message === "string" &&
      RETRYABLE_MESSAGES.has(error.message))
  );
}

export function withAppleJwksRetry(provider: TypeProvider): TypeProvider {
  if (provider.type !== "oauth2") return provider;
  const implementation =
    provider.config.thirdPartyImplementation ?? provider.id;
  if (!implementation.startsWith("apple")) return provider;

  return {
    ...provider,
    getUserInfo: async (input: Parameters<typeof provider.getUserInfo>[0]) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await provider.getUserInfo(input);
        } catch (error) {
          if (attempt >= 3 || !isRetryableJwksError(error)) throw error;
          const baseDelayMs = 200 * 3 ** (attempt - 1);
          const delayMs = Math.round(baseDelayMs * (1 + Math.random() * 0.25));
          logDebugMessage(
            `Apple JWKS fetch failed; retrying after ${delayMs}ms (attempt ${attempt + 1}/3)`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    },
  };
}
