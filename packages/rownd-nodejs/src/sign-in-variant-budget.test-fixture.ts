// Tuple order: user, mapping and metadata. Keep main's presentation budget
// separate from the incremental cost of disconnect enforcement.
export const mappedVariantSignInBudgets = [
  { mode: "compatibility", recipe: "passwordless", variant: "existing", baseline: [2, 6, 7], policy: [0, 0, 2] },
  { mode: "compatibility", recipe: "passwordless", variant: "added", baseline: [3, 8, 9], policy: [0, 0, 2] },
  { mode: "compatibility", recipe: "thirdparty", variant: "existing", baseline: [2, 4, 5], policy: [0, 0, 3] },
  { mode: "compatibility", recipe: "thirdparty", variant: "added", baseline: [3, 6, 7], policy: [0, 0, 3] },
  { mode: "canonical", recipe: "passwordless", variant: "existing", baseline: [2, 4, 6], policy: [0, 1, 1] },
  { mode: "canonical", recipe: "passwordless", variant: "added", baseline: [2, 4, 7], policy: [0, 1, 1] },
  { mode: "canonical", recipe: "thirdparty", variant: "existing", baseline: [1, 0, 2], policy: [0, 1, 4] },
  { mode: "canonical", recipe: "thirdparty", variant: "added", baseline: [1, 0, 3], policy: [0, 1, 4] },
] as const;
