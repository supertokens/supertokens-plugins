---
"@supertokens-plugins/rownd-nodejs": minor
---

Add opt-in connected sign-in method management, account-wide session revocation, and tools to inspect and repair disconnect policy. Disconnected SSO identities cannot sign back in or be re-added while the owning account exists, even after management is disabled. Full-account deletion erases disconnect policy. Deploy to every backend before enabling; after the first disconnect, do not downgrade to a version without policy and identity-index enforcement. Previously issued access tokens can still pass stateless verification until expiry.
