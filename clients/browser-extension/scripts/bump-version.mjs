#!/usr/bin/env node
/**
 * Bump the extension version in manifest.json.
 *
 * Usage:
 *   node scripts/bump-version.mjs patch   # 1.0.0 → 1.0.1
 *   node scripts/bump-version.mjs minor   # 1.0.0 → 1.1.0
 *   node scripts/bump-version.mjs major   # 1.0.0 → 2.0.0
 *   node scripts/bump-version.mjs 2.3.4   # set exact version
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const manifestPath = path.resolve(__dirname, '..', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: bump-version.mjs <patch|minor|major|x.y.z>');
  process.exit(1);
}

const current = manifest.version;
const parts = current.split('.').map(Number);
let newVersion;

switch (arg) {
  case 'patch':
    parts[2]++;
    newVersion = parts.join('.');
    break;
  case 'minor':
    parts[1]++;
    parts[2] = 0;
    newVersion = parts.join('.');
    break;
  case 'major':
    parts[0]++;
    parts[1] = 0;
    parts[2] = 0;
    newVersion = parts.join('.');
    break;
  default:
    if (/^\d+\.\d+\.\d+$/.test(arg)) {
      newVersion = arg;
    } else {
      console.error(`Invalid version or bump type: ${arg}`);
      process.exit(1);
    }
}

manifest.version = newVersion;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`✓ Version bumped: ${current} → ${newVersion}`);
