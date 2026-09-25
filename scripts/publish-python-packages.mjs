import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isDryRun = process.argv.includes("--dry-run");

if (process.env.PYPI_TOKEN !== undefined && process.env.PYPI_TOKEN !== "") {
  process.env.UV_PUBLISH_TOKEN ??= process.env.PYPI_TOKEN;
}

const pythonPackages = [
  {
    packageDir: "packages/rownd-python",
    pypiName: "supertokens-rownd",
  },
];

for (const pythonPackage of pythonPackages) {
  const packageDir = path.join(rootDir, pythonPackage.packageDir);
  const pyprojectPath = path.join(packageDir, "pyproject.toml");
  const pyproject = fs.readFileSync(pyprojectPath, "utf8");
  const version = getPyprojectVersion(pyproject, pyprojectPath);

  if (await isVersionPublished(pythonPackage.pypiName, version)) {
    console.log(`${pythonPackage.pypiName}@${version} already exists on PyPI; skipping`);
    continue;
  }

  fs.rmSync(path.join(packageDir, "dist"), { force: true, recursive: true });
  run("uv", ["run", "python", "-m", "build"], packageDir);

  const distFiles = fs.readdirSync(path.join(packageDir, "dist")).map((fileName) =>
    path.join("dist", fileName),
  );

  run(
    "uv",
    ["publish", ...(isDryRun ? ["--dry-run", "--trusted-publishing", "never"] : []), ...distFiles],
    packageDir,
  );
}

function getPyprojectVersion(pyproject, pyprojectPath) {
  const versionMatch = pyproject.match(/^version = "([^"]+)"$/m);

  if (versionMatch === null) {
    throw new Error(`Could not find a static project version in ${pyprojectPath}`);
  }

  return versionMatch[1];
}

async function isVersionPublished(packageName, version) {
  const response = await fetch(`https://pypi.org/pypi/${packageName}/${version}/json`);

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    throw new Error(`Could not check PyPI for ${packageName}@${version}: ${response.status}`);
  }

  return true;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}
