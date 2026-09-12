import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT_DOCUMENTS = new Set([
  "AGENTS.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "README.md",
  "SECURITY.md",
]);

export function isDocumentationPath(path) {
  return ROOT_DOCUMENTS.has(path) || path.startsWith("docs/");
}

export function classifyCIPaths(paths) {
  const changedPaths = paths.filter(Boolean);
  return {
    changedCount: changedPaths.length,
    docsOnly: changedPaths.length > 0 && changedPaths.every(isDocumentationPath),
  };
}

function main() {
  const paths = readFileSync(0)
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const result = classifyCIPaths(paths);

  // This output is appended directly to GITHUB_OUTPUT.  Never echo a changed
  // filename here because pull requests control those bytes.
  process.stdout.write(`docs_only=${result.docsOnly}\nchanged_count=${result.changedCount}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
