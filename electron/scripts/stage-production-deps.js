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

// Handle native modules: better-sqlite3 needs rebuild for Electron
const betterSqlite = path.join(STAGING_DIR, 'node_modules', 'better-sqlite3');
if (fs.existsSync(betterSqlite)) {
  console.log('  Rebuilding better-sqlite3 for Electron...');
  try {
    // Get electron version from electron/package.json
    const electronPkg = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, 'package.json'), 'utf-8'));
    const electronVersion = electronPkg.devDependencies.electron.replace('^', '').replace('~', '');
    execSync(
      `npx @electron/rebuild -v ${electronVersion} -m "${STAGING_DIR}" --only better-sqlite3`,
      { cwd: ELECTRON_DIR, stdio: 'pipe', timeout: 120_000 }
    );
  } catch (err) {
    console.log('  ⚠️  Could not rebuild better-sqlite3 — may not work at runtime');
  }
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
