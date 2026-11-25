---
"@supertokens-plugins/rownd-nodejs": patch
"@supertokens-plugins/rownd-python": patch
---

Keep users signed in when an email change fails during verification. Completion revokes the initiating session before committing the change; if a later step fails and the change is rolled back, the verify-email response now carries a new session for the original sign-in method instead of leaving the client with a revoked session. Unexpected errors at that stage return `GENERAL_ERROR` instead of HTTP 500. The original method is restored only if passwordless sign-in would still accept it. When rollback fails, credential cleanup has already started, or the replacement session cannot be created after a committed change, the response returns `GENERAL_ERROR` and clears the client's session (even if the Core revoke call fails) so it signs in again right away. Restored and replacement sessions start with empty payloads, so MFA apps re-prompt for the second factor. Each completion failure logs a debug entry with a stable step ID.
