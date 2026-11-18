import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncPythonPackageVersions } from "./python-package-versions.mjs";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

syncPythonPackageVersions(rootDir);
