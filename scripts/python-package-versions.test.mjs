import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkPythonPackageVersions,
  pythonPackages,
  syncPythonPackageVersions,
} from "./python-package-versions.mjs";

const flatPackage = {
  packageDir: ".",
  packageJsonPath: "package.json",
  pyprojectPath: "pyproject.toml",
  constantsPath: "constants.py",
  lockPath: "uv.lock",
  pypiName: "supertokens-rownd",
};
const temporaryDirectories = [];
const testDirectory = path.dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("check accepts matching typed and untyped top-level plugin versions", async (t) => {
  for (const declaration of [
    'PLUGIN_VERSION = "0.1.13"',
    "PLUGIN_VERSION: str = '0.1.13'",
  ]) {
    await t.test(declaration, () => {
      const rootDir = createFlatFixture({ constants: `${declaration}\n` });
      const errors = [];

      assert.equal(check(rootDir, errors), true);
      assert.deepEqual(errors, []);
    });
  }
});

test("check reports pyproject and plugin mismatches together", () => {
  const rootDir = createFlatFixture({
    pyproject: '[project]\nversion = "0.1.12"\n',
    constants: 'PLUGIN_VERSION = "0.1.9"\n',
  });
  const errors = [];

  assert.equal(check(rootDir, errors), false);
  assert.deepEqual(errors, [
    "package.json (0.1.13) does not match pyproject.toml (0.1.12)",
    "package.json (0.1.13) does not match constants.py fallback (0.1.9)",
  ]);
});

test("check scopes version to the only project table", () => {
  const rootDir = createFlatFixture({
    pyproject:
      '[tool.example]\nversion = "9.9.9"\n\n[project]\nversion = "0.1.13"\ndynamic = ["readme"]\n',
  });
  const errors = [];

  assert.equal(check(rootDir, errors), true);
  assert.deepEqual(errors, []);
});

test("check rejects missing, duplicate, dynamic, and multiline project versions", async (t) => {
  const cases = [
    [
      "duplicate project tables",
      '[project]\nversion = "0.1.13"\n\n[project]\nversion = "0.1.13"\n',
      /exactly one \[project\] table; found 2/,
    ],
    [
      "missing",
      '[project]\nname = "example"\n',
      /exactly one direct version; found 0/,
    ],
    [
      "duplicate",
      '[project]\nversion = "0.1.13"\nversion = "0.1.14"\n',
      /exactly one direct version; found 2/,
    ],
    [
      "dynamic",
      '[project]\ndynamic = [\n  "version",\n]\n',
      /dynamic metadata is ambiguous/,
    ],
    [
      "multiline",
      '[project]\nversion = """0.1.13"""\n',
      /single-line quoted string/,
    ],
  ];

  for (const [name, pyproject, expected] of cases) {
    await t.test(name, () => {
      const rootDir = createFlatFixture({ pyproject });
      const errors = [];
      assert.equal(check(rootDir, errors), false);
      assert.match(errors[0], expected);
    });
  }
});

test("check rejects duplicate and multiline plugin assignments", async (t) => {
  const cases = [
    [
      "duplicate",
      'PLUGIN_VERSION = "0.1.13"\nPLUGIN_VERSION: str = "0.1.13"\n',
      /exactly one top-level PLUGIN_VERSION assignment; found 2/,
    ],
    [
      "multiline",
      'PLUGIN_VERSION = (\n    "0.1.13"\n)\n',
      /single-line quoted string/,
    ],
  ];

  for (const [name, constants, expected] of cases) {
    await t.test(name, () => {
      const rootDir = createFlatFixture({ constants });
      const errors = [];
      assert.equal(check(rootDir, errors), false);
      assert.match(errors[0], expected);
    });
  }
});

test("check rejects missing and class-indented plugin assignments", async (t) => {
  const cases = [
    ["missing", 'PLUGIN_ID = "example"\n'],
    [
      "indented class attribute",
      'class Plugin:\n    PLUGIN_VERSION = "0.1.13"\n',
    ],
  ];

  for (const [name, constants] of cases) {
    await t.test(name, () => {
      const rootDir = createFlatFixture({ constants });
      const errors = [];
      assert.equal(check(rootDir, errors), false);
      assert.match(
        errors[0],
        /exactly one top-level PLUGIN_VERSION assignment; found 0/,
      );
    });
  }
});

test("sync rejects missing and class-indented plugin assignments before updating", async (t) => {
  const cases = [
    ["missing", 'PLUGIN_ID = "example"\n'],
    [
      "indented class attribute",
      'class Plugin:\n    PLUGIN_VERSION = "0.1.12"\n',
    ],
  ];

  for (const [name, constants] of cases) {
    await t.test(name, () => {
      const rootDir = createFlatFixture({ constants });
      const before = readFixture(rootDir);
      let lockUpdated = false;

      assert.throws(
        () =>
          syncPythonPackageVersions(
            rootDir,
            [flatPackage],
            { log: () => {} },
            () => {
              lockUpdated = true;
            },
          ),
        /exactly one top-level PLUGIN_VERSION assignment; found 0/,
      );
      assert.equal(lockUpdated, false);
      assert.deepEqual(readFixture(rootDir), before);
    });
  }
});

test("check aggregates malformed project, duplicate plugin, and lock mismatch diagnostics", () => {
  const rootDir = createFlatFixture({
    pyproject: "[project]\n",
    constants: 'PLUGIN_VERSION = "0.1.13"\nPLUGIN_VERSION = "0.1.13"\n',
    lockVersion: "0.1.12",
  });
  const errors = [];

  assert.equal(check(rootDir, errors), false);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /direct version; found 0/);
  assert.match(errors[1], /PLUGIN_VERSION assignment; found 2/);
  assert.match(errors[2], /uv\.lock package entry \(0\.1\.12\)/);
});

test("sync rewrites project, typed plugin, and lock versions while preserving formatting", () => {
  const rootDir = createFlatFixture({
    pyproject:
      "[tool.example]\nversion = \"9.9.9\"\n\n[project]\n\tversion = '0.1.12' # package\n",
    constants: "PLUGIN_VERSION: str = '0.1.9'  # runtime metadata\n",
    lockVersion: "0.1.11",
  });

  sync(rootDir);

  assert.equal(
    fs.readFileSync(path.join(rootDir, "pyproject.toml"), "utf8"),
    "[tool.example]\nversion = \"9.9.9\"\n\n[project]\n\tversion = '0.1.13' # package\n",
  );
  assert.equal(
    fs.readFileSync(path.join(rootDir, "constants.py"), "utf8"),
    "PLUGIN_VERSION: str = '0.1.13'  # runtime metadata\n",
  );
  assert.match(
    fs.readFileSync(path.join(rootDir, "uv.lock"), "utf8"),
    /version = "0\.1\.13"/,
  );
});

test("sync is idempotent when every version already matches", () => {
  const rootDir = createFlatFixture();
  const before = readFixture(rootDir);

  sync(rootDir);
  sync(rootDir);

  assert.deepEqual(readFixture(rootDir), before);
});

test("check rejects a lock mismatch and sync verifies the lock updater result", () => {
  const rootDir = createFlatFixture({ lockVersion: "0.1.12" });
  const errors = [];
  assert.equal(check(rootDir, errors), false);
  assert.match(errors[0], /uv\.lock package entry \(0\.1\.12\)/);

  assert.throws(
    () =>
      syncPythonPackageVersions(
        rootDir,
        [flatPackage],
        { log: () => {} },
        () => {},
      ),
    /remained at 0\.1\.12 after lock update/,
  );
});

test("default definitions support the real nested package layout", () => {
  const rootDir = createNestedFixture();
  const errors = [];

  assert.equal(
    checkPythonPackageVersions(rootDir, pythonPackages, {
      error: (error) => errors.push(error),
    }),
    true,
  );
  syncPythonPackageVersions(
    rootDir,
    pythonPackages,
    { log: () => {} },
    updateFixtureLock,
  );
  assert.deepEqual(errors, []);
});

test("check CLI exits zero for matching versions and nonzero for a mismatch", () => {
  const rootDir = createNestedFixture();
  const scriptsDir = path.join(rootDir, "scripts");
  fs.mkdirSync(scriptsDir);
  for (const script of [
    "check-python-package-versions.mjs",
    "python-package-versions.mjs",
  ]) {
    fs.copyFileSync(
      path.join(testDirectory, script),
      path.join(scriptsDir, script),
    );
  }

  assert.equal(runCheckCli(rootDir).status, 0);
  fs.writeFileSync(
    path.join(rootDir, pythonPackages[0].constantsPath),
    'PLUGIN_VERSION = "0.1.12"\n',
  );
  const mismatch = runCheckCli(rootDir);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /does not match .*constants\.py fallback/);
});

test("check rejects non-SemVer workspace versions", () => {
  const rootDir = createFlatFixture({ packageVersion: "release-1" });
  const errors = [];

  assert.equal(check(rootDir, errors), false);
  assert.match(errors[0], /valid SemVer string for Changesets/);
});

function check(rootDir, errors) {
  return checkPythonPackageVersions(rootDir, [flatPackage], {
    error: (message) => errors.push(message),
  });
}

function sync(rootDir) {
  syncPythonPackageVersions(
    rootDir,
    [flatPackage],
    { log: () => {} },
    updateFixtureLock,
  );
}

function updateFixtureLock(rootDir, pythonPackage, version) {
  const lockPath = path.join(rootDir, pythonPackage.lockPath);
  const lock = fs.readFileSync(lockPath, "utf8");
  fs.writeFileSync(
    lockPath,
    lock.replace(
      /(\[\[package\]\]\nname = "supertokens-rownd"\nversion = ")[^"]+/,
      `$1${version}`,
    ),
  );
}

function createFlatFixture(options = {}) {
  const rootDir = createTemporaryDirectory();
  writeFixture(rootDir, flatPackage, options);
  return rootDir;
}

function createNestedFixture(options = {}) {
  const rootDir = createTemporaryDirectory();
  writeFixture(rootDir, pythonPackages[0], options);
  return rootDir;
}

function writeFixture(
  rootDir,
  pythonPackage,
  {
    packageVersion = "0.1.13",
    pyproject = `[project]\nname = "supertokens-rownd"\nversion = "${packageVersion}"\n`,
    constants = `PLUGIN_VERSION = "${packageVersion}"\n`,
    lockVersion = packageVersion,
  } = {},
) {
  for (const relativePath of [
    pythonPackage.packageJsonPath,
    pythonPackage.pyprojectPath,
    pythonPackage.constantsPath,
    pythonPackage.lockPath,
  ]) {
    fs.mkdirSync(path.dirname(path.join(rootDir, relativePath)), {
      recursive: true,
    });
  }
  fs.writeFileSync(
    path.join(rootDir, pythonPackage.packageJsonPath),
    `${JSON.stringify({ version: packageVersion })}\n`,
  );
  fs.writeFileSync(path.join(rootDir, pythonPackage.pyprojectPath), pyproject);
  fs.writeFileSync(path.join(rootDir, pythonPackage.constantsPath), constants);
  fs.writeFileSync(
    path.join(rootDir, pythonPackage.lockPath),
    `version = 1\n\n[[package]]\nname = "dependency"\nversion = "9.0.0"\n\n[[package]]\nname = "${pythonPackage.pypiName}"\nversion = "${lockVersion}"\nsource = { editable = "." }\n`,
  );
}

function createTemporaryDirectory() {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "python-package-versions-"),
  );
  temporaryDirectories.push(rootDir);
  return rootDir;
}

function readFixture(rootDir) {
  return ["package.json", "pyproject.toml", "constants.py", "uv.lock"].map(
    (file) => fs.readFileSync(path.join(rootDir, file), "utf8"),
  );
}

function runCheckCli(rootDir) {
  return spawnSync(
    process.execPath,
    [path.join(rootDir, "scripts/check-python-package-versions.mjs")],
    {
      cwd: rootDir,
      encoding: "utf8",
    },
  );
}
