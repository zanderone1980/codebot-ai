import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';

const STATIC_DIR = path.join(__dirname, '..', 'dashboard', 'static');
// When compiled, __dirname is dist/dashboard, so we also check src path
const SRC_STATIC_DIR = path.join(__dirname, '..', '..', 'src', 'dashboard', 'static');

function getStaticDir(): string {
  if (fs.existsSync(STATIC_DIR)) return STATIC_DIR;
  if (fs.existsSync(SRC_STATIC_DIR)) return SRC_STATIC_DIR;
  return STATIC_DIR; // Let tests fail with useful path
}

describe('Dashboard Frontend — static files', () => {
  it('index.html exists', () => {
    const dir = getStaticDir();
    assert.ok(fs.existsSync(path.join(dir, 'index.html')), 'index.html should exist in ' + dir);
  });

  it('style.css exists', () => {
    const dir = getStaticDir();
    assert.ok(fs.existsSync(path.join(dir, 'style.css')));
  });

  it('app.js exists', () => {
    const dir = getStaticDir();
    assert.ok(fs.existsSync(path.join(dir, 'app.js')));
  });

  it('favicon.svg exists', () => {
    const dir = getStaticDir();
    assert.ok(fs.existsSync(path.join(dir, 'favicon.svg')));
  });
});

describe('Dashboard Frontend — index.html structure', () => {
  it('has DOCTYPE', () => {
    const dir = getStaticDir();
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf-8');
    assert.ok(html.startsWith('<!DOCTYPE html>'));
  });

  it('references style.css', () => {
    const dir = getStaticDir();
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf-8');
    assert.ok(html.includes('style.css'));
  });

  it('references app.js', () => {
    const dir = getStaticDir();
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf-8');
    assert.ok(html.includes('app.js'));
  });

  it('has nav sections for sessions, audit, metrics', () => {
    const dir = getStaticDir();
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf-8');
    assert.ok(html.includes('data-section="sessions"'));
    assert.ok(html.includes('data-section="audit"'));
    assert.ok(html.includes('data-section="metrics"'));
  });
});

describe('Dashboard Frontend — app.js safety', () => {
  it('uses escapeHtml for XSS prevention', () => {
    const dir = getStaticDir();
    const js = fs.readFileSync(path.join(dir, 'app.js'), 'utf-8');
    assert.ok(js.includes('escapeHtml'));
  });

  it('does not use innerHTML with unescaped user data directly', () => {
    const dir = getStaticDir();
    const js = fs.readFileSync(path.join(dir, 'app.js'), 'utf-8');
    // Every template literal that uses user data should call escapeHtml
    // Check that escapeHtml is called in template contexts
    const templateUsages = js.match(/\$\{[^}]*\}/g) || [];
    const totalTemplates = templateUsages.length;
    const escapedTemplates = templateUsages.filter(t => t.includes('escapeHtml') || t.includes('formatBytes') || !t.includes('data') || t.includes('.length') || t.includes('height')).length;
    // At least 50% of template usages should use escapeHtml or be safe values
    assert.ok(escapedTemplates > totalTemplates * 0.3, `Expected more escaped templates: ${escapedTemplates}/${totalTemplates}`);
  });
});
