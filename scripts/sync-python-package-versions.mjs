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

for (const pythonPackage of pythonPackages) {
  const packageJsonPath = path.join(rootDir, pythonPackage.packageJsonPath);
  const pyprojectPath = path.join(rootDir, pythonPackage.pyprojectPath);
  const constantsPath = path.join(rootDir, pythonPackage.constantsPath);

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const pyproject = fs.readFileSync(pyprojectPath, "utf8");
  const constants = fs.readFileSync(constantsPath, "utf8");

  const updatedPyproject = pyproject.replace(
    /(^version = ")([^"]+)("$)/m,
    `$1${packageJson.version}$3`,
  );
  const updatedConstants = constants.replace(
    /(^    PLUGIN_VERSION = ")([^"]+)("$)/m,
    `$1${packageJson.version}$3`,
  );

  if (updatedPyproject !== pyproject) {
    fs.writeFileSync(pyprojectPath, updatedPyproject);
    console.log(`${pythonPackage.pyprojectPath} -> ${packageJson.version}`);
  }

  if (updatedConstants !== constants) {
    fs.writeFileSync(constantsPath, updatedConstants);
    console.log(`${pythonPackage.constantsPath} -> ${packageJson.version}`);
  }

  if (updatedPyproject === pyproject && updatedConstants === constants) {
    console.log(`${pythonPackage.pyprojectPath} and ${pythonPackage.constantsPath} already at ${packageJson.version}`);
  }
}
