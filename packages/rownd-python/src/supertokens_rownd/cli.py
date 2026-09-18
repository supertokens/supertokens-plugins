"""Administrative CLI; SDK dependencies are loaded only after validating inputs."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import importlib
import json
import re
import sys
import warnings

from .cli_csv import FailedFile, read_csv, reconcile_csv
from .cli_output import failure_result, format_result, success
from .cli_profiles import (
    CliError,
    mask_profile,
    read_profiles,
    validate_name,
    validate_profile,
    write_profiles,
)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse normally includes invalid option values, potentially including secrets.
        raise CliError("Invalid command arguments; run with --help")


def parser():
    root = Parser(prog="rownd-python")
    commands = root.add_subparsers(dest="command", required=True)
    profiles = commands.add_parser("profiles", aliases=["profile"])
    operations = profiles.add_subparsers(dest="operation", required=True)
    operations.add_parser("list")
    for operation in ("add", "show", "remove"):
        p = operations.add_parser(operation)
        p.add_argument("name", nargs="?")
        p.add_argument("--profile")
        if operation == "add":
            for flag in (
                "app-id",
                "app-key",
                "app-secret",
                "connection-uri",
                "api-key",
                "tenant-id",
            ):
                p.add_argument("--" + flag)
    for command in ("reconcile-user", "reconcile-csv"):
        p = commands.add_parser(command)
        p.add_argument("--profile", required=True)
        p.add_argument("--dry-run", action="store_true")
        if command == "reconcile-user":
            selectors = p.add_mutually_exclusive_group(required=True)
            for flag in ("rownd-user-id", "supertokens-user-id", "email"):
                selectors.add_argument("--" + flag)
        else:
            p.add_argument("--file", required=True)
            p.add_argument("--id-column", default="rownd_user_id")
            p.add_argument("--concurrency", default="1")
            p.add_argument("--failed-file")
    return root


def prompt(label, *, secret=False, default=None):
    try:
        if secret:
            # Refuse getpass's echoing fallback when no usable terminal exists.
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                value = getpass.getpass(label + ": ")
        else:
            value = input(label + (f" [{default}]" if default else "") + ": ")
    except (EOFError, getpass.GetPassWarning):
        raise CliError(
            "Interactive entry requires a terminal; supply profile options instead"
        ) from None
    return value or default or ""


def initialize_sdk(profile):
    from supertokens_python import (
        InputAppInfo,
        SupertokensConfig,
        SupertokensExperimentalConfig,
        init,
    )
    from supertokens_python.recipe import (
        accountlinking,
        emailverification,
        passwordless,
        session,
        thirdparty,
        usermetadata,
    )
    from supertokens_rownd import init as rownd_init
    from supertokens_rownd.types import RowndPluginConfig

    init(
        app_info=InputAppInfo(
            app_name="Rownd reconciliation",
            api_domain="http://localhost",
            website_domain="http://localhost",
        ),
        framework="fastapi",
        mode="asgi",
        supertokens_config=SupertokensConfig(
            connection_uri=profile["supertokens"]["connectionURI"],
            api_key=profile["supertokens"].get("apiKey"),
        ),
        recipe_list=[
            accountlinking.init(),
            session.init(),
            usermetadata.init(),
            emailverification.init(mode="OPTIONAL"),
            passwordless.init(
                contact_config=passwordless.ContactEmailOrPhoneConfig(), flow_type="MAGIC_LINK"
            ),
            thirdparty.init(),
        ],
        experimental=SupertokensExperimentalConfig(
            plugins=[
                rownd_init(
                    RowndPluginConfig(
                        rownd_app_key=profile["rownd"]["appKey"],
                        rownd_app_secret=profile["rownd"]["appSecret"],
                        rownd_app_id=profile["rownd"]["appId"],
                    )
                )
            ]
        ),
    )


async def reconcile_user(**kwargs):
    return await importlib.import_module("supertokens_rownd").reconcile_user(**kwargs)


def json_output(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def stderr_output(value):
    print(value, file=sys.stderr, flush=True)


async def run(args=None, *, output=json_output, progress=stderr_output, prompt_value=prompt):
    options = parser().parse_args(args)
    if options.command in ("profile", "profiles"):
        profiles = read_profiles()
        if options.operation == "list":
            output(sorted(profiles))
            return 0
        if options.profile and options.name and options.profile != options.name:
            raise CliError("Conflicting profile names")
        name = options.profile or options.name
        validate_name(name)
        if options.operation == "add":
            if name in profiles:
                raise CliError("Profile already exists")
            interactive = any(
                getattr(options, key) is None
                for key in ("app_id", "app_key", "app_secret", "connection_uri")
            )

            def value(key, label, *, secret=False, default=None, optional=False):
                provided = getattr(options, key)
                if provided is not None:
                    return provided
                if optional and not interactive:
                    return default
                return prompt_value(label, secret=secret, default=default)

            profile = {
                "rownd": {
                    "appId": value("app_id", "Rownd app ID"),
                    "appKey": value("app_key", "Rownd app key", secret=True),
                    "appSecret": value("app_secret", "Rownd app secret", secret=True),
                },
                "supertokens": {
                    "connectionURI": value(
                        "connection_uri", "SuperTokens connection URI", secret=True
                    ),
                    "tenantId": value("tenant_id", "Tenant ID", default="public", optional=True),
                },
            }
            api_key = value("api_key", "SuperTokens API key (optional)", secret=True, optional=True)
            if api_key:
                profile["supertokens"]["apiKey"] = api_key
            profiles[name] = validate_profile(profile)
            write_profiles(profiles)
            output(mask_profile(profile))
        else:
            if name not in profiles:
                raise CliError("Profile not found")
            if options.operation == "show":
                output(mask_profile(profiles[name]))
            else:
                del profiles[name]
                write_profiles(profiles)
                output({"removed": name})
        return 0

    validate_name(options.profile)
    batch = options.command == "reconcile-csv"
    if batch:
        if not re.fullmatch(r"[0-9]+", options.concurrency) or int(options.concurrency) < 1:
            raise CliError("--concurrency must be a positive integer")
        for key in ("file", "id_column", "failed_file"):
            if getattr(options, key) is not None and not getattr(options, key).strip():
                raise CliError("--" + key.replace("_", "-") + " must be non-empty")
        ids, duplicates = read_csv(options.file, options.id_column.strip())
    else:
        selectors = {
            key: getattr(options, key)
            for key in ("rownd_user_id", "supertokens_user_id", "email")
            if getattr(options, key) is not None
        }
        selected = next(iter(selectors.values()))
        if not selected.strip() or any(
            c.isspace() or ord(c) < 32 or ord(c) == 127 for c in selected
        ):
            raise CliError(
                "Provide exactly one non-empty selector without whitespace or control characters"
            )
    profiles = read_profiles(read_only=options.dry_run)
    if options.profile not in profiles:
        raise CliError("Profile not found")
    profile = profiles[options.profile]
    failures = (
        FailedFile(options.failed_file) if batch and options.failed_file is not None else None
    )
    try:
        initialize_sdk(profile)
        if batch:
            return await reconcile_csv(
                ids,
                duplicates,
                profile,
                options.dry_run,
                int(options.concurrency),
                reconcile_user,
                output,
                progress,
                failures,
            )

        def on_progress(event):
            # Do not forward arbitrary SDK diagnostics to the terminal.
            from .cli_output import safe_code

            stage = str(event.get("stage", "PROGRESS")).upper()
            action = str(event.get("action", "")).upper()
            progress(
                "[reconcile] " + safe_code(stage) + (" " + safe_code(action) if action else "")
            )

        try:
            result = await reconcile_user(
                **selectors,
                tenant_id=profile["supertokens"]["tenantId"],
                dry_run=options.dry_run,
                on_progress=on_progress,
            )
        except Exception:
            result = failure_result(options.dry_run)
        output(format_result(result, profile))
        return 0 if success(result) else 1
    finally:
        if failures is not None:
            failures.close()


def main(args=None):
    try:
        return asyncio.run(run(args))
    except CliError as error:
        stderr_output(str(error))
        return 1
    except KeyboardInterrupt:
        return 130
    except Exception:
        stderr_output("Administrative command failed; check configuration and service availability")
        return 1
