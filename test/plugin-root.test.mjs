import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

test('the plugin root has no lockfile, so Claude Code installs no packages with the plugin', () => {
  for (const lockfile of [
    'package-lock.json',
    'npm-shrinkwrap.json',
    'bun.lock',
    'bun.lockb',
    'yarn.lock',
    'pnpm-lock.yaml',
  ]) {
    assert.equal(existsSync(new URL(lockfile, root)), false, `${lockfile} at the plugin root`);
  }
});

test('the root package.json declares only the peer dependencies of the OpenCode TUI', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    assert.equal(pkg[field], undefined, `${field} in package.json`);
  }
  assert.deepEqual(Object.keys(pkg.peerDependencies).sort(), ['@opentui/core', '@opentui/solid', 'solid-js']);
});

test('the package carries the files the OpenCode install needs', () => {
  const { files } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  assert.ok(files.includes('opencode/opencode.example.jsonc'));
  assert.ok(files.includes('opencode/*.mjs'));
});
