import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const pythonPackages = [
  {
    packageJsonPath: "packages/rownd-python/package.json",
    pyprojectPath: "packages/rownd-python/pyproject.toml",
    constantsPath: "packages/rownd-python/src/supertokens_rownd/constants.py",
  },
];

let hasMismatch = false;

for (const pythonPackage of pythonPackages) {
  const packageJsonPath = path.join(rootDir, pythonPackage.packageJsonPath);
  const pyprojectPath = path.join(rootDir, pythonPackage.pyprojectPath);
  const constantsPath = path.join(rootDir, pythonPackage.constantsPath);

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const pyproject = fs.readFileSync(pyprojectPath, "utf8");
  const constants = fs.readFileSync(constantsPath, "utf8");
  const pyprojectVersionMatch = pyproject.match(/^version = "([^"]+)"$/m);
  const constantsVersionMatch = constants.match(/^    PLUGIN_VERSION = "([^"]+)"$/m);

  if (pyprojectVersionMatch === null) {
    console.error(`Could not find a static project version in ${pythonPackage.pyprojectPath}`);
    hasMismatch = true;
    continue;
  }
  if (constantsVersionMatch === null) {
    console.error(`Could not find a fallback plugin version in ${pythonPackage.constantsPath}`);
    hasMismatch = true;
    continue;
  }

  const pyprojectVersion = pyprojectVersionMatch[1];
  const constantsVersion = constantsVersionMatch[1];

  if (packageJson.version !== pyprojectVersion) {
    console.error(
      `${pythonPackage.packageJsonPath} (${packageJson.version}) does not match ${pythonPackage.pyprojectPath} (${pyprojectVersion})`,
    );
    hasMismatch = true;
  }
  if (packageJson.version !== constantsVersion) {
    console.error(
      `${pythonPackage.packageJsonPath} (${packageJson.version}) does not match ${pythonPackage.constantsPath} fallback (${constantsVersion})`,
    );
    hasMismatch = true;
  }
}

if (hasMismatch) {
  process.exit(1);
}

console.log("Python package versions are in sync");
