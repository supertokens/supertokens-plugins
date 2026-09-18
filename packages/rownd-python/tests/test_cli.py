import asyncio
import copy
import csv
import io
import json
import os
from urllib.parse import quote

import pytest

from supertokens_rownd import cli
from supertokens_rownd.cli_csv import FailedFile, parse_csv, reconcile_csv
from supertokens_rownd.cli_output import format_result
from supertokens_rownd.cli_profiles import (
    CliError,
    mask_profile,
    read_profiles,
    validate_profile,
    write_profiles,
)


@pytest.fixture
def profile():
    return {
        "rownd": {"appId": "app", "appKey": "key+/", "appSecret": "secret-value"},
        "supertokens": {
            "connectionURI": "https://core.example/path?token=hidden#fragment",
            "apiKey": "core-secret",
            "tenantId": "public",
        },
    }


@pytest.fixture
def configured(monkeypatch, tmp_path, profile):
    monkeypatch.setenv("HOME", str(tmp_path))
    write_profiles({"test": profile})
    calls = []
    monkeypatch.setattr(cli, "initialize_sdk", lambda p: calls.append(p))
    return calls


def test_csv_quoted_fields_bom_crlf_duplicates_and_custom_column():
    ids, duplicates = parse_csv(
        '\ufeff\r\nname,id\r\n"a,b",abc\r\n"a""b",def\r\n"multiline\nvalue",abc\r\n', "id"
    )
    assert ids == ["abc", "def"]
    assert duplicates == 1


@pytest.mark.parametrize(
    "text",
    [
        "",
        "rownd_user_id\n",
        "wrong\nabc",
        "rownd_user_id,rownd_user_id\na,b",
        'rownd_user_id\n"abc',
        'rownd_user_id\na"bc',
        'rownd_user_id\n"abc"x',
        "rownd_user_id,extra\nabc",
        "rownd_user_id,extra\n,abc",
        "rownd_user_id\na b",
        "rownd_user_id\na\x00b",
        'rownd_user_id\n"a\nb"',
    ],
)
def test_csv_rejects_malformed_records(text):
    with pytest.raises(CliError):
        parse_csv(text)


def test_profile_atomic_private_storage(tmp_path, profile, monkeypatch):
    path = tmp_path / "profiles" / "profiles.json"
    write_profiles({"test": profile}, path)
    assert path.stat().st_mode & 0o777 == 0o600
    assert path.parent.stat().st_mode & 0o777 == 0o700
    assert read_profiles(path) == {"test": profile}
    original = path.read_bytes()

    def fail_replace(*args):
        raise OSError("secret transport error")

    monkeypatch.setattr(os, "replace", fail_replace)
    with pytest.raises(CliError, match="Unable to write"):
        write_profiles({}, path)
    assert path.read_bytes() == original
    assert list(path.parent.iterdir()) == [path]


def test_read_only_profiles_preserve_permissions(tmp_path, profile):
    path = tmp_path / "profiles" / "profiles.json"
    write_profiles({"test": profile}, path)
    path.chmod(0o640)
    path.parent.chmod(0o750)
    assert read_profiles(path, read_only=True)
    assert path.stat().st_mode & 0o777 == 0o640
    assert path.parent.stat().st_mode & 0o777 == 0o750
    read_profiles(path)
    assert path.stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize(
    "uri",
    [
        "ftp://core",
        "http://user:pass@core",
        "https://core:bad",
        "http://",
        "http://core\nsecret",
        "http://core:99999",
        "https://@core",
    ],
)
def test_profile_url_validation(profile, uri):
    profile["supertokens"]["connectionURI"] = uri
    with pytest.raises(CliError):
        validate_profile(profile)


async def test_interactive_profiles_mask_credentials(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    prompts, output = [], []
    values = {
        "Rownd app ID": "app",
        "Rownd app key": "key",
        "Rownd app secret": "secret",
        "SuperTokens connection URI": "https://core?credential=hidden",
        "SuperTokens API key (optional)": "api",
        "Tenant ID": "public",
    }

    def prompt(label, **options):
        prompts.append((label, options["secret"]))
        return values[label]

    assert (
        await cli.run(["profiles", "add", "test"], output=output.append, prompt_value=prompt) == 0
    )
    assert all(secret for label, secret in prompts if label not in ("Rownd app ID", "Tenant ID"))
    assert output[0]["rownd"]["appSecret"] == "***"
    assert output[0]["supertokens"]["connectionURI"] == "https://core"
    assert output[0]["supertokens"]["apiKey"] == "***"
    assert await cli.run(["profiles", "show", "--profile", "test"], output=output.append) == 0
    assert output[1] == output[0]
    assert await cli.run(["profiles", "list"], output=output.append) == 0
    assert output[-1] == ["test"]
    assert await cli.run(["profiles", "remove", "test"], output=output.append) == 0
    assert read_profiles() == {}


def test_diagnostics_and_nested_secrets_redacted(profile):
    original = copy.deepcopy(profile)
    result = format_result(
        {
            "status": "ERROR",
            "message": "request bearer anything-sensitive",
            "observationError": "opaque transport payload",
            "actions": [quote(profile["rownd"]["appKey"], safe="")],
            "blockers": [{"code": "invalid secret", "message": "payload"}],
            "nested": {"value": profile["rownd"]["appSecret"]},
        },
        profile,
    )
    serialized = json.dumps(result)
    assert "anything-sensitive" not in serialized
    assert "opaque transport" not in serialized
    assert "secret-value" not in serialized
    assert result["actions"] == ["***"]
    assert result["blockers"] == [{"code": "ERROR"}]
    assert profile == original
    assert "hidden" not in json.dumps(mask_profile(profile))


@pytest.mark.parametrize(
    "args",
    [
        ["reconcile-user", "--profile", "test"],
        ["reconcile-user", "--profile", "test", "--email", "a@b", "--rownd-user-id", "id"],
        ["reconcile-user", "--profile", "test", "--email", " "],
        ["reconcile-user", "--profile", "test", "--rownd-user-id", "a\nb"],
        ["reconcile-user", "--profile", "test", "--email", "a@b", "--concurrency", "2"],
        ["reconcile-csv", "--profile", "test", "--file", "missing", "--concurrency", "1.5"],
        ["reconcile-csv", "--profile", "test", "--file", "missing", "--concurrency", "0"],
        ["reconcile-csv", "--profile", "test", "--file", "missing", "--email", "a@b"],
    ],
)
async def test_bad_arguments_never_initialize(configured, args):
    with pytest.raises(CliError):
        await cli.run(args)
    assert configured == []


async def test_entire_csv_validated_before_sdk_or_failure_file(configured, tmp_path):
    source, failures = tmp_path / "users.csv", tmp_path / "failed.csv"
    source.write_text('rownd_user_id\ngood\ninvalid"quote\n')
    with pytest.raises(CliError):
        await cli.run(
            [
                "reconcile-csv",
                "--profile",
                "test",
                "--file",
                str(source),
                "--failed-file",
                str(failures),
            ]
        )
    assert configured == []
    assert not failures.exists()


@pytest.mark.parametrize("selector", ["rownd-user-id", "supertokens-user-id", "email"])
async def test_selector_and_preview_boundary(configured, monkeypatch, selector):
    calls, output = [], []

    async def reconcile(**kwargs):
        calls.append(kwargs)
        kwargs["on_progress"]({"stage": "observe"})
        return {"status": "PREVIEW", "canReconcile": True, "proposedActions": ["IMPORT"]}

    monkeypatch.setattr(cli, "reconcile_user", reconcile)
    assert (
        await cli.run(
            ["reconcile-user", "--profile", "test", "--" + selector, "id", "--dry-run"],
            output=output.append,
            progress=lambda _: None,
        )
        == 0
    )
    assert calls[0][selector.replace("-", "_")] == "id"
    assert calls[0]["tenant_id"] == "public"
    assert calls[0]["dry_run"] is True
    assert len(configured) == 1
    assert output[0]["canReconcile"] is True


async def test_concurrency_completion_order_exceptions_and_failure_csv(profile, tmp_path):
    active = maximum = 0
    called, output, progress = [], [], []

    async def reconcile(**kwargs):
        nonlocal active, maximum
        user_id = kwargs["rownd_user_id"]
        called.append(user_id)
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(0.02 if user_id == "a" else 0.001)
        active -= 1
        if user_id == "b":
            raise RuntimeError("request containing credentials")
        return {"status": "OK"}

    path = tmp_path / "failed.csv"
    failures = FailedFile(path)
    try:
        status = await reconcile_csv(
            ["a", "b", "c"],
            2,
            profile,
            False,
            2,
            reconcile,
            output.append,
            progress.append,
            failures,
        )
    finally:
        failures.close()
    assert status == 1
    assert maximum == 2
    assert sorted(called) == ["a", "b", "c"]
    assert [row["index"] for row in output[:-1]] == [2, 3, 1]
    assert output[-1] == {
        "type": "summary",
        "dryRun": False,
        "total": 3,
        "duplicatesSkipped": 2,
        "succeeded": 2,
        "failed": 1,
        "statuses": {"ERROR": 1, "OK": 2},
    }
    rows = list(csv.DictReader(io.StringIO(path.read_text())))
    assert rows[0]["rownd_user_id"] == "b"
    assert rows[0]["error_code"] == "ERROR"
    assert "credentials" not in path.read_text()
    assert path.stat().st_mode & 0o777 == 0o600
    assert "complete" in progress[-1] and "users/s avg" in progress[-1]
    with pytest.raises(CliError):
        FailedFile(path)


async def test_failure_file_error_stops_dispatch_and_drains_inflight(profile):
    calls, finished, progress = [], [], []

    async def reconcile(**kwargs):
        user_id = kwargs["rownd_user_id"]
        calls.append(user_id)
        await asyncio.sleep(0.001 if user_id == "a" else 0.02)
        finished.append(user_id)
        return {"status": "BLOCKED"}

    class BrokenFile:
        def append(self, *args):
            raise CliError("Cannot write --failed-file")

    with pytest.raises(CliError, match="Cannot write"):
        await reconcile_csv(
            ["a", "b", "c", "d"],
            0,
            profile,
            False,
            2,
            reconcile,
            lambda _: None,
            progress.append,
            BrokenFile(),
        )
    assert calls == ["a", "b"]
    assert finished == ["a", "b"]
    assert "stopped" in progress[-1]


async def test_output_error_stops_dispatch(profile):
    calls = []

    async def reconcile(**kwargs):
        calls.append(kwargs)
        return {"status": "OK"}

    def broken_output(value):
        raise BrokenPipeError()

    with pytest.raises(BrokenPipeError):
        await reconcile_csv(
            ["a", "b"], 0, profile, False, 1, reconcile, broken_output, lambda _: None
        )
    assert len(calls) == 1


def test_main_argument_errors_do_not_echo_secrets(capsys):
    assert cli.main(["profiles", "add", "test", "--unknown-secret=credential"]) == 1
    assert "credential" not in capsys.readouterr().err


def test_failure_csv_escapes_ids_and_sanitizes_diagnostics(tmp_path, profile):
    path = tmp_path / "failures.csv"
    file = FailedFile(path)
    file.append('a,"b', format_result({"status": "BLOCKED", "message": "secret-value"}, profile))
    file.close()
    rows = list(csv.reader(io.StringIO(path.read_text())))
    assert rows[1][0] == 'a,"b'
    assert "secret-value" not in path.read_text()


def test_actual_failure_file_write_error(tmp_path, monkeypatch):
    file = FailedFile(tmp_path / "failures.csv")

    class FullDisk:
        def writerow(self, row):
            raise OSError("disk full")

    monkeypatch.setattr(file, "writer", FullDisk())
    try:
        with pytest.raises(CliError, match="stopped scheduling"):
            file.append("id", {"status": "ERROR"})
    finally:
        file.close()


async def test_csv_dry_run_records_blockers_and_original_ids(configured, tmp_path, monkeypatch):
    source = tmp_path / "users.csv"
    source.write_text("rownd_user_id\nold\nready\nold\n")
    destination = tmp_path / "failed.csv"
    output, calls = [], []

    async def reconcile(**kwargs):
        calls.append(kwargs)
        return {
            "status": "PREVIEW",
            "canReconcile": kwargs["rownd_user_id"] == "ready",
            "rownd_user_id": "canonical",
            "blockers": [{"code": "CANONICAL_EMAIL_POLICY"}],
            "requiresExecutionProof": [{"code": "MAPPING_PROOF_REQUIRED"}],
        }

    monkeypatch.setattr(cli, "reconcile_user", reconcile)
    assert (
        await cli.run(
            [
                "reconcile-csv",
                "--profile",
                "test",
                "--file",
                str(source),
                "--failed-file",
                str(destination),
                "--dry-run",
            ],
            output=output.append,
            progress=lambda _: None,
        )
        == 1
    )
    assert len(calls) == 2 and all(call["dry_run"] for call in calls)
    assert output[-1]["duplicatesSkipped"] == 1
    assert output[-1]["succeeded"] == 1 and output[-1]["failed"] == 1
    assert output[0]["result"]["rownd_user_id"] == "canonical"
    assert output[0]["result"]["requested_rownd_user_id"] == "old"
    with destination.open(newline="") as file:
        rows = list(csv.DictReader(file))
    assert len(rows) == 1 and rows[0]["rownd_user_id"] == "old"
    assert rows[0]["error_code"] == "CANONICAL_EMAIL_POLICY; MAPPING_PROOF_REQUIRED"
    assert "execution-time proof" in rows[0]["error_message"]


async def test_existing_failure_file_prevents_initialization(configured, tmp_path):
    source = tmp_path / "users.csv"
    source.write_text("rownd_user_id\nuser\n")
    destination = tmp_path / "failed.csv"
    destination.write_text("existing content")
    with pytest.raises(CliError, match="new file"):
        await cli.run(
            [
                "reconcile-csv",
                "--profile",
                "test",
                "--file",
                str(source),
                "--failed-file",
                str(destination),
            ]
        )
    assert destination.read_text() == "existing content"
    assert configured == []


def test_secret_prompt_refuses_echo_fallback(monkeypatch):
    import getpass
    import warnings

    def fallback(label):
        warnings.warn("Cannot control echo", getpass.GetPassWarning)
        pytest.fail("must not reach echoing input")

    monkeypatch.setattr(getpass, "getpass", fallback)
    with pytest.raises(CliError, match="requires a terminal"):
        cli.prompt("Secret", secret=True)
