import { createRequire } from "module";

const require = createRequire(import.meta.url);

interface PackageJsonLike {
  version?: string;
}

let cachedPackageJson: PackageJsonLike | null = null;

function readPackageJson(): PackageJsonLike {
  if (!cachedPackageJson) {
    cachedPackageJson = require("../../package.json") as PackageJsonLike;
  }
  return cachedPackageJson;
}

export function getPackageVersion(): string {
  return readPackageJson().version ?? "unknown";
}
