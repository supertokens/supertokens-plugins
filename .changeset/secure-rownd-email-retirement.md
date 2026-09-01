---
"@supertokens-plugins/rownd-python": minor
---

Add an opt-in email credential retirement mode so operators can prevent authentication through previously replaced Passwordless email aliases while durable email-change completion remains unavailable without Core metadata compare-and-swap. Guard mode disables email-change start and completion, so pending changes must be drained and all workers upgraded before rollout. Direct SuperTokens SDK calls outside plugin-owned APIs remain out of scope.
