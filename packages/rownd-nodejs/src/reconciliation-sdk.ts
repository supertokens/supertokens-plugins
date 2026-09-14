import SuperTokens from "supertokens-node";
import AccountLinking from "supertokens-node/recipe/accountlinking";
import EmailVerification from "supertokens-node/recipe/emailverification";
import UserMetadata from "supertokens-node/recipe/usermetadata";
import Passwordless from "supertokens-node/recipe/passwordless";
import ThirdParty from "supertokens-node/recipe/thirdparty";
import Multitenancy from "supertokens-node/recipe/multitenancy";
import { hasReconciliationReads, invalidateReconciliationReads, reconciliationRead, reconciliationProgress } from "./reconciliation-reads";

function invalidateGraphs() {
  invalidateReconciliationReads("user");
  invalidateReconciliationReads("search");
}

// These local facades never replace SDK methods or depend on its mutable Core cache.
function facade<T extends object>(sdk: T, recipe: string): T {
  return new Proxy(sdk, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string") return value;
      return (...args: unknown[]) => {
        const call = () => Reflect.apply(value, target, args);
        if (!hasReconciliationReads()) return call();
        if (recipe === "core" && property === "getUser") return reconciliationRead("user", String(args[0]), call);
        if (recipe === "core" && property === "getUserIdMapping") {
          const input = args[0] as { userId: string; userIdType?: string };
          return reconciliationRead("mapping", JSON.stringify([input.userIdType ?? "ANY", input.userId]), call);
        }
        if (recipe === "core" && property === "listUsersByAccountInfo") {
          const info = args[1] as { email?: string; phoneNumber?: string; thirdParty?: { id: string; userId: string } };
          return reconciliationRead("search", JSON.stringify([args[0], info.email, info.phoneNumber, info.thirdParty?.id, info.thirdParty?.userId, args[2] ?? false]), call);
        }
        if (recipe === "metadata" && property === "getUserMetadata") return reconciliationRead("metadata", String(args[0]), call);
        if (recipe === "verification" && property === "isEmailVerified") {
          return reconciliationRead("verification", JSON.stringify([(args[0] as { getAsString(): string }).getAsString(), args[1]]), call);
        }
        const mappingWrite = recipe === "core" && ["createUserIdMapping", "deleteUserIdMapping", "updateOrDeleteUserIdMappingInfo"].includes(property);
        const metadataWrite = recipe === "metadata" && ["updateUserMetadata", "clearUserMetadata"].includes(property);
        const verificationWrite = recipe === "verification" && ["verifyEmailUsingToken", "unverifyEmail"].includes(property);
        const graphWrite = (recipe === "linking" && ["linkAccounts", "unlinkAccount", "createPrimaryUser"].includes(property)) ||
          (recipe === "core" && property === "deleteUser") ||
          (recipe === "passwordless" && ["signInUp", "consumeCode", "updateUser"].includes(property)) ||
          (recipe === "thirdparty" && ["signInUp", "manuallyCreateOrUpdateUser"].includes(property)) ||
          (recipe === "tenant" && ["associateUserToTenant", "disassociateUserFromTenant"].includes(property));
        if (!mappingWrite && !metadataWrite && !verificationWrite && !graphWrite) return call();
        const invalidate = () => {
          if (metadataWrite) invalidateReconciliationReads("metadata", String(args[0]));
          if (mappingWrite) invalidateReconciliationReads("mapping");
          if (recipe === "core" && property === "deleteUser") {
            invalidateReconciliationReads("mapping");
            invalidateReconciliationReads("metadata");
          }
          if (verificationWrite || graphWrite) invalidateReconciliationReads("verification");
          if (mappingWrite || graphWrite || verificationWrite) invalidateGraphs();
        };
        reconciliationProgress({ stage: "execution", action: property });
        invalidate();
        return Promise.resolve().then(call).finally(invalidate);
      };
    },
  });
}

export const reconciliationSuperTokens = facade(SuperTokens, "core");
export const reconciliationAccountLinking = facade(AccountLinking, "linking");
export const reconciliationEmailVerification = facade(EmailVerification, "verification");
export const reconciliationUserMetadata = facade(UserMetadata, "metadata");
export const reconciliationPasswordless = facade(Passwordless, "passwordless");
export const reconciliationThirdParty = facade(ThirdParty, "thirdparty");
export const reconciliationMultitenancy = facade(Multitenancy, "tenant");
