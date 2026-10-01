import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const pythonPackages = [
  {
    packageDir: "packages/rownd-python",
    packageJsonPath: "packages/rownd-python/package.json",
    pyprojectPath: "packages/rownd-python/pyproject.toml",
    constantsPath: "packages/rownd-python/src/supertokens_rownd/constants.py",
    lockPath: "packages/rownd-python/uv.lock",
    pypiName: "supertokens-rownd",
  },
];

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const projectHeaderPattern = /^[ \t]*\[project\][ \t]*(?:#.*)?$/;
const tableHeaderPattern = /^[ \t]*\[\[?[^\]\r\n]+\]\]?[ \t]*(?:#.*)?$/;
const pyprojectVersionCandidatePattern = /^[ \t]*version[ \t]*=/;
const pyprojectVersionPattern =
  /^([ \t]*version[ \t]*=[ \t]*)(["'])([^"'\r\n]+)\2([ \t]*(?:#.*)?)$/;
const dynamicCandidatePattern = /^[ \t]*dynamic[ \t]*=/;
const pluginVersionCandidatePattern =
  /^PLUGIN_VERSION(?:[ \t]*:[^=\r\n]+)?[ \t]*=/;
const pluginVersionPattern =
  /^(PLUGIN_VERSION(?:[ \t]*:[^=\r\n]+)?[ \t]*=[ \t]*)(["'])([^"'\r\n]+)\2([ \t]*(?:#.*)?)$/;
const packageHeaderPattern = /^[ \t]*\[\[package\]\][ \t]*(?:#.*)?$/;
const lockNamePattern = /^[ \t]*name[ \t]*=[ \t]*"([^"\r\n]+)"[ \t]*(?:#.*)?$/;
const lockVersionPattern =
  /^[ \t]*version[ \t]*=[ \t]*"([^"\r\n]+)"[ \t]*(?:#.*)?$/;

export function checkPythonPackageVersions(
  rootDir,
  packages = pythonPackages,
  logger = console,
) {
  let hasMismatch = false;

  for (const pythonPackage of packages) {
    let packageVersion;

    try {
      packageVersion = readPackageVersion(rootDir, pythonPackage);
    } catch (error) {
      logger.error(error.message);
      hasMismatch = true;
    }

    const versions = [
      {
        description: pythonPackage.pyprojectPath,
        read: () =>
          getPyprojectVersion(
            readFile(rootDir, pythonPackage.pyprojectPath),
            pythonPackage.pyprojectPath,
          ),
      },
      {
        description: `${pythonPackage.constantsPath} fallback`,
        read: () =>
          getPluginVersion(
            readFile(rootDir, pythonPackage.constantsPath),
            pythonPackage.constantsPath,
          ),
      },
      {
        description: `${pythonPackage.lockPath} package entry`,
        read: () =>
          getUvLockVersion(
            readFile(rootDir, pythonPackage.lockPath),
            pythonPackage.pypiName,
            pythonPackage.lockPath,
          ),
      },
    ];

    for (const versionSource of versions) {
      try {
        const version = versionSource.read();
        if (packageVersion !== undefined && packageVersion !== version) {
          logger.error(
            `${pythonPackage.packageJsonPath} (${packageVersion}) does not match ${versionSource.description} (${version})`,
          );
          hasMismatch = true;
        }
      } catch (error) {
        logger.error(error.message);
        hasMismatch = true;
      }
    }
  }

  return !hasMismatch;
}

export function syncPythonPackageVersions(
  rootDir,
  packages = pythonPackages,
  logger = console,
  updateLock = updateUvLock,
) {
  for (const pythonPackage of packages) {
    const packageVersion = readPackageVersion(rootDir, pythonPackage);
    const pyproject = readFile(rootDir, pythonPackage.pyprojectPath);
    const constants = readFile(rootDir, pythonPackage.constantsPath);
    const updatedPyproject = replacePyprojectVersion(
      pyproject,
      packageVersion,
      pythonPackage.pyprojectPath,
    );
    const updatedConstants = replacePluginVersion(
      constants,
      packageVersion,
      pythonPackage.constantsPath,
    );
    let previousLockVersion;
    try {
      previousLockVersion = getUvLockVersion(
        readFile(rootDir, pythonPackage.lockPath),
        pythonPackage.pypiName,
        pythonPackage.lockPath,
      );
    } catch {
      // uv may be able to repair a stale or incomplete lockfile.
    }

    if (updatedPyproject !== pyproject) {
      fs.writeFileSync(
        path.join(rootDir, pythonPackage.pyprojectPath),
        updatedPyproject,
      );
      logger.log(`${pythonPackage.pyprojectPath} -> ${packageVersion}`);
    }

    if (updatedConstants !== constants) {
      fs.writeFileSync(
        path.join(rootDir, pythonPackage.constantsPath),
        updatedConstants,
      );
      logger.log(`${pythonPackage.constantsPath} -> ${packageVersion}`);
    }

    updateLock(rootDir, pythonPackage, packageVersion);
    const lockVersion = getUvLockVersion(
      readFile(rootDir, pythonPackage.lockPath),
      pythonPackage.pypiName,
      pythonPackage.lockPath,
    );
    if (lockVersion !== packageVersion) {
      throw new Error(
        `${pythonPackage.lockPath} package entry remained at ${lockVersion} after lock update; expected ${packageVersion}`,
      );
    }
    if (previousLockVersion !== lockVersion) {
      logger.log(`${pythonPackage.lockPath} -> ${packageVersion}`);
    }

    if (
      updatedPyproject === pyproject &&
      updatedConstants === constants &&
      previousLockVersion === packageVersion
    ) {
      logger.log(
        `${pythonPackage.pyprojectPath}, ${pythonPackage.constantsPath}, and ${pythonPackage.lockPath} already at ${packageVersion}`,
      );
    }
  }
}

export function getPyprojectVersion(contents, filePath = "pyproject.toml") {
  return parsePyprojectVersion(contents, filePath).version;
}

function replacePyprojectVersion(contents, version, filePath) {
  const parsed = parsePyprojectVersion(contents, filePath);
  return replaceParsedVersion(contents, parsed, version);
}

function parsePyprojectVersion(contents, filePath) {
  const lines = getLines(contents);
  const projectHeaders = lines.filter((line) =>
    projectHeaderPattern.test(line.text),
  );

  if (projectHeaders.length !== 1) {
    throw new Error(
      `${filePath} must contain exactly one [project] table; found ${projectHeaders.length}`,
    );
  }

  const projectHeader = projectHeaders[0];
  const projectStart = lines.indexOf(projectHeader) + 1;
  const projectEnd = findNextTable(lines, projectStart);
  const projectLines = lines.slice(projectStart, projectEnd);
  const versionCandidates = projectLines.filter((line) =>
    pyprojectVersionCandidatePattern.test(line.text),
  );

  if (hasDynamicVersion(projectLines)) {
    throw new Error(
      `${filePath} [project] version must be static; dynamic metadata is ambiguous`,
    );
  }
  if (versionCandidates.length !== 1) {
    throw new Error(
      `${filePath} [project] must contain exactly one direct version; found ${versionCandidates.length}`,
    );
  }

  return parseVersionLine(
    versionCandidates[0],
    pyprojectVersionPattern,
    `${filePath} [project] version must be a single-line quoted string`,
  );
}

function getPluginVersion(contents, filePath) {
  return parsePluginVersion(contents, filePath).version;
}

function replacePluginVersion(contents, version, filePath) {
  const parsed = parsePluginVersion(contents, filePath);
  return replaceParsedVersion(contents, parsed, version);
}

function parsePluginVersion(contents, filePath) {
  const candidates = getLines(contents).filter((line) =>
    pluginVersionCandidatePattern.test(line.text),
  );

  if (candidates.length !== 1) {
    throw new Error(
      `${filePath} must contain exactly one top-level PLUGIN_VERSION assignment; found ${candidates.length}`,
    );
  }

  return parseVersionLine(
    candidates[0],
    pluginVersionPattern,
    `${filePath} PLUGIN_VERSION must be a single-line quoted string`,
  );
}

function getUvLockVersion(contents, packageName, filePath) {
  const lines = getLines(contents);
  const packageHeaders = lines.filter((line) =>
    packageHeaderPattern.test(line.text),
  );
  const matchingPackages = [];

  for (const packageHeader of packageHeaders) {
    const start = lines.indexOf(packageHeader) + 1;
    const packageLines = lines.slice(start, findNextTable(lines, start));
    const names = packageLines
      .map((line) => line.text.match(lockNamePattern)?.[1])
      .filter(Boolean);
    if (names.length === 1 && names[0] === packageName) {
      matchingPackages.push(packageLines);
    }
  }

  if (matchingPackages.length !== 1) {
    throw new Error(
      `${filePath} must contain exactly one [[package]] entry named ${packageName}; found ${matchingPackages.length}`,
    );
  }

  const versions = matchingPackages[0]
    .map((line) => line.text.match(lockVersionPattern)?.[1])
    .filter(Boolean);
  if (versions.length !== 1) {
    throw new Error(
      `${filePath} ${packageName} entry must contain exactly one direct version; found ${versions.length}`,
    );
  }

  return versions[0];
}

function readPackageVersion(rootDir, pythonPackage) {
  const packageJson = JSON.parse(
    readFile(rootDir, pythonPackage.packageJsonPath),
  );
  if (
    typeof packageJson.version !== "string" ||
    !semverPattern.test(packageJson.version)
  ) {
    throw new Error(
      `${pythonPackage.packageJsonPath} version must be a valid SemVer string for Changesets`,
    );
  }
  return packageJson.version;
}

function updateUvLock(rootDir, pythonPackage) {
  const result = spawnSync(
    "uv",
    ["lock", "--project", path.join(rootDir, pythonPackage.packageDir)],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  if (result.status !== 0) {
    throw new Error(
      `uv lock --project ${pythonPackage.packageDir} failed with exit code ${result.status}`,
    );
  }
}

function parseVersionLine(line, pattern, errorMessage) {
  const match = line.text.match(pattern);
  if (match === null) {
    throw new Error(errorMessage);
  }
  return {
    version: match[3],
    prefix: match[1],
    quote: match[2],
    suffix: match[4],
    start: line.start,
    end: line.start + line.text.length,
  };
}

function replaceParsedVersion(contents, parsed, version) {
  const replacement = `${parsed.prefix}${parsed.quote}${version}${parsed.quote}${parsed.suffix}`;
  return `${contents.slice(0, parsed.start)}${replacement}${contents.slice(parsed.end)}`;
}

function getLines(contents) {
  const lines = [];
  const pattern = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  let match;

  while ((match = pattern.exec(contents)) !== null && match[0] !== "") {
    const text = match[0].replace(/(?:\r\n|\r|\n)$/, "");
    lines.push({ text, start: match.index });
  }
  return lines;
}

function findNextTable(lines, start) {
  const nextTable = lines.findIndex(
    (line, index) => index >= start && tableHeaderPattern.test(line.text),
  );
  return nextTable === -1 ? lines.length : nextTable;
}

function hasDynamicVersion(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!dynamicCandidatePattern.test(lines[index].text)) {
      continue;
    }

    let assignment = lines[index].text;
    while (!assignment.includes("]") && index + 1 < lines.length) {
      index += 1;
      assignment += `\n${lines[index].text}`;
    }
    if (/["']version["']/.test(assignment)) {
      return true;
    }
  }
  return false;
}

function readFile(rootDir, relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}
