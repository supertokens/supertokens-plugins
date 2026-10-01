"""Private on-disk administrative profiles. No SDK initialization occurs here."""

from __future__ import annotations

import copy
import json
import os
import re
import tempfile
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


class CliError(ValueError):
    pass


def profiles_path():
    return Path.home() / ".config" / "rownd-python" / "profiles.json"


def validate_name(name):
    if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*", name):
        raise CliError("A profile name is required (letters, digits, hyphens, underscores)")


def validate_profile(profile):
    try:
        if set(profile) != {"rownd", "supertokens"}:
            raise ValueError()
        rownd, core = profile["rownd"], profile["supertokens"]
        if set(rownd) != {"appId", "appKey", "appSecret"}:
            raise ValueError()
        if (
            not {"connectionURI", "tenantId"}
            <= set(core)
            <= {"connectionURI", "tenantId", "apiKey"}
        ):
            raise ValueError()
        if any(not isinstance(v, str) or not v.strip() for v in [*rownd.values(), *core.values()]):
            raise ValueError()
        uri = core["connectionURI"]
        parsed = urlsplit(uri)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in uri)
        ):
            raise ValueError()
        _ = parsed.port
    except (ValueError, TypeError, KeyError, AttributeError):
        raise CliError(
            "Profile requires app-id, app-key, app-secret and an HTTP(S) connection-uri "
            "without embedded credentials; use api-key for Core authentication"
        ) from None
    return profile


def read_profiles(path=None, *, read_only=False):
    path = Path(path) if path is not None else profiles_path()
    try:
        if not read_only:
            path.parent.chmod(0o700)
            path.chmod(0o600)
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError()
        for name, profile in data.items():
            validate_name(name)
            validate_profile(profile)
        return data
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        raise CliError("Unable to read profiles: invalid configuration or permissions") from None


def write_profiles(profiles, path=None):
    for name, profile in profiles.items():
        validate_name(name)
        validate_profile(profile)
    path = Path(path) if path is not None else profiles_path()
    temporary = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.parent.chmod(0o700)
        fd, temporary = tempfile.mkstemp(prefix="profiles.", suffix=".tmp", dir=path.parent)
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            os.fchmod(file.fileno(), 0o600)
            json.dump(profiles, file, indent=2)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    except OSError:
        raise CliError("Unable to write profiles; check directory permissions") from None
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)


@contextmanager
def profile_transaction(path=None):
    """Serialize read-modify-replace using a stable inode separate from profiles.json."""
    try:
        import fcntl
    except ImportError:
        raise CliError("Profile updates require Unix file locking") from None
    path = Path(path) if path is not None else profiles_path()
    fd = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.parent.chmod(0o700)
        fd = os.open(path.with_name("profiles.lock"), os.O_CREAT | os.O_RDWR, 0o600)
        os.fchmod(fd, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        profiles = read_profiles(path)
        yield profiles
        write_profiles(profiles, path)
    except OSError:
        raise CliError("Unable to update profiles; check directory permissions") from None
    finally:
        if fd is not None:
            os.close(fd)


def mask_profile(profile):
    masked = copy.deepcopy(profile)
    masked["rownd"].update(appKey="***", appSecret="***")
    core = masked["supertokens"]
    uri = urlsplit(core["connectionURI"])
    core["connectionURI"] = urlunsplit((uri.scheme, uri.netloc, uri.path, "", ""))
    if "apiKey" in core:
        core["apiKey"] = "***"
    return masked
