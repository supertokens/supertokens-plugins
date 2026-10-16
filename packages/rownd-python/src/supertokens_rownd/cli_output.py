from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote


def success(result):
    return result.get("status") == "OK" or (
        result.get("status") == "PREVIEW" and result.get("canReconcile") is True
    )


def format_result(result: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    secrets = sorted(
        filter(
            None,
            [
                profile["rownd"]["appKey"],
                profile["rownd"]["appSecret"],
                profile["supertokens"].get("apiKey"),
                profile["supertokens"]["connectionURI"],
            ],
        ),
        key=len,
        reverse=True,
    )

    def redact(value: Any) -> Any:
        if isinstance(value, str):
            for secret in secrets:
                value = value.replace(secret, "***").replace(quote(secret, safe=""), "***")
            return value
        if isinstance(value, list):
            return [redact(item) for item in value]
        if isinstance(value, dict):
            return {redact(key): redact(item) for key, item in value.items()}
        return value

    # Transport diagnostics can contain credentials or full request bodies. Never echo them.
    output = dict(result)
    output.pop("message", None)
    if output.get("status") not in ("OK", "PREVIEW"):
        output["message"] = {
            "NOT_FOUND": "No matching user or Rownd source found",
            "AMBIGUOUS": "Multiple Rownd sources found; select an explicit Rownd user ID",
            "BLOCKED": "Reconciliation blocked by identity, ownership, canonical policy or source consistency checks",
        }.get(
            str(output.get("status")),
            "Reconciliation failed; check profile configuration and service availability",
        )
    if "observationError" in output:
        output["observationError"] = "Final state could not be observed"
    for field in ("blockers", "requiresExecutionProof"):
        if field in output:
            output[field] = [{"code": safe_code(item.get("code"))} for item in output[field]]
    return redact(output)


def safe_code(value):
    return (
        value
        if isinstance(value, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,100}", value)
        else "ERROR"
    )


def failure_result(dry_run):
    result = {"status": "ERROR", "changed": False if dry_run else None, "actions": []}
    if dry_run:
        result.update(
            dryRun=True,
            canReconcile=False,
            matchesSource=False,
            proposedActions=[],
            missingMethods=[],
            blockers=[{"code": "OBSERVATION_FAILED"}],
            requiresExecutionProof=[],
            snapshotOnly=True,
        )
    else:
        result["partialProgress"] = True
    return result
