---
"@supertokens-plugins/rownd-nodejs": major
---

Rownd profile responses now default `meta.last_sign_in`, `meta.last_active`, and `meta.last_sign_in_method` to `null`. Clients that rely on these fields must pass `include_activity=true` on `GET {apiBasePath}/plugin/rownd/user` to enrich them from active sessions. The former `profile=lightweight-v1` selector is ignored.
