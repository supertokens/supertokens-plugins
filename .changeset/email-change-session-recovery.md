---
"@supertokens-plugins/rownd-nodejs": patch
"@supertokens-plugins/rownd-python": patch
---

Keep users signed in when an email change fails during verification. Completion revokes the initiating session before committing the change; if a later step fails and the change is rolled back, the verify-email response now carries a new session for the original sign-in method instead of leaving the client with a revoked session. Unexpected errors at that stage return `GENERAL_ERROR` instead of HTTP 500. When rollback fails or credential cleanup has already started, the response clears the client's session so it signs in again right away. Each completion failure logs a debug entry with a stable step ID.
