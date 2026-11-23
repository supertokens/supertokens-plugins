---
"@supertokens-plugins/rownd-nodejs": patch
---

Add `error_code: "EMAIL_CHANGE_EMAIL_UNAVAILABLE"` to email ownership conflict responses from the profile PUT routes and the email verification consume route, keeping the existing message. Mark the `phone_number` field synthesized for phone sign-in as read-only so the Hub no longer offers an edit the plugin rejects.
