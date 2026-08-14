import { chromium } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const appDir = path.join(root, 'src', 'app');
const gradientStart = '#60a5fa';
const gradientEnd = '#c084fc';
const iconBackground = '#020617';
const iconBorder = '#1e293b';
// Chromium and Windows cache installed-app icons by URL; bump this when the artwork changes.
const iconVersion = 'v2';

function satelliteSvg(size, maskable = false) {
  const transform = maskable ? 'translate(124 124) scale(11)' : 'translate(76 76) scale(15)';
  const background = maskable
    ? `<rect width="512" height="512" fill="${iconBackground}" />`
    : `<rect x="20" y="20" width="472" height="472" rx="104" fill="${iconBackground}"
             stroke="${iconBorder}" stroke-width="8" />`;

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
      <defs>
        <linearGradient id="brand-gradient" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="${gradientStart}" />
          <stop offset="1" stop-color="${gradientEnd}" />
        </linearGradient>
      </defs>
      ${background}
      <g transform="${transform}" fill="none" stroke="url(#brand-gradient)" stroke-width="2.2"
         stroke-linecap="round" stroke-linejoin="round">
        <path d="m13.5 6.5-3.148-3.148a1.205 1.205 0 0 0-1.704 0L6.352 5.648a1.205 1.205 0 0 0 0 1.704L9.5 10.5"/>
        <path d="M16.5 7.5 19 5"/>
        <path d="m17.5 10.5 3.148 3.148a1.205 1.205 0 0 1 0 1.704l-2.296 2.296a1.205 1.205 0 0 1-1.704 0L13.5 14.5"/>
        <path d="M9 21a6 6 0 0 0-6-6"/>
        <path d="M9.352 10.648a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l4.296-4.296a1.205 1.205 0 0 0 0-1.704l-2.296-2.296a1.205 1.205 0 0 0-1.704 0z"/>
      </g>
    </svg>`;
}

async function renderIcon(page, size, outputPath, maskable = false) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;width:${size}px;height:${size}px;background:transparent}</style>${satelliteSvg(size, maskable)}`
  );
  await page.screenshot({ path: outputPath, omitBackground: true });
}

function createIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(images.length * 16);
  let offset = header.length + directory.length;

  images.forEach(({ size, data }, index) => {
    const entry = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, entry);
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2);
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });

  return Buffer.concat([header, directory, ...images.map(({ data }) => data)]);
}

await mkdir(publicDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  for (const size of [192, 512]) {
    await renderIcon(page, size, path.join(publicDir, `icon-${iconVersion}-${size}.png`));
    await renderIcon(page, size, path.join(publicDir, `icon-maskable-${iconVersion}-${size}.png`), true);
  }

  const faviconImages = [];
  for (const size of [16, 32, 48]) {
    const outputPath = path.join(publicDir, `.favicon-${size}.png`);
    await renderIcon(page, size, outputPath);
    faviconImages.push({ size, data: await readFile(outputPath) });
  }

  const ico = createIco(faviconImages);
  await writeFile(path.join(publicDir, 'favicon.ico'), ico);
  await writeFile(path.join(appDir, 'favicon.ico'), ico);
} finally {
  await browser.close();
  await Promise.all(
    [16, 32, 48].map((size) => rm(path.join(publicDir, `.favicon-${size}.png`), { force: true }))
  );
}

console.log('Generated Mission Control favicon and PWA icon assets.');
