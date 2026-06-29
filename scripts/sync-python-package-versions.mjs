import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const pythonPackages = [
  {
    packageJsonPath: "packages/rownd-python/package.json",
    pyprojectPath: "packages/rownd-python/pyproject.toml",
  },
];

for (const pythonPackage of pythonPackages) {
  const packageJsonPath = path.join(rootDir, pythonPackage.packageJsonPath);
  const pyprojectPath = path.join(rootDir, pythonPackage.pyprojectPath);

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const pyproject = fs.readFileSync(pyprojectPath, "utf8");

  const updatedPyproject = pyproject.replace(
    /(^version = ")([^"]+)("$)/m,
    `$1${packageJson.version}$3`,
  );

  if (updatedPyproject === pyproject) {
    console.log(`${pythonPackage.pyprojectPath} already at ${packageJson.version}`);
    continue;
  }

  fs.writeFileSync(pyprojectPath, updatedPyproject);
  console.log(`${pythonPackage.pyprojectPath} -> ${packageJson.version}`);
}
