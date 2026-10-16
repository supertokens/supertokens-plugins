import type { SuperTokensUserImport } from "./types";
import { sameCorePhoneNumber } from "./migration-phone-identity";

export type ImportMethod = SuperTokensUserImport["loginMethods"][number];
export type MethodRecipe = {
  id: string;
  owner: string;
  primary: boolean;
  ownerMethodCount: number;
  recipeId: string;
  tenantIds: string[];
  verified: boolean;
  email?: string;
  phoneNumber?: string;
  thirdParty?: { id: string; userId: string };
};
export type MethodInspection = {
  method: ImportMethod;
  owners: MethodRecipe[];
  match?: MethodRecipe;
  reconciliationMatch?: MethodRecipe;
  incidentalOwners: string[];
};
export type MethodSnapshot = {
  tenantId: string;
  administrative: boolean;
  contactEmail?: string;
  verifiedEmail?: string;
  sourceMethods: ImportMethod[];
  preferred?: { id: string; primary: boolean; recipes: MethodRecipe[] };
  inspections: MethodInspection[];
  currentEmailRepair: boolean;
  recipes: MethodRecipe[];
};
export type RecipeReference =
  | { kind: "existing"; id: string }
  | { kind: "created"; key: string };
export type MethodAction =
  | { kind: "IMPORT_USER"; methods: ImportMethod[] }
  | { kind: "ENSURE_PRIMARY"; target: string; recipe: RecipeReference }
  | {
      kind: "CREATE_THIRDPARTY";
      recipe: Extract<RecipeReference, { kind: "created" }>;
      method: Extract<ImportMethod, { recipeId: "thirdparty" }>;
    }
  | {
      kind: "CREATE_PASSWORDLESS";
      recipe: Extract<RecipeReference, { kind: "created" }>;
      method: Extract<ImportMethod, { recipeId: "passwordless" }>;
      strategy: "IMPORT_UNVERIFIED" | "SIGN_IN_UP";
    }
  | {
      kind: "LINK";
      recipe: RecipeReference;
      target: string;
      method: ImportMethod;
      expectedOwner?: string;
    }
  | { kind: "VERIFY_ADMIN_EMAIL"; target: string; email: string }
  | {
      kind: "SET_EMAIL_VERIFICATION";
      recipe: RecipeReference;
      email: string;
      verified: boolean;
    };
export type MethodPlan =
  | { status: "BLOCKED"; code: string; reason: string }
  | {
      status: "NOOP" | "PLAN";
      actions: MethodAction[];
      target?: { id: string; recipe: MethodRecipe };
    };

export function matchesMethod(recipe: MethodRecipe, method: ImportMethod) {
  if (recipe.recipeId !== method.recipeId) return false;
  if (method.recipeId === "thirdparty")
    return (
      recipe.thirdParty?.id === method.thirdPartyId &&
      recipe.thirdParty.userId === method.thirdPartyUserId
    );
  if (method.recipeId === "passwordless" && !method.email)
    return sameCorePhoneNumber(recipe.phoneNumber, method.phoneNumber);
  return recipe.email?.toLowerCase() === method.email?.toLowerCase();
}

export function selectMigrationMethods(input: {
  methods: ImportMethod[];
  tenantId: string;
  repairRecipes?: MethodRecipe[];
  canonicalEmailId?: string;
  pendingEmail: boolean;
  administrative: boolean;
  verifiedEmail?: string;
}) {
  return input.methods.filter(
    (method) =>
      !(
        method.recipeId === "passwordless" &&
        method.email &&
        (input.pendingEmail ||
          (input.canonicalEmailId && !input.administrative))
      ) &&
      !input.repairRecipes?.some(
        (recipe) =>
          recipe.tenantIds.includes(input.tenantId) &&
          matchesMethod(recipe, method) &&
          !(
            method.recipeId === "passwordless" &&
            input.verifiedEmail !== undefined &&
            method.email?.toLowerCase() === input.verifiedEmail &&
            !recipe.verified
          ),
      ),
  );
}

export function classifyMethodOwner(
  recipe: MethodRecipe,
  method: ImportMethod,
  preferredHasTenant: boolean,
  email: string | undefined,
  tenantId: string,
) {
  const provider =
    method.recipeId === "thirdparty" &&
    matchesMethod(recipe, method) &&
    !recipe.primary;
  const phone =
    preferredHasTenant &&
    method.recipeId === "passwordless" &&
    method.email === undefined &&
    method.phoneNumber !== undefined &&
    matchesMethod(recipe, method) &&
    recipe.tenantIds.includes(tenantId) &&
    !recipe.primary &&
    recipe.ownerMethodCount === 1;
  const verifiedEmail =
    method.recipeId === "passwordless" &&
    method.email !== undefined &&
    method.isVerified &&
    recipe.recipeId === "passwordless" &&
    recipe.email?.toLowerCase() === method.email.toLowerCase() &&
    !recipe.primary;
  const authenticatedContact =
    email !== undefined &&
    method.recipeId === "passwordless" &&
    method.email !== undefined &&
    recipe.recipeId === "passwordless" &&
    !recipe.primary &&
    recipe.email?.toLowerCase() === email &&
    method.email.toLowerCase() === email &&
    recipe.tenantIds.includes(tenantId) &&
    recipe.tenantIds.length === 1 &&
    recipe.ownerMethodCount === 1;
  return { provider, phone, verifiedEmail, authenticatedContact };
}

export function resolveMethodInspection(
  inspection: Pick<MethodInspection, "method" | "owners" | "incidentalOwners">,
): MethodInspection {
  const { method, owners } = inspection;
  const match = owners.find(
    (recipe) =>
      matchesMethod(recipe, method) &&
      (method.recipeId === "thirdparty" ||
        method.recipeId === "passwordless" ||
        (method.isVerified && recipe.verified)),
  );
  const reconciliationMatch =
    match ??
    (method.recipeId === "passwordless" && method.email && method.isVerified
      ? owners.find((recipe) => recipe.primary && recipe.verified)
      : undefined);
  return { ...inspection, match, reconciliationMatch };
}

export function planMethods(snapshot: MethodSnapshot): MethodPlan {
  const { preferred, tenantId, administrative, contactEmail } = snapshot;
  const inspections = snapshot.inspections.map(resolveMethodInspection);
  const blocked = (code: string, reason: string): MethodPlan => ({
    status: "BLOCKED",
    code,
    reason,
  });
  for (const inspection of inspections)
    if (
      new Set(
        inspection.owners
          .filter((recipe) => matchesMethod(recipe, inspection.method))
          .map((recipe) => recipe.owner),
      ).size > 1
    ) {
      return blocked(
        "PROVIDER_IDENTITY_SPLIT",
        "PROVIDER_IDENTITY_SPLIT: exact login identity has multiple owners",
      );
    }
  const providerMatches = inspections.flatMap((entry) =>
    entry.method.recipeId === "thirdparty" && entry.match ? [entry.match] : [],
  );
  if (preferred && !preferred.recipes.length)
    return blocked(
      "MISSING_TARGET_METHOD",
      "Migrated user has no login methods",
    );
  const elected =
    preferred?.recipes[0] ??
    providerMatches[0] ??
    inspections.find((entry) => entry.reconciliationMatch)?.reconciliationMatch;
  if (!elected) {
    if (inspections.some((entry) => entry.owners.length))
      return blocked(
        "IDENTITY_RESERVED_BY_OTHER_OWNER",
        "Migrated account information is reserved by an existing SuperTokens user and cannot be safely reconciled",
      );
    if (preferred)
      return blocked(
        "MISSING_TARGET_METHOD",
        "Migrated user has no login methods",
      );
    return {
      status: "PLAN",
      actions: [{ kind: "IMPORT_USER", methods: snapshot.sourceMethods }],
    };
  }
  const target = { id: preferred?.id ?? elected.owner, recipe: elected };
  if (!preferred && !providerMatches.length) {
    const verifiedPhoneMatch = inspections.some(({ method }) =>
      method.recipeId === "passwordless" &&
      method.email === undefined &&
      method.phoneNumber !== undefined &&
      method.isVerified &&
      matchesMethod(elected, method) &&
      elected.tenantIds.includes(tenantId),
    );
    if (
      administrative &&
      !verifiedPhoneMatch &&
      (elected.recipeId !== "passwordless" ||
        contactEmail === undefined ||
        elected.email?.toLowerCase() !== contactEmail)
    ) {
      return blocked(
        "CONTACT_ELECTION",
        "Administrative contact election requires a current Rownd email or verified phone identity",
      );
    }
    if (
      (contactEmail !== undefined || administrative) &&
      (elected.primary ||
        elected.ownerMethodCount !== 1 ||
        elected.recipeId !== "passwordless" ||
        elected.tenantIds.length !== 1)
    ) {
      return blocked(
        "CONTACT_ELECTION",
        "Authenticated Rownd contact cannot elect an unrelated primary account",
      );
    }
  }
  const owners = inspections.flatMap((entry) =>
    entry.owners.map((recipe) => ({ recipe, method: entry.method })),
  );
  const foreign = owners.filter(({ recipe }) => recipe.owner !== target.id);
  if (
    (foreign.length || inspections.some((entry) => !entry.match)) &&
    inspections.some((entry) =>
      entry.incidentalOwners.some((owner) => owner !== target.id),
    )
  ) {
    return blocked(
      "INCIDENTAL_CONTACT_CONFLICT",
      "Migrated contact linking conflicts with another primary account",
    );
  }
  const classify = (entry: (typeof owners)[number]) =>
    classifyMethodOwner(
      entry.recipe,
      entry.method,
      preferred?.recipes.some((recipe) =>
        recipe.tenantIds.includes(tenantId),
      ) === true,
      contactEmail,
      tenantId,
    );
  const providerEmailAnchor =
    (providerMatches.length > 0 ||
      preferred?.recipes.some(
        (recipe) =>
          recipe.recipeId === "thirdparty" &&
          recipe.tenantIds.includes(tenantId),
      )) &&
    owners
      .filter((entry) => entry.method.recipeId === "thirdparty")
      .every(
        (entry) => entry.recipe.owner === target.id || classify(entry).provider,
      );
  const phoneAnchor = preferred?.recipes.some(
    (recipe) =>
      recipe.recipeId === "passwordless" &&
      recipe.phoneNumber !== undefined &&
      recipe.tenantIds.includes(tenantId) &&
      snapshot.sourceMethods.some(
        (method) =>
          method.recipeId === "passwordless" &&
          method.email === undefined &&
          matchesMethod(recipe, method),
      ),
  );
  for (const entry of foreign) {
    const eligible = classify(entry);
    if (
      !eligible.provider &&
      !eligible.phone &&
      !eligible.authenticatedContact &&
      !(
        contactEmail === undefined &&
        (providerEmailAnchor || phoneAnchor) &&
        eligible.verifiedEmail
      )
    ) {
      return blocked(
        "FOREIGN_OWNER_NOT_ELIGIBLE",
        "A migrated login method belongs to a different SuperTokens user",
      );
    }
    if (
      snapshot.currentEmailRepair &&
      entry.method.recipeId === "passwordless" &&
      entry.method.email !== undefined &&
      (entry.recipe.primary ||
        entry.recipe.ownerMethodCount !== 1 ||
        !entry.recipe.tenantIds.includes(tenantId))
    ) {
      return blocked(
        "EMAIL_OWNER_NOT_STANDALONE",
        "Current Rownd email belongs to a non-standalone account",
      );
    }
  }
  if (
    inspections.some(
      (entry) => !entry.match && entry.method.recipeId === "emailpassword",
    )
  )
    return blocked(
      "UNSUPPORTED_METHOD_CREATION",
      "Cannot reconcile unsupported login method: emailpassword",
    );
  const actions: MethodAction[] = [];
  const contactOnly =
    contactEmail !== undefined &&
    snapshot.sourceMethods.length === 1 &&
    elected.ownerMethodCount === 1 &&
    elected.recipeId === "passwordless" &&
    elected.email?.toLowerCase() === contactEmail &&
    !foreign.length &&
    inspections.every((entry) => entry.match);
  if (!elected.primary && !contactOnly && inspections.length > 0)
    actions.push({
      kind: "ENSURE_PRIMARY",
      target: target.id,
      recipe: { kind: "existing", id: elected.id },
    });
  for (const entry of new Map(
    foreign.map((entry) => [entry.recipe.id, entry]),
  ).values()) {
    actions.push({
      kind: "LINK",
      target: target.id,
      recipe: { kind: "existing", id: entry.recipe.id },
      method: entry.method,
      expectedOwner: entry.recipe.owner,
    });
  }
  for (const [index, entry] of inspections.entries()) {
    const recipe: RecipeReference = entry.match
      ? { kind: "existing", id: entry.match.id }
      : { kind: "created", key: `method:${index}` };
    const verifiedAnchor =
      !administrative &&
      !entry.match &&
      entry.method.recipeId === "passwordless" &&
      entry.method.email !== undefined &&
      snapshot.recipes.some(
        (method) =>
          method.owner === target.id &&
          method.tenantIds.includes(tenantId) &&
          method.verified &&
          method.email?.toLowerCase() === entry.method.email?.toLowerCase(),
      );
    const method = verifiedAnchor
      ? { ...entry.method, isVerified: true }
      : entry.method;
    if (recipe.kind === "created") {
      if (method.recipeId === "thirdparty")
        actions.push({ kind: "CREATE_THIRDPARTY", recipe, method });
      else if (method.recipeId === "passwordless")
        actions.push({
          kind: "CREATE_PASSWORDLESS",
          recipe,
          method,
          strategy:
            administrative &&
            method.email !== undefined &&
            snapshot.verifiedEmail === undefined
              ? "IMPORT_UNVERIFIED"
              : "SIGN_IN_UP",
        });
      actions.push({ kind: "LINK", target: target.id, recipe, method });
    }
    if (!administrative && method.recipeId === "passwordless" && method.email) {
      actions.push({
        kind: "SET_EMAIL_VERIFICATION",
        recipe,
        email: method.email,
        verified: method.isVerified,
      });
    }
  }
  if (
    administrative &&
    snapshot.verifiedEmail !== undefined &&
    (snapshot.recipes.some(
      (recipe) =>
        recipe.email?.toLowerCase() === snapshot.verifiedEmail &&
        recipe.tenantIds.includes(tenantId) &&
        !recipe.verified &&
        (recipe.owner === target.id ||
          actions.some(
            (action) =>
              action.kind === "LINK" &&
              action.recipe.kind === "existing" &&
              action.recipe.id === recipe.id,
          )),
    ) ||
      actions.some(
        (action) =>
          (action.kind === "CREATE_PASSWORDLESS" ||
            action.kind === "CREATE_THIRDPARTY") &&
          action.method.email?.toLowerCase() === snapshot.verifiedEmail,
      ))
  ) {
    actions.push({
      kind: "VERIFY_ADMIN_EMAIL",
      target: target.id,
      email: snapshot.verifiedEmail,
    });
  }
  return { status: actions.length ? "PLAN" : "NOOP", target, actions };
}

export function methodPlanAllows(
  planned: MethodPlan,
  current: MethodPlan,
): boolean {
  if (
    planned.status === "BLOCKED" ||
    current.status === "BLOCKED" ||
    planned.target?.id !== current.target?.id
  )
    return false;
  const signature = (
    action: MethodAction,
    plan: Exclude<MethodPlan, { status: "BLOCKED" }>,
  ) => {
    if (!("recipe" in action) || action.recipe.kind === "existing")
      return JSON.stringify(action);
    const key = action.recipe.key;
    const creation = plan.actions.find(
      (entry) =>
        (entry.kind === "CREATE_THIRDPARTY" ||
          entry.kind === "CREATE_PASSWORDLESS") &&
        entry.recipe.key === key,
    );
    return JSON.stringify({
      ...action,
      recipe: creation && "method" in creation ? creation.method : undefined,
    });
  };
  const permitted = new Set(
    planned.actions.map((action) => signature(action, planned)),
  );
  return current.actions.every((action) =>
    permitted.has(signature(action, current)),
  );
}
