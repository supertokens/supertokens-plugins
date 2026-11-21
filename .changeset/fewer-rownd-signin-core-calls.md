---
"@supertokens-plugins/rownd-nodejs": patch
---

Reduce redundant Core calls during sign-in and email-change owner checks.

In compatibility mode, recording an app variant reads the metadata it updates fresh from Core without discarding the request's cached reads, so the session-claim refresh after an unchanged variant no longer re-reads the user, mappings and linked metadata. Canonical mode reuses the user returned by sign-in. Session-authentication origin skips user ID mapping lookups when the session's recipe user matches a login method directly and no earlier method could decide a different origin. Email-change owner checks skip mapping lookups when both IDs resolve to the same user.
