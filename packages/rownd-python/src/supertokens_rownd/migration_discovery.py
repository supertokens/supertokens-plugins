from __future__ import annotations

import hashlib
from typing import Optional

from supertokens_python.types import User
from supertokens_python.types.base import UserContext

from .errors import MigrationError
from .migration import RowndIdentitySnapshot, create_rownd_identity_snapshot
from .provider_migration import _entries


async def completed_identity_user(
    source: RowndIdentitySnapshot, target: str, context: UserContext
) -> Optional[User]:
    from . import supertokens_repository as repo

    reverse = repo._mapping_lookup(await repo.get_user_id_mapping(target, "SUPERTOKENS", context))
    if reverse is None or reverse.external_user_id != source.rownd_user_id or reverse.supertokens_user_id != target:
        return None
    user = await repo.get_user(target, context)
    if user is None or not user.is_primary_user or not source.expected_identities:
        return None
    if not await repo.sdk_user_id_matches_internal_target(user.id, target, context):
        return None
    ids = {target, source.rownd_user_id, *(method.recipe_user_id.get_as_string() for method in user.login_methods)}
    records = {identifier: await repo.get_raw_user_metadata(identifier, context) for identifier in ids}
    # Unknown operational markers deliberately disable this optimization. In particular,
    # administrative receipts must be interpreted by full reconciliation, not guessed here.
    for record in records.values():
        if any((key.startswith("rownd_migration_") and key != "rownd_migration_complete")
               or key.startswith("rownd_python_") for key in record):
            return None
        pending = repo.parse_tenant_pending_email_verifications(record, source.tenant_id)
        if not isinstance(pending, tuple) or pending:
            return None
    if records[target].get("rownd_migration_complete") is not True:
        return None
    metadata = await repo.get_user_metadata(target, context)
    original = metadata.get("original_rownd_user")
    if not isinstance(original, dict):
        return None
    try:
        previous = create_rownd_identity_snapshot(original, source.tenant_id, source.app_variant_id)
    except MigrationError:
        return None
    def signature(snapshot: RowndIdentitySnapshot):
        return tuple((item.key, item.verified if item.identifier_type != "email" else False)
                     for item in snapshot.expected_identities)
    if previous.rownd_user_id != source.rownd_user_id or signature(previous) != signature(source):
        return None
    for identity in source.expected_identities:
        matches = [method for method in user.login_methods
                   if repo._migration_method_matches_identity(method, identity)
                   and source.tenant_id in method.tenant_ids]
        if len(matches) != 1 or (identity.recipe_id == "passwordless" and identity.verified and not matches[0].verified):
            return None
        if identity.identifier_type == "email" and repo.rownd_compatibility.get_canonical_email_recipe_user_id(
            metadata, source.tenant_id
        ) != matches[0].recipe_user_id.get_as_string():
            return None
        if identity.identifier_type == "email" and any(
            repo.rownd_compatibility.get_canonical_email_recipe_user_id(record, source.tenant_id)
            not in {None, matches[0].recipe_user_id.get_as_string()} for record in records.values()
        ):
            return None
    if any(source.tenant_id in method.tenant_ids and not any(
        repo._migration_method_matches_identity(method, identity) for identity in source.expected_identities
    ) for method in user.login_methods):
        return None
    try:
        entries = await _entries(target, source.rownd_user_id, source.tenant_id, context)
    except MigrationError:
        return None
    if any(entry.get("state") != "complete" for entry in entries.values()):
        return None
    ledger = "rownd-email-retirement-" + hashlib.sha256((target + "\0" + source.tenant_id).encode()).hexdigest()
    email_record = await repo.get_raw_user_metadata(ledger, context)
    if email_record:
        plan = email_record.get("plan")
        if (not isinstance(plan, dict) or plan.get("state") != "complete"
            or plan.get("target") != target or plan.get("rownd_id") != source.rownd_user_id
            or plan.get("tenant") != source.tenant_id or not isinstance(plan.get("methods"), list)
            or not any(identity.identifier_type == "email" and identity.identifier == plan.get("email")
                       for identity in source.expected_identities)):
            return None
    return user
