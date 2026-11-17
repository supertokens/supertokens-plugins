import {
  GUEST_AUTH_METHOD_ID,
  INSTANT_AUTH_METHOD_ID,
  PUBLIC_TENANT_ID,
} from "./constants";
import type {
  RowndMetadata,
  SuperTokensLoginMethod,
  SuperTokensUser,
} from "./rownd-compatibility";
import { isJsonRecord } from "./utils";

export const SUPERTOKENS_FAKE_EMAIL_DOMAIN = "stfakeemail.supertokens.com";

export function isSyntheticEmail(email: unknown): boolean {
  return (
    typeof email === "string" &&
    email.trim().toLowerCase().endsWith(`@${SUPERTOKENS_FAKE_EMAIL_DOMAIN}`)
  );
}

export type CanonicalEmailResolution =
  | {
      status: "SELECTED";
      email: string;
      recipeUserIds: string[];
      source: "EXPLICIT" | "INFERRED";
    }
  | { status: "NO_EMAIL" | "AMBIGUOUS" | "INVALID_CANONICAL" };

export function resolveCanonicalEmailForTenant(input: {
  user: SuperTokensUser;
  metadata: RowndMetadata;
  tenantId: string;
  // Passwordless preparation also covers unverified imported methods.
  passwordlessOnly?: boolean;
}): CanonicalEmailResolution {
  const { user, metadata, tenantId } = input;
  if (
    metadata.rownd_email_recipe_user_ids !== undefined &&
    !isJsonRecord(metadata.rownd_email_recipe_user_ids)
  ) {
    return { status: "INVALID_CANONICAL" };
  }
  const scopedPointer = metadata.rownd_email_recipe_user_ids?.[tenantId];
  if (
    scopedPointer !== undefined &&
    (typeof scopedPointer !== "string" || !scopedPointer)
  ) {
    return { status: "INVALID_CANONICAL" };
  }
  const pointer =
    scopedPointer ??
    (metadata.rownd_email_recipe_user_ids === undefined
      ? metadata.rownd_email_recipe_user_id
      : undefined);
  const isContactMethod = (method: SuperTokensLoginMethod) =>
    !!method.email &&
    !isSyntheticEmail(method.email) &&
    !(
      method.recipeId === "thirdparty" &&
      (method.thirdParty?.id === GUEST_AUTH_METHOD_ID ||
        method.thirdParty?.id === INSTANT_AUTH_METHOD_ID)
    ) &&
    (!input.passwordlessOnly || method.recipeId === "passwordless");

  if (pointer !== undefined) {
    const method = user.loginMethods.find(
      (candidate) => candidate.recipeUserId.getAsString() === pointer,
    );
    if (method?.tenantIds.includes(tenantId) && isContactMethod(method)) {
      return {
        status: "SELECTED",
        source: "EXPLICIT",
        email: method.email!.trim().toLowerCase(),
        recipeUserIds: [method.recipeUserId.getAsString()],
      };
    }
    // Legacy pointers were global; a known method in another tenant is not a local choice.
    if (
      scopedPointer !== undefined ||
      !method ||
      method.tenantIds.includes(tenantId)
    ) {
      return { status: "INVALID_CANONICAL" };
    }
  }

  const methods = user.loginMethods.filter(
    (method) =>
      method.tenantIds.includes(tenantId) &&
      isContactMethod(method) &&
      (input.passwordlessOnly || method.verified),
  );
  const firstPartyMethods = methods.filter(
    (method) =>
      method.recipeId === "passwordless" || method.recipeId === "emailpassword",
  );
  const candidates = firstPartyMethods.length > 0 ? firstPartyMethods : methods;
  const emails = new Set(
    candidates.map((method) => method.email!.trim().toLowerCase()),
  );
  if (emails.size === 0) return { status: "NO_EMAIL" };

  const originalEmail = metadata.original_rownd_user?.data?.email;
  const normalizedOriginal = typeof originalEmail === "string"
    ? originalEmail.trim().toLowerCase()
    : undefined;
  let email: string | undefined;
  if (firstPartyMethods.length > 0 && emails.size === 1) {
    email = [...emails][0];
  } else if (normalizedOriginal !== undefined) {
    if (emails.has(normalizedOriginal)) email = normalizedOriginal;
  } else if (emails.size === 1) {
    email = [...emails][0];
  }
  if (email === undefined) return { status: "AMBIGUOUS" };

  return {
    status: "SELECTED",
    source: "INFERRED",
    email,
    recipeUserIds: candidates
      .filter((method) => method.email!.trim().toLowerCase() === email)
      .map((method) => method.recipeUserId.getAsString()),
  };
}

export function resolveEmailForAuthentication(
  input: Parameters<typeof resolveCanonicalEmailForTenant>[0] & { email: string },
): CanonicalEmailResolution {
  const canonical = resolveCanonicalEmailForTenant(input);
  if (canonical.status !== "SELECTED" || canonical.source === "EXPLICIT") {
    return canonical;
  }

  const pending = input.metadata.rownd_pending_verification;
  if (
    pending !== undefined &&
    (!Array.isArray(pending) ||
      pending.some(
        (plan) =>
          isJsonRecord(plan) &&
          (plan.tenantId ?? PUBLIC_TENANT_ID) === input.tenantId &&
          (plan.status === "COMMITTING" ||
            "targetCanonicalRecipeUserId" in plan ||
            "retiredMethods" in plan),
      ))
  ) {
    return canonical;
  }

  // A migration snapshot is a display preference, not proof that another attached method was retired.
  const email = input.email.trim().toLowerCase();
  const methods = input.user.loginMethods.filter(
    (method) =>
      method.recipeId === "passwordless" &&
      method.verified &&
      method.tenantIds.includes(input.tenantId) &&
      method.email?.trim().toLowerCase() === email &&
      !isSyntheticEmail(email),
  );
  return methods.length > 0
    ? {
      status: "SELECTED",
      source: "INFERRED",
      email,
      recipeUserIds: methods.map((method) => method.recipeUserId.getAsString()),
    }
    : canonical;
}
