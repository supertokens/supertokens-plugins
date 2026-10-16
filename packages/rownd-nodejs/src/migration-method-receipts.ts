import type { SuperTokensUserImport } from "./types";

const observers = new WeakMap<SuperTokensUserImport, (recipeId: string) => Promise<void>>();

export function observeAdministrativeMethodCreation(source: SuperTokensUserImport, observer: (recipeId: string) => Promise<void>) {
  observers.set(source, observer);
}

export async function recordAdministrativeMethodCreation(source: SuperTokensUserImport, recipeId: string) {
  await observers.get(source)?.(recipeId);
}
