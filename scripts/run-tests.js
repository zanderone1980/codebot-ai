#!/usr/bin/env node
/**
 * Cross-platform test runner for Node.js built-in test runner.
 *
 * Shell glob patterns (dist/*.test.js) don't expand on Windows.
 * This script finds all .test.js files in dist/ and passes them
 * to `node --test` explicitly.
 */
'use strict';

const { readdirSync, statSync } = require('fs');
const { join } = require('path');
const { execSync } = require('child_process');

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

try {
  execSync(`node --test ${testFiles.join(' ')}`, { stdio: 'inherit' });
} catch (err) {
  process.exit(err.status || 1);
}
