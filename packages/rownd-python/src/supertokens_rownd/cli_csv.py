from __future__ import annotations

import asyncio
import csv
import os
import time
from pathlib import Path

from .cli_output import failure_result, format_result, safe_code, success
from .cli_profiles import CliError


def parse_csv(text, id_column="rownd_user_id"):
    # csv.reader(strict=True) still accepts quotes inside unquoted fields.
    rows, row, field, state = [], [], "", "unquoted"
    text = text.removeprefix("\ufeff")
    i = 0
    while i < len(text):
        char = text[i]
        if state == "quoted":
            if char == '"':
                if i + 1 < len(text) and text[i + 1] == '"':
                    field += '"'
                    i += 1
                else:
                    state = "closed"
            else:
                field += char
        elif char in ",\r\n":
            row.append(field)
            field, state = "", "unquoted"
            if char != ",":
                rows.append(row)
                row = []
                if char == "\r" and i + 1 < len(text) and text[i + 1] == "\n":
                    i += 1
        elif char == '"' and state == "unquoted" and not field:
            state = "quoted"
        else:
            if state == "closed" or char == '"':
                raise CliError("Malformed CSV quoting")
            field += char
        i += 1
    if state == "quoted":
        raise CliError("CSV has an unterminated quoted field")
    if row or field or state == "closed":
        rows.append([*row, field])
    rows = [row for row in rows if not (len(row) == 1 and not row[0].strip())]
    if not rows:
        raise CliError("CSV is empty; a header and at least one Rownd ID are required")
    header = [value.strip() for value in rows[0]]
    if header.count(id_column) != 1:
        raise CliError(
            "CSV ID column must occur exactly once; use --id-column to select its header"
        )
    column = header.index(id_column)
    ids, duplicates = {}, 0
    for number, row in enumerate(rows[1:], 2):
        if len(row) != len(header):
            raise CliError(f"CSV record {number} has a different number of columns than the header")
        value = row[column].strip()
        if not value or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value):
            raise CliError(
                f"CSV record {number} requires a non-empty Rownd ID without whitespace or control characters"
            )
        if value in ids:
            duplicates += 1
        ids[value] = None
    if not ids:
        raise CliError("CSV contains no Rownd IDs")
    return list(ids), duplicates


def read_csv(path, id_column):
    try:
        text = Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        raise CliError("Cannot read CSV file; check --file and file permissions") from None
    return parse_csv(text, id_column)


class FailedFile:
    def __init__(self, path):
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except OSError:
            raise CliError(
                "Cannot create --failed-file; choose a new file in an existing writable directory"
            ) from None
        self.file = os.fdopen(fd, "w", encoding="utf-8", newline="")
        self.writer = csv.writer(self.file, lineterminator="\n", quoting=csv.QUOTE_ALL)
        try:
            os.fchmod(self.file.fileno(), 0o600)
            self.writer.writerow(["rownd_user_id", "status", "error_code", "error_message"])
            self.file.flush()
        except OSError:
            self.file.close()
            raise CliError("Cannot write --failed-file") from None

    def append(self, user_id, result):
        codes = list(
            dict.fromkeys(
                safe_code(item.get("code"))
                for field in ("blockers", "requiresExecutionProof")
                for item in result.get(field, [])
            )
        )
        message = result.get("message") or (
            "Reconciliation requires execution-time proof; dry run cannot confirm success"
            if result.get("requiresExecutionProof")
            else "Reconciliation preview could not confirm success"
        )
        try:
            self.writer.writerow(
                [
                    user_id,
                    safe_code(result.get("status")),
                    "; ".join(codes) or safe_code(result.get("status")),
                    message,
                ]
            )
            # Detect disk failures before dispatching another user.
            self.file.flush()
        except OSError:
            raise CliError(
                "Cannot write --failed-file; batch stopped scheduling new users"
            ) from None

    def close(self):
        self.file.close()


async def reconcile_csv(
    ids, duplicates, profile, dry_run, concurrency, reconcile, output, progress, failures=None
):
    next_index = completed = succeeded = active = 0
    stopped = False
    statuses = {}
    started = time.monotonic()

    def report(state):
        elapsed = max(time.monotonic() - started, 0.000001)
        rate = completed / elapsed
        eta = f"{(len(ids) - completed) / rate:.0f}s" if rate and state != "stopped" else "--"
        progress(
            f"[reconcile-csv] {state} | {completed}/{len(ids)} "
            f"({100 * completed / len(ids):.1f}%) | {active} active | "
            f"{succeeded} succeeded, {completed - succeeded} failed | "
            f"{rate:.2f} users/s avg | elapsed {elapsed:.0f}s | ETA {eta}"
        )

    async def ticker():
        while True:
            await asyncio.sleep(1)
            report("running")

    async def worker():
        nonlocal next_index, completed, succeeded, active, stopped
        try:
            while not stopped and next_index < len(ids):
                index = next_index
                next_index += 1
                user_id = ids[index]
                active += 1
                try:
                    result = await reconcile(
                        rownd_user_id=user_id,
                        tenant_id=profile["supertokens"]["tenantId"],
                        dry_run=dry_run,
                    )
                except Exception:
                    result = failure_result(dry_run)
                finally:
                    active -= 1
                completed += 1
                ok = success(result)
                succeeded += int(ok)
                status = safe_code(result.get("status"))
                statuses[status] = statuses.get(status, 0) + 1
                result = format_result(
                    {
                        **result,
                        "rownd_user_id": result.get("rownd_user_id") or user_id,
                        "requested_rownd_user_id": user_id,
                    },
                    profile,
                )
                output({"type": "result", "index": index + 1, "result": result})
                if not ok and failures is not None:
                    failures.append(user_id, result)
        except Exception:
            stopped = True
            raise

    report("running")
    timer = asyncio.create_task(ticker())
    finished = False
    try:
        outcomes = await asyncio.gather(
            *(worker() for _ in range(min(concurrency, len(ids)))), return_exceptions=True
        )
        for outcome in outcomes:
            if isinstance(outcome, BaseException):
                raise outcome
        failed = len(ids) - succeeded
        output(
            {
                "type": "summary",
                "dryRun": dry_run,
                "total": len(ids),
                "duplicatesSkipped": duplicates,
                "succeeded": succeeded,
                "failed": failed,
                "statuses": statuses,
            }
        )
        finished = True
        return int(failed > 0)
    finally:
        timer.cancel()
        await asyncio.gather(timer, return_exceptions=True)
        report("complete" if finished else "stopped")
