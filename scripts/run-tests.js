#!/usr/bin/env node
/**
 * Cross-platform test runner for Node.js built-in test runner.
 *
 * Shell glob patterns (dist/*.test.js) don't expand on Windows.
 * This script finds all .test.js files in dist/ and passes them
 * to `node --test` explicitly.
 */
'use strict';

const { readdirSync, statSync, existsSync } = require('fs');
const { join } = require('path');
const { execFileSync } = require('child_process');

// ── Stale dist/ detection ──
function checkDistFreshness() {
  if (!existsSync('dist') || !existsSync('src')) return;
  try {
    const newestSrc = getNewestMtime('src', '.ts');
    const newestDist = getNewestMtime('dist', '.js');
    if (newestSrc > newestDist + 5000) {
      console.error('ERROR: dist/ is stale — src/ has newer files. Run \x60npm run build\x60 first.');
      process.exit(1);
    }
  } catch { /* skip freshness check on error */ }
}

function getNewestMtime(dir, ext) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, getNewestMtime(full, ext));
    } else if (entry.name.endsWith(ext)) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

checkDistFreshness();

function findTestFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      if (statSync(full).isDirectory()) {
        files.push(...findTestFiles(full));
      } else if (entry.endsWith('.test.js')) {
        files.push(full);
      }
    } catch {
      // skip inaccessible entries
    }
  }
  return files;
}

const testFiles = findTestFiles('dist');

if (testFiles.length === 0) {
  console.error('No test files found in dist/');
  process.exit(1);
}

console.log(`Found ${testFiles.length} test files`);

// Use execFileSync (argv array), NOT execSync with an interpolated string.
// A test path containing a space or shell metacharacter ($, ;, `, etc.)
// would either break argv parsing or enable injection through the shell.
// Found by external review 2026-04-23.
try {
  execFileSync('node', ['--test', ...testFiles], { stdio: 'inherit' });
} catch (err) {
  process.exit(err.status || 1);
}
