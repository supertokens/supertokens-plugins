import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPythonPackageVersions } from "./python-package-versions.mjs";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

if (!checkPythonPackageVersions(rootDir)) {
  process.exit(1);
}

console.log("Python package versions are in sync");
