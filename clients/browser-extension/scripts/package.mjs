#!/usr/bin/env node
/**
 * Package the browser extension into a .zip for store submission.
 *
 * Usage:
 *   node scripts/package.mjs
 *   node scripts/package.mjs --output ../dist/extension-v1.2.0.zip
 *
 * Reads version from manifest.json and produces:
 *   dist/mission-control-extension-v{version}.zip
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;

// Parse args
const args = process.argv.slice(2);
const outputIdx = args.indexOf('--output');
const distDir = path.join(ROOT, 'dist');

let outputPath;
if (outputIdx !== -1 && args[outputIdx + 1]) {
  outputPath = path.resolve(args[outputIdx + 1]);
} else {
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }
  outputPath = path.join(distDir, `mission-control-extension-v${version}.zip`);
}

// Ensure output directory exists
const outputDir = path.dirname(outputPath);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Files/directories to include
const includes = [
  'manifest.json',
  'background.js',
  'background',
  'popup.html',
  'popup.js',
  'popup',
  'shared',
  'sidepanel.html',
  'sidepanel-loader.js',
  'page-fetch-relay.js',
  'icons',
  'content-scripts',
];

// Validate all expected files exist
for (const item of includes) {
  const fullPath = path.join(ROOT, item);
  if (!fs.existsSync(fullPath)) {
    console.error(`ERROR: Expected file/directory not found: ${item}`);
    process.exit(1);
  }
}

// Remove old zip if it exists
if (fs.existsSync(outputPath)) {
  fs.unlinkSync(outputPath);
}

// Build the zip using PowerShell (cross-platform-ish, works on Windows)
// We create a temp directory with only the files we want, then zip it
const tempDir = path.join(distDir, '_package_temp');
if (fs.existsSync(tempDir)) {
  fs.rmSync(tempDir, { recursive: true });
}
fs.mkdirSync(tempDir, { recursive: true });

// Copy files to temp dir
for (const item of includes) {
  const src = path.join(ROOT, item);
  const dest = path.join(tempDir, item);
  if (fs.statSync(src).isDirectory()) {
    copyDirSync(src, dest);
  } else {
    fs.copyFileSync(src, dest);
  }
}

// Create zip
try {
  // Try using PowerShell's Compress-Archive (Windows)
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${tempDir}${path.sep}*' -DestinationPath '${outputPath}' -Force"`,
    { stdio: 'pipe' }
  );
} catch {
  // Fallback to zip command (Linux/Mac)
  try {
    execSync(`cd "${tempDir}" && zip -r "${outputPath}" .`, { stdio: 'pipe' });
  } catch {
    console.error('ERROR: Could not create zip. Install zip or use PowerShell.');
    process.exit(1);
  }
}

// Cleanup
fs.rmSync(tempDir, { recursive: true });

console.log(`✓ Packaged extension v${version}`);
console.log(`  → ${outputPath}`);

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
