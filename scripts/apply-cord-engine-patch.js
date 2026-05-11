#!/usr/bin/env node
/**
 * Postinstall: apply the cord-engine v4.3.0 path-containment security fix.
 *
 * Replaces patch-package as our postinstall mechanism. patch-package is a
 * devDependency, which means it isn't installed during `npm install -g`, so
 * the postinstall step was failing for every end user and the security
 * patch wasn't being applied. This is the patch, self-contained, no deps.
 *
 * The cord-engine v4.3.0 bug: `abs.startsWith(repoRoot)` matches sibling
 * directory prefixes — `/tmp/project2` starts with `/tmp/project` even
 * though the trees are unrelated. The fix uses path.relative to require a
 * real parent-child relationship.
 *
 * Idempotent — safe to run multiple times. If the patch is already applied
 * (or cord-engine isn't installed for any reason), exits 0 silently.
 */

const fs = require('fs');
const path = require('path');

const CORD_JS_OLD = `function isPathAllowed(targetPath, scope, repoRoot) {
  if (!targetPath) return true;
  const abs = path.resolve(targetPath);
  if (!abs.startsWith(repoRoot)) return false;
  if (!scope?.allowPaths || scope.allowPaths.length === 0) return false;
  return scope.allowPaths.some((p) => abs.startsWith(path.resolve(p)));
}`;

const CORD_JS_NEW = `function isPathAllowed(targetPath, scope, repoRoot) {
  if (!targetPath) return true;
  const abs = path.resolve(targetPath);
  // v4.3.0 containment bug — \`abs.startsWith(dir)\` matches sibling
  // prefixes: "/tmp/project2" starts with "/tmp/project" even though
  // the trees are unrelated. Use path.relative to force a true parent
  // relationship on each allowPaths entry.
  const relToRoot = path.relative(repoRoot, abs);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) return false;
  if (!scope?.allowPaths || scope.allowPaths.length === 0) return false;
  return scope.allowPaths.some((p) => {
    const rel = path.relative(path.resolve(p), abs);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}`;

const SANDBOX_OLD = `    // Check against allow-list
    const allowed = this.allowPaths.some(p => abs.startsWith(p));`;

const SANDBOX_NEW = `    // Check against allow-list.
    // v4.3.0 containment bug — \`abs.startsWith(dir)\` matches sibling
    // prefixes: "/tmp/project2" starts with "/tmp/project" even though
    // the trees are unrelated. Use path.relative so a true parent
    // relationship is required. The path.relative containment check
    // below (line 81+) already catches it as a second gate, but relying
    // on a second check as the rescue means one refactor away from
    // silent loss of containment. Harden both gates so they agree.
    const allowed = this.allowPaths.some(p => {
      const rel = path.relative(p, abs);
      return !rel.startsWith("..") && !path.isAbsolute(rel);
    });`;

function applyToFile(file, oldText, newText, label) {
  if (!fs.existsSync(file)) {
    // cord-engine not installed — nothing to patch
    return 'skip:missing';
  }
  const src = fs.readFileSync(file, 'utf-8');
  if (src.includes(newText)) {
    return 'skip:already-applied';
  }
  if (!src.includes(oldText)) {
    // Upstream changed — patch no longer matches. Don't break the install;
    // just warn so a maintainer notices on next release.
    process.stderr.write(`[codebot] WARN: ${label} doesn't match expected pre-patch source. ` +
      `cord-engine may have changed; verify the v4.3.0 path-containment fix is still in place.\n`);
    return 'skip:mismatch';
  }
  fs.writeFileSync(file, src.replace(oldText, newText));
  return 'applied';
}

function resolveCordEngineDir() {
  // node_modules sibling — works for `npm install` and `npm install -g`.
  // `__dirname` here is .../codebot-ai/scripts/
  const candidates = [
    path.resolve(__dirname, '..', 'node_modules', 'cord-engine'),
    path.resolve(__dirname, '..', '..', 'cord-engine'), // top-level when hoisted
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'cord', 'cord.js'))) return c;
  }
  return null;
}

function main() {
  const root = resolveCordEngineDir();
  if (!root) {
    // cord-engine isn't installed in any expected location — nothing to do.
    return;
  }
  const cordJs = path.join(root, 'cord', 'cord.js');
  const sandboxJs = path.join(root, 'cord', 'sandbox.js');

  const r1 = applyToFile(cordJs, CORD_JS_OLD, CORD_JS_NEW, 'cord-engine/cord/cord.js');
  const r2 = applyToFile(sandboxJs, SANDBOX_OLD, SANDBOX_NEW, 'cord-engine/cord/sandbox.js');

  if (r1 === 'applied' || r2 === 'applied') {
    process.stdout.write('[codebot] cord-engine v4.3.0 path-containment patch applied.\n');
  }
}

try {
  main();
} catch (err) {
  // Never fail the install over the patch — log and continue.
  process.stderr.write(`[codebot] WARN: cord-engine patch step failed: ${err && err.message ? err.message : err}\n`);
}
