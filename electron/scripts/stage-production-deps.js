#!/usr/bin/env node
/**
 * Stage production-only node_modules for Electron packaging.
 *
 * Problem: The parent codebot-ai project has ~70MB of node_modules including
 * devDependencies (typescript, eslint, prettier, @types). The Electron app
 * only needs production deps at runtime (~5MB).
 *
 * Solution: Create a staging directory with a copy of package.json, run
 * `npm install --omit=dev` there, and point electron-builder at it.
 *
 * This script runs as a prebuild hook.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ELECTRON_DIR = path.resolve(__dirname, '..');
const PARENT_DIR = path.resolve(ELECTRON_DIR, '..');
const STAGING_DIR = path.join(ELECTRON_DIR, 'staging');

console.log('📦 Staging production dependencies for Electron build...');

// Clean previous staging
if (fs.existsSync(STAGING_DIR)) {
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
}
fs.mkdirSync(STAGING_DIR, { recursive: true });

// Copy package.json and package-lock.json (if exists)
const pkgSrc = path.join(PARENT_DIR, 'package.json');
const lockSrc = path.join(PARENT_DIR, 'package-lock.json');

fs.copyFileSync(pkgSrc, path.join(STAGING_DIR, 'package.json'));
if (fs.existsSync(lockSrc)) {
  fs.copyFileSync(lockSrc, path.join(STAGING_DIR, 'package-lock.json'));
}

// Copy scripts/ so postinstall hooks (e.g. apply-cord-engine-patch.js) can run
// in the staging dir. The cord-engine v4.3.0 path-containment security patch
// must apply to the bundled .app, not just to the dev tree.
const scriptsSrc = path.join(PARENT_DIR, 'scripts');
if (fs.existsSync(scriptsSrc)) {
  const scriptsDst = path.join(STAGING_DIR, 'scripts');
  fs.mkdirSync(scriptsDst, { recursive: true });
  for (const f of fs.readdirSync(scriptsSrc)) {
    const src = path.join(scriptsSrc, f);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(scriptsDst, f));
    }
  }
}

// Install production-only deps
console.log('  Installing production dependencies only (--omit=dev)...');
try {
  execSync('npm install --omit=dev --no-audit --no-fund', {
    cwd: STAGING_DIR,
    stdio: 'pipe',
    timeout: 120_000,
  });
} catch (err) {
  // If npm install fails (e.g., optional deps), try with --ignore-scripts
  console.log('  Retrying with --ignore-scripts...');
  execSync('npm install --omit=dev --no-audit --no-fund --ignore-scripts', {
    cwd: STAGING_DIR,
    stdio: 'pipe',
    timeout: 120_000,
  });
}

// Handle native module: better-sqlite3.
//
// IMPORTANT: the bundled CodeBot CLI is launched as a child process by main.js
// using SYSTEM Node (e.g. /opt/homebrew/bin/node), NOT Electron's embedded Node.
// See electron/main.js around line 165: it explicitly switches `nodeBin` away
// from `process.execPath` when running inside the .app bundle. So the
// better-sqlite3 native binding must be compiled for the SYSTEM Node ABI
// (NODE_MODULE_VERSION 127 for Node 22), not Electron's ABI (145 for Electron 41).
// Using @electron/rebuild here would produce a binary that fails to load with:
//   "compiled against NODE_MODULE_VERSION 145 ... requires NODE_MODULE_VERSION 127"
//
// History: the original staging strategy used `--ignore-scripts` as a fallback,
// which stripped deps/ and src/ from the package and left build/ empty. The
// catch swallowed the failure and printed a warning, leaving
// ExperientialMemory.isActive=false silently — lessons.db never written.
//
// Fix: force-install better-sqlite3@12.8.0 (V8-compatible, has prebuilt binaries
// for system Node), drop any nested duplicates, and FAIL LOUD if the .node
// binary doesn't materialize.
const BETTER_SQLITE_VERSION = '12.8.0';
const betterSqlite = path.join(STAGING_DIR, 'node_modules', 'better-sqlite3');
if (fs.existsSync(betterSqlite)) {
  console.log(`  Reinstalling better-sqlite3@${BETTER_SQLITE_VERSION} (system-Node prebuilt)...`);
  fs.rmSync(betterSqlite, { recursive: true, force: true });
  // Plain `npm install` (no --ignore-scripts) so prebuild-install fetches the
  // prebuilt binary that matches the local Node version. The bundled CLI runs
  // with this same system Node, so the ABI matches.
  execSync(`npm install better-sqlite3@${BETTER_SQLITE_VERSION} --no-audit --no-fund --force`, {
    cwd: STAGING_DIR,
    stdio: 'pipe',
    timeout: 180_000,
  });

  // Drop any nested duplicates (e.g. @ai-operations/ops-storage/node_modules/better-sqlite3)
  // that npm may have hoisted with the older version — they would shadow the top-level
  // copy when required from inside that subtree, and they have the same wrong ABI.
  try {
    const nested = execSync(
      `find "${STAGING_DIR}/node_modules" -mindepth 4 -type d -name better-sqlite3 -prune -print`,
      { encoding: 'utf-8' }
    ).trim().split('\n').filter(Boolean);
    for (const dup of nested) {
      console.log(`  Removing nested duplicate: ${dup.replace(STAGING_DIR + '/', '')}`);
      fs.rmSync(dup, { recursive: true, force: true });
    }
  } catch {}

  // Fail loud if the .node binary is not present — a missing binary means
  // ExperientialMemory will be silently disabled in the bundled app.
  const expectedBinding = path.join(betterSqlite, 'build', 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(expectedBinding)) {
    throw new Error(
      `❌ Expected native binding not found after install:\n  ${expectedBinding}\n` +
      `This means ExperientialMemory will be silently disabled in the bundled app. ` +
      `Refusing to ship a broken brain build.`
    );
  }

  // Sanity check: try to actually load it under the same Node that will run
  // the bundled CLI at runtime. Fail loud on ABI mismatch.
  try {
    execSync(
      `node -e "const D = require('${betterSqlite}'); const db = new D('/tmp/.codebot-staging-abi-check.db'); db.close();"`,
      { stdio: 'pipe', timeout: 10_000 }
    );
  } catch (err) {
    throw new Error(
      `❌ better-sqlite3 native binding ABI mismatch — refused to load:\n` +
      `${err.stderr ? err.stderr.toString() : err.message}\n` +
      `Refusing to ship a broken brain build.`
    );
  }
  console.log(`  ✅ better-sqlite3 native binding loads cleanly: ${path.relative(ELECTRON_DIR, expectedBinding)}`);
}

// Remove unnecessary files from staging to slim down further
const REMOVE_PATTERNS = [
  '**/README.md', '**/CHANGELOG.md', '**/LICENSE', '**/LICENSE.md',
  '**/.eslintrc*', '**/.prettierrc*', '**/tsconfig.json',
  '**/*.d.ts.map', '**/*.js.map',
  '**/test/', '**/tests/', '**/__tests__/', '**/spec/',
  '**/docs/', '**/example/', '**/examples/',
  '**/.github/', '**/.travis.yml', '**/.circleci/',
];

function removeGlobs(dir) {
  let removed = 0;
  for (const pattern of ['README.md', 'CHANGELOG.md', 'HISTORY.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', '.eslintrc.json', '.prettierrc', 'tsconfig.json']) {
    try {
      const output = execSync(`find "${dir}" -name "${pattern}" -type f -delete -print 2>/dev/null | wc -l`, {
        encoding: 'utf-8', timeout: 10_000,
      }).trim();
      removed += parseInt(output) || 0;
    } catch {}
  }
  for (const dirName of ['test', 'tests', '__tests__', 'spec', 'docs', 'example', 'examples', '.github']) {
    try {
      const output = execSync(`find "${dir}" -name "${dirName}" -type d -exec rm -rf {} + -print 2>/dev/null | wc -l`, {
        encoding: 'utf-8', timeout: 10_000,
      }).trim();
      removed += parseInt(output) || 0;
    } catch {}
  }
  // Remove .d.ts.map and .js.map files
  try {
    execSync(`find "${dir}" -name "*.d.ts.map" -o -name "*.js.map" | xargs rm -f 2>/dev/null`, {
      timeout: 10_000,
    });
  } catch {}
  return removed;
}

const cleaned = removeGlobs(path.join(STAGING_DIR, 'node_modules'));

// Strip native module build artifacts (C sources, obj files) — not needed at runtime
const bsqlite = path.join(STAGING_DIR, 'node_modules', 'better-sqlite3');
if (fs.existsSync(bsqlite)) {
  // Remove C source deps (only the compiled .node file is needed)
  const depsDir = path.join(bsqlite, 'deps');
  const srcDir = path.join(bsqlite, 'src');
  if (fs.existsSync(depsDir)) fs.rmSync(depsDir, { recursive: true, force: true });
  if (fs.existsSync(srcDir)) fs.rmSync(srcDir, { recursive: true, force: true });
  // Remove build intermediates, keep only the .node binary
  const buildDir = path.join(bsqlite, 'build');
  if (fs.existsSync(buildDir)) {
    try {
      // Find and keep only .node files
      const nodeFiles = execSync(`find "${buildDir}" -name "*.node" 2>/dev/null`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
      if (nodeFiles.length > 0) {
        // Move .node files to a temp location, nuke build, restore
        const tmpDir = path.join(bsqlite, '_build_tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        for (const nf of nodeFiles) {
          fs.copyFileSync(nf, path.join(tmpDir, path.basename(nf)));
        }
        fs.rmSync(buildDir, { recursive: true, force: true });
        fs.mkdirSync(path.join(buildDir, 'Release'), { recursive: true });
        for (const nf of fs.readdirSync(tmpDir)) {
          fs.renameSync(path.join(tmpDir, nf), path.join(buildDir, 'Release', nf));
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch { /* best effort */ }
  }
  // Remove prebuild-install (only needed for installation, not runtime)
  const prebuild = path.join(STAGING_DIR, 'node_modules', 'prebuild-install');
  if (fs.existsSync(prebuild)) fs.rmSync(prebuild, { recursive: true, force: true });
}

// Clean up dangling .bin symlinks (broken after removing packages above)
const binDir = path.join(STAGING_DIR, 'node_modules', '.bin');
if (fs.existsSync(binDir)) {
  for (const entry of fs.readdirSync(binDir)) {
    const linkPath = path.join(binDir, entry);
    try {
      // fs.statSync follows symlinks — throws if target doesn't exist
      fs.statSync(linkPath);
    } catch {
      // Dangling symlink — remove it
      try { fs.unlinkSync(linkPath); } catch {}
    }
  }
}

// Report sizes
const stagingSize = execSync(`du -sh "${STAGING_DIR}/node_modules" 2>/dev/null || echo "unknown"`, {
  encoding: 'utf-8',
}).trim().split('\t')[0];

const originalSize = execSync(`du -sh "${PARENT_DIR}/node_modules" 2>/dev/null || echo "unknown"`, {
  encoding: 'utf-8',
}).trim().split('\t')[0];

console.log(`  ✅ Staging complete: ${stagingSize} (was ${originalSize} with devDeps)`);
console.log(`  📁 Staging dir: ${STAGING_DIR}/node_modules`);
