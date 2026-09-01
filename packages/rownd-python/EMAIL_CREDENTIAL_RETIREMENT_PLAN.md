# Email Credential Retirement Plan

## Goal

After a verified email change from `A` to `B`, only `B` may authenticate the account in that tenant. Existing codes and future create, resend, or consume attempts for `A` must fail unless a later verified change explicitly makes `A` canonical again.

This plan ports the security outcome of the Node plugin without copying unsafe assumptions into Python. The Python SDK currently has no compare-and-swap metadata update, authoritative consumed recipe-user ID at the API override layer, or conditional recipe-user deletion. Those gaps are explicit implementation gates.

## Invariants

- When tenant-local Passwordless email methods exist, exactly one is canonical. Third-party-only accounts may have none before `ADD_PASSWORDLESS` completes.
- A non-canonical email cannot create, resend, or consume a Passwordless code.
- A successful Core consumption is not trusted until the exact returned login method is validated by owner, tenant, recipe ID, and normalized email.
- Existing codes for retired and reactivated emails are revoked.
- Failures before canonical publication may roll back; failures after publication must roll forward.
- Malformed or ambiguous security metadata fails closed without destructive mutation.
- Other tenants' authentication methods and metadata, phone methods, third-party methods, and unrelated linked identities remain unchanged. Session revocation may intentionally be account-wide when the SDK cannot revoke only the affected tenant.
- No request path deletes or disassociates retired recipe users until Core exposes an atomic conditional operation.

## Non-Goals

- Physical deletion of retired recipe users.
- Repairing arbitrary manually corrupted account-linking state.
- Retiring EmailPassword or third-party methods sharing the same email.
- Intercepting application calls made directly to the SuperTokens SDK outside plugin-owned APIs. Every public helper exported by this package is in scope and must be guarded.
- Adding transactional guarantees that SuperTokens metadata cannot provide.

## Prerequisite Decisions

### Atomic State Publication

An expiring distributed lock is insufficient: a paused holder can resume after lease reassignment and overwrite newer metadata. Durable multi-process completion therefore requires a Core/SDK operation that conditionally updates user metadata using an expected revision or equivalent fencing token.

Before implementation:

1. Confirm or add a Core endpoint and Python SDK API for atomic metadata compare-and-swap.
2. Characterize conflict, timeout, and "write succeeded but response failed" behavior.
3. Store/read a revision suitable for every canonical and `COMMITTING` transition.
4. Establish and document the minimum Core and `supertokens-python` versions that expose the capability.
5. Do not ship multi-process completion if this capability is unavailable.

An in-process lock may reduce contention but is not a correctness boundary. Without compare-and-swap, only Commit 1 classification and non-mutating guard groundwork may ship; durable completion and its security claims remain blocked.

### Authoritative Consumed Identity

The current Passwordless API override returns a user and session, not proof of the exact recipe-user ID consumed. Before consume enforcement:

1. Verify that the installed Python SDK exposes a Passwordless recipe-function override with the authoritative consumed recipe-user ID and can reject before the API creates a session.
2. Add a characterization test proving duplicate same-email methods cannot be confused and denied consumption creates no session.
3. If the hook does not expose the ID or cannot abort before session creation, update the SDK/Core contract first. Do not infer it by searching linked methods after consumption.

## State Model

Extend pending email verification with a versioned strict schema:

```text
schemaVersion: 2
id: operation ID
field: email
normalizedEmail: target email
tenantId: tenant
purpose: UPDATE_PASSWORDLESS | ADD_PASSWORDLESS
initiatingSessionHandle: exact session
initiatingRecipeUserId: exact initiating login method
verificationRecipeUserId: verification subject
status: PENDING | COMMITTING
revision: state revision used for conditional publication
targetCanonicalRecipeUserId: required for COMMITTING
retiredMethods:
  - recipeUserId
    normalizedEmail
```

Transitions:

```text
none -> PENDING -> COMMITTING -> canonical state finalized
           |
           -> superseded before token consumption
```

`COMMITTING` is the roll-forward boundary. It must contain the canonical target and complete retired-method list before old credentials are affected.

Canonical authorization is stored in `rownd_email_recipe_user_ids[tenant_id]`. Legacy `rownd_email_recipe_user_id` is read only when the tenant map is absent.

## Implementation Sequence

### Commit 1: Strict State Parsing and Classification

Files:

- `src/supertokens_rownd/types.py`
- `src/supertokens_rownd/constants.py`
- `src/supertokens_rownd/plugin_implementation.py`
- `tests/test_mapping.py`

Tasks:

1. Add immutable parsed types for pending, committing, retired, and canonical state.
2. Replace permissive filtering with strict tenant-aware parsing.
3. Distinguish absent metadata from present-but-malformed metadata.
4. Validate canonical method ownership, tenant, recipe, normalized email, and verification state.
5. Add read-only classification: `ALLOW`, `TARGET_COMMITTING`, `RETIRED`, `AMBIGUOUS`, `MALFORMED`.
6. Preserve unrelated tenant records without allowing them to affect the requested tenant.
7. Make no authentication behavior changes in this commit.

Tests:

- Valid legacy single-method state.
- Multiple methods without a canonical marker.
- Invalid canonical map/type/ID/topology.
- Complete valid `COMMITTING` plan.
- Missing target, duplicate retired IDs, target listed as retired, invalid tenant/email/ID.
- Malformed plan in another tenant does not block this tenant and is not rewritten.

Review gates:

- Code review for parser invariants and backward compatibility.
- Security review for fail-closed boundaries.
- Full Python suite, Ruff, and Pyright.

### Commit 2: Passwordless Create, Resend, and Consume Guards

Files:

- `src/supertokens_rownd/plugin.py`
- `src/supertokens_rownd/plugin_implementation.py`
- `tests/test_overrides.py`
- `tests/test_integration.py`

Create guard:

1. Normalize email and locate the tenant-local owner.
2. Read and classify the latest account state when an owner exists.
3. Reject retired, ambiguous, malformed, or non-canonical methods.
4. Allow valid canonical and authorized committing targets.
5. Preserve explicit sign-in/sign-up intent for the later intent-parity project.
6. Route the exported `create_magic_link_with_confirmation_bypass` helper through the same authorization guard before it calls `passwordless_asyncio.create_code`.

Resend guard:

1. Resolve both `device_id` and `pre_auth_session_id`.
2. Require matching device records and exactly one contact channel.
3. Run email authorization against the stored device email.
4. Revoke rejected device codes and return restart-flow behavior.

Consume guard:

1. Add the gated Passwordless recipe-function override that validates the authoritative consumed recipe-user ID before the API creates a session.
2. Resolve and classify the stored email before Core consumption.
3. After success, validate that authoritative recipe-user ID against owner, tenant, recipe, normalized email, and canonical/committing state.
4. Return a denied recipe result before session creation on rejection or validation exception.
5. Keep API-layer postcondition validation as defense in depth. If an unexpected session exists, attempt targeted revocation, then account-wide revocation, clear response session state, emit a critical diagnostic on total failure, and never return a successful authentication response.
6. Persist a reconciliation marker for any unexpected total revocation failure and retry account-wide revocation from guarded account activity and operator reconciliation.
7. Do not synchronously delete newly created rejected users; leave them for offline cleanup.

Tests:

- Retired create/resend/consume rejection.
- Valid canonical create/resend/consume.
- Device/pre-auth mismatch, missing channel, dual channel, malformed lookup.
- State changes between precheck and consumption.
- Exact consumed method ambiguity.
- Recipe denial creates no session.
- Defensive targeted revocation, account-wide fallback, durable retry marker, and total revocation failure.
- Exported magic-link helper rejects retired email while preserving phone behavior.
- Phone behavior unchanged.
- Existing mapped owner conflict remains fail closed.

Review gates:

- Security review focused on account adoption and returned identity binding.
- Test review for deterministic override behavior.
- Commit only after all existing sign-in tests pass.

### Commit 3: Durable Roll-Forward Completion

Files:

- `src/supertokens_rownd/plugin_implementation.py`
- `src/supertokens_rownd/plugin.py`
- `tests/test_integration.py`
- `tests/test_mapping.py`

Using compare-and-swap for every state transition:

1. Re-read and validate the exact `PENDING` operation and initiating session.
2. Create or reuse the verified target with automatic linking disabled.
3. Link only after validating owner and topology.
4. Enumerate every other Passwordless email method in the tenant.
5. Conditionally publish the canonical target and complete `COMMITTING` plan against the revision read in step 1.
6. On conflict or an ambiguous response, re-read. An advanced same-operation plan is accepted; an unrelated winner fails closed and cannot be overwritten.
7. Revoke all Passwordless codes for every retired email.
8. Revoke tenant-scoped linked-account sessions when supported. Otherwise revoke all linked-account sessions and document the deliberate cross-tenant sign-out.
9. Finalize compatibility metadata while retaining retirement tombstones.
10. Create the replacement session for the canonical target recipe-user ID.

Failure rules:

- Before confirmed publication: compensate only exact state created by this operation after fresh validation.
- Ambiguous publication: re-read. Any same-operation `COMMITTING` plan is treated as committed.
- Compare-and-swap conflict: never retry from stale state; reclassify the winner and either reconcile that operation or fail closed.
- After publication: never restore the old canonical method; retain the plan and reconcile later.
- Replacement-session failure: revoke all sessions and retain canonical state.
- Total revocation failure: retain a durable retry marker; guards continue to fail closed while reconciliation retries.

Tests:

- `A -> B` with old codes revoked.
- `A -> B -> A`, including stale pre-reactivation `A` code.
- Write succeeds then raises.
- Crash/failure after target creation, plan publication, code revocation, metadata finalization, and session revocation.
- Late linked method after plan publication extends retirement safely.
- Replacement-session failure preserves `B` and revokes sessions.
- Other tenants and phone methods remain unchanged.

Review gates:

- Security and concurrency review before commit.
- No physical deletion or disassociation in the diff.
- Fault-injection tests assert final durable state, not only response errors.

### Commit 4: Cross-Process and Rollout Hardening

Tasks:

1. Run two plugin processes against one Core with compare-and-swap enabled.
2. Add revision conflict, Core timeout, and ambiguous-write tests.
3. Add deterministic concurrent completion, stale-writer, and `A -> B -> A` races.
4. Add observe, guard, and enforce rollout modes.
5. Add reconciliation diagnostics and operator runbook.
6. Raise the `supertokens-python` lower bound and `PLUGIN_SDK_VERSION`, regenerate `uv.lock`, and document the minimum compatible Core version.
7. Test the minimum and latest supported SDK/Core combinations.
8. Update README and add a changeset; Changesets generates the changelog in the release PR.

Review gates:

- Core/SDK compare-and-swap contract reviewed independently.
- Repeated race suite passes without sleeps.
- Completion cannot be enabled when the atomic capability is unavailable.

## Recovery Triggers

Idempotent reconciliation should run during:

- Profile email update preparation.
- Guarded create, resend, and consume for an involved account.
- Explicit operator reconciliation.

For every retired method, retry code revocation. Retry durable session-revocation markers account-wide unless tenant-scoped revocation is available. Keep `COMMITTING` until target/canonical topology and revocation state are confirmed.

## `A -> B -> A` Rules

1. Reuse the exact `A` method only when it belongs to the same primary account.
2. Revoke all `A` codes before reactivation.
3. Publish a new operation making `A` canonical.
4. Retire `B`, revoke its codes, and revoke all sessions.
5. Never authorize an old `A` code created before retirement.

## Observability

Emit stable reason codes without raw emails, codes, tokens, or session handles:

- `email_change_plan_published`
- `email_change_reconcile_completed`
- `email_change_reconcile_failed`
- `retired_create_rejected`
- `retired_resend_rejected`
- `retired_consume_rejected`
- `consumed_identity_mismatch`
- `email_state_malformed`
- `email_state_write_conflict`
- `email_state_write_ambiguous`
- `email_state_atomic_capability_missing`
- `session_revocation_retry_required`

Alert on malformed state, repeated reconciliation failures, identity mismatch, stale `COMMITTING` plans, atomic capability failures, and total session-revocation failure.

## Rollout

1. Deploy strict readers in observe mode.
2. Inventory malformed canonical and pending state.
3. Repair reviewed accounts manually; never guess malformed cleanup targets.
4. Deploy and validate the Core/SDK compare-and-swap capability everywhere.
5. Enable create/resend/consume guards.
6. Enable durable completion for a small tenant cohort.
7. Expand while monitoring stale alias attempts and reconciliation age.
8. During rollback, disable new email changes but keep retirement guards active.

All workers must run the guarded version before completion enforcement begins.

## Acceptance Criteria

- `A` cannot create, resend, consume, or create a new session after verified `A -> B` in that tenant. Existing-session revocation is retried durably until confirmed.
- Existing `A` codes are revoked.
- `A -> B -> A` succeeds without reviving stale codes.
- Exact consumed identity is validated after Core success.
- Malformed or ambiguous state fails closed without mutation.
- Stale cross-process writers cannot overwrite newer canonical state.
- Rejected consumption is denied before session creation. Defensive API handling uses account-wide revocation when targeted revocation fails and never returns a successful authentication response.
- Post-publication failures remain recoverable and never restore the old credential.
- Other tenants' methods and metadata remain intact; account-wide session sign-out is documented when tenant-scoped revocation is unavailable.
- No request path deletes or disassociates retired methods.
- The exported magic-link helper enforces the same email guard as the HTTP create-code path.
- Each implementation commit has focused tests, full-suite verification, code review, and security review.
