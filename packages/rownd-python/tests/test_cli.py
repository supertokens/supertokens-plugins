import asyncio
import copy
import csv
import io
import json
import multiprocessing
import os
from urllib.parse import quote

import pytest

from supertokens_rownd import cli
from supertokens_rownd.cli_csv import FailedFile, parse_csv, reconcile_csv
from supertokens_rownd.cli_output import format_result
from supertokens_rownd.cli_profiles import (
    CliError,
    mask_profile,
    profile_transaction,
    profiles_path,
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


@pytest.mark.parametrize("record", ['""', '"   "', '"\n"', '"\r\n"'])
async def test_quoted_blank_id_rejected_before_initialization(configured, tmp_path, record):
    source, destination = tmp_path / "users.csv", tmp_path / "failures.csv"
    source.write_text("\nrownd_user_id\nvalid\n" + record + "\n")
    with pytest.raises(CliError, match="non-empty Rownd ID"):
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
    assert configured == []
    assert not destination.exists()


def test_physical_blank_lines_remain_ignored():
    assert parse_csv("\r\n \t\nrownd_user_id\n\nvalid\r\n \t\n") == (["valid"], 0)
    with pytest.raises(CliError, match="non-empty Rownd ID"):
        parse_csv('rownd_user_id\nvalid\n""')


async def test_broken_output_persists_all_inflight_failures(profile, tmp_path):
    started, finished = [], []
    both_started = asyncio.Event()
    output_error = BrokenPipeError("stdout closed")
    attempted_output = []

    async def reconcile(**kwargs):
        user_id = kwargs["rownd_user_id"]
        started.append(user_id)
        if len(started) == 2:
            both_started.set()
        await both_started.wait()
        finished.append(user_id)
        return {"status": "BLOCKED"}

    def output(result):
        attempted_output.append(result)
        raise output_error

    def progress(message):
        if "stopped" in message:
            raise OSError("stderr also closed")

    path = tmp_path / "failed.csv"
    failures = FailedFile(path)
    try:
        with pytest.raises(BrokenPipeError) as caught:
            await reconcile_csv(
                ["a", "b", "undispatched"],
                0,
                profile,
                False,
                2,
                reconcile,
                output,
                progress,
                failures,
            )
    finally:
        failures.close()
    assert caught.value is output_error
    assert started == ["a", "b"] and sorted(finished) == ["a", "b"]
    assert len(attempted_output) == 2
    with path.open(newline="") as file:
        rows = list(csv.DictReader(file))
    assert sorted(row["rownd_user_id"] for row in rows) == ["a", "b"]
    assert all(row["status"] == "BLOCKED" for row in rows)


async def test_ticker_failure_stops_dispatch_and_drains_without_sleep(profile, tmp_path):
    started, finished, output = [], [], []
    both_started, release = asyncio.Event(), asyncio.Event()
    first_error = OSError("progress closed")
    reports = 0

    async def wait_for_tick(seconds):
        assert seconds == 1
        await both_started.wait()

    def progress(message):
        nonlocal reports
        reports += 1
        if reports == 2:
            release.set()
            raise first_error
        if reports == 3:
            raise OSError("final progress closed")

    async def reconcile(**kwargs):
        user_id = kwargs["rownd_user_id"]
        started.append(user_id)
        if len(started) == 2:
            both_started.set()
        await release.wait()
        finished.append(user_id)
        return {"status": "BLOCKED"}

    path = tmp_path / "failures.csv"
    failures = FailedFile(path)
    try:
        with pytest.raises(OSError) as caught:
            await reconcile_csv(
                ["a", "b", "undispatched"],
                0,
                profile,
                False,
                2,
                reconcile,
                output.append,
                progress,
                failures,
                wait_for_tick=wait_for_tick,
            )
    finally:
        failures.close()
    assert caught.value is first_error
    assert started == ["a", "b"] and finished == ["a", "b"]
    assert reports == 3
    assert len(output) == 2 and all(row["type"] == "result" for row in output)
    with path.open(newline="") as file:
        assert sorted(row["rownd_user_id"] for row in csv.DictReader(file)) == ["a", "b"]


def _profile_process(args, barrier, results):
    # Force all commands to observe the same initial snapshot before mutation.
    original_read = cli.read_profiles

    def synchronized_read(*args, **kwargs):
        snapshot = original_read(*args, **kwargs)
        barrier.wait(timeout=10)
        return snapshot

    cli.read_profiles = synchronized_read
    try:
        asyncio.run(cli.run(args, output=lambda _: None))
        results.put("OK")
    except CliError as error:
        results.put(str(error))


def _run_profile_processes(commands):
    context = multiprocessing.get_context("spawn")
    barrier, results = context.Barrier(len(commands)), context.Queue()
    processes = [
        context.Process(target=_profile_process, args=(args, barrier, results)) for args in commands
    ]
    try:
        for process in processes:
            process.start()
        outcomes = [results.get(timeout=20) for _ in processes]
        for process in processes:
            process.join(timeout=10)
            assert process.exitcode == 0
        return outcomes
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
                process.join(timeout=10)
        results.close()


def _add_profile_args(name):
    return [
        "profiles",
        "add",
        name,
        "--app-id",
        "app",
        "--app-key",
        "key",
        "--app-secret",
        "secret",
        "--connection-uri",
        "https://core.example",
    ]


@pytest.mark.skipif(os.name != "posix", reason="profile updates require Unix file locking")
def test_process_profile_adds_and_removes_preserve_updates(monkeypatch, tmp_path, profile):
    monkeypatch.setenv("HOME", str(tmp_path))
    write_profiles({"remove_a": profile, "remove_b": profile, "keep": profile})
    commands = [
        _add_profile_args("add_a"),
        _add_profile_args("add_b"),
        ["profiles", "remove", "remove_a"],
        ["profiles", "remove", "remove_b"],
    ]
    assert _run_profile_processes(commands) == ["OK"] * 4
    assert set(read_profiles()) == {"keep", "add_a", "add_b"}
    lock = profiles_path().with_name("profiles.lock")
    assert lock.stat().st_mode & 0o777 == 0o600
    inode = lock.stat().st_ino
    with profile_transaction() as profiles:
        del profiles["add_a"]
    assert lock.stat().st_ino == inode
    assert profiles_path().stat().st_mode & 0o777 == 0o600


@pytest.mark.skipif(os.name != "posix", reason="profile updates require Unix file locking")
def test_process_profile_duplicate_add_revalidated_under_lock(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert sorted(_run_profile_processes([_add_profile_args("same")] * 2)) == [
        "OK",
        "Profile already exists",
    ]
    assert set(read_profiles()) == {"same"}


async def test_interactive_prompt_does_not_hold_lock_or_overwrite_updates(configured, profile):
    import fcntl

    def prompt(label, **kwargs):
        lock = profiles_path().with_name("profiles.lock")
        fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(fd)
        with profile_transaction() as profiles:
            profiles["during_prompt"] = profile
        return {"SuperTokens connection URI": "https://core.example"}.get(label, "value")

    assert (
        await cli.run(
            ["profiles", "add", "interactive"], output=lambda _: None, prompt_value=prompt
        )
        == 0
    )
    assert set(read_profiles()) == {"test", "during_prompt", "interactive"}


async def test_first_output_error_survives_retry_file_append_and_close_errors(
    configured, tmp_path, monkeypatch
):
    source = tmp_path / "users.csv"
    source.write_text("rownd_user_id\na\nb\n")
    attempted = []
    first_error = BrokenPipeError("stdout closed")

    class BrokenFile:
        def __init__(self, path):
            pass

        def append(self, user_id, result):
            attempted.append(user_id)
            raise OSError("append failed")

        def close(self):
            attempted.append("close")
            raise OSError("close failed")

    async def reconcile(**kwargs):
        return {"status": "BLOCKED"}

    def output(result):
        raise first_error

    monkeypatch.setattr(cli, "FailedFile", BrokenFile)
    monkeypatch.setattr(cli, "reconcile_user", reconcile)
    with pytest.raises(BrokenPipeError) as caught:
        await cli.run(
            [
                "reconcile-csv",
                "--profile",
                "test",
                "--file",
                str(source),
                "--failed-file",
                str(tmp_path / "failures.csv"),
            ],
            output=output,
            progress=lambda _: None,
        )
    assert caught.value is first_error
    assert attempted == ["a", "close"]


@pytest.mark.parametrize("cancellation", ["raise", "cancel_task"])
async def test_child_cancellation_drains_sibling_before_closing_retry_file(
    profile, tmp_path, cancellation
):
    tasks, dispatched, output = {}, [], []
    both_started, cancel_child, release_sibling = asyncio.Event(), asyncio.Event(), asyncio.Event()
    timer_finished = asyncio.Event()
    failures = FailedFile(tmp_path / "failures.csv")

    async def wait_for_tick(seconds):
        try:
            await asyncio.Event().wait()
        finally:
            timer_finished.set()

    async def reconcile(**kwargs):
        user_id = kwargs["rownd_user_id"]
        dispatched.append(user_id)
        tasks[user_id] = asyncio.current_task()
        if len(tasks) == 2:
            both_started.set()
        if user_id == "a":
            await cancel_child.wait()
            raise asyncio.CancelledError("child cancelled")
        await release_sibling.wait()
        return {"status": "BLOCKED"}

    async def run_batch():
        try:
            return await reconcile_csv(
                ["a", "b", "c"],
                0,
                profile,
                False,
                2,
                reconcile,
                output.append,
                lambda _: None,
                failures,
                wait_for_tick=wait_for_tick,
            )
        finally:
            failures.close()

    batch = asyncio.create_task(run_batch())
    try:
        await asyncio.wait_for(both_started.wait(), 5)
        if cancellation == "raise":
            cancel_child.set()
        else:
            tasks["a"].cancel()
        await asyncio.gather(tasks["a"], return_exceptions=True)
        assert not batch.done()
        assert not failures.file.closed
        assert not tasks["b"].done()
        release_sibling.set()
        with pytest.raises(asyncio.CancelledError):
            await batch
        assert failures.file.closed
        assert all(task.done() for task in tasks.values())
        assert timer_finished.is_set()
        assert dispatched == ["a", "b"]
        assert len(output) == 1 and output[0]["result"]["requested_rownd_user_id"] == "b"
        with (tmp_path / "failures.csv").open(newline="") as file:
            assert [row["rownd_user_id"] for row in csv.DictReader(file)] == ["b"]
    finally:
        cancel_child.set()
        release_sibling.set()
        if not batch.done():
            batch.cancel()
        await asyncio.gather(batch, return_exceptions=True)


async def test_parent_cancellation_awaits_worker_cleanup_and_prevents_background_writes(
    profile, tmp_path
):
    tasks, dispatched, cleanup_finished, output = {}, [], [], []
    both_started, release_cleanup = asyncio.Event(), asyncio.Event()
    cleanup_started = {user_id: asyncio.Event() for user_id in ("a", "b")}
    timer_finished = asyncio.Event()
    failures = FailedFile(tmp_path / "failures.csv")

    async def wait_for_tick(seconds):
        try:
            await asyncio.Event().wait()
        finally:
            timer_finished.set()

    async def reconcile(**kwargs):
        user_id = kwargs["rownd_user_id"]
        tasks[user_id] = asyncio.current_task()
        dispatched.append(user_id)
        if len(tasks) == 2:
            both_started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cleanup_started[user_id].set()
            await release_cleanup.wait()
            cleanup_finished.append(user_id)
            if user_id == "a":
                raise
            # A dependency may suppress cancellation and still return a result.
            return {"status": "BLOCKED"}

    async def run_batch():
        try:
            return await reconcile_csv(
                ["a", "b", "c"],
                0,
                profile,
                False,
                2,
                reconcile,
                output.append,
                lambda _: None,
                failures,
                wait_for_tick=wait_for_tick,
            )
        finally:
            failures.close()

    batch = asyncio.create_task(run_batch())
    try:
        await asyncio.wait_for(both_started.wait(), 5)
        batch.cancel("parent cancelled")
        await asyncio.wait_for(
            asyncio.gather(*(event.wait() for event in cleanup_started.values())), 5
        )
        assert not batch.done() and not failures.file.closed
        batch.cancel("repeated parent cancellation")
        checkpoint = asyncio.Event()
        asyncio.get_running_loop().call_soon(checkpoint.set)
        await checkpoint.wait()
        assert not batch.done() and not failures.file.closed
        assert not cleanup_finished
        release_cleanup.set()
        with pytest.raises(asyncio.CancelledError):
            await batch
        assert sorted(cleanup_finished) == ["a", "b"]
        assert all(task.done() for task in tasks.values())
        assert timer_finished.is_set() and failures.file.closed
        assert dispatched == ["a", "b"]
        assert len(output) == 1 and output[0]["result"]["requested_rownd_user_id"] == "b"
        with (tmp_path / "failures.csv").open(newline="") as file:
            assert [row["rownd_user_id"] for row in csv.DictReader(file)] == ["b"]
    finally:
        release_cleanup.set()
        if not batch.done():
            batch.cancel()
        await asyncio.gather(batch, return_exceptions=True)
