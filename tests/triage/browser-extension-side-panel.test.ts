import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const extensionDir = path.resolve(process.cwd(), 'clients/browser-extension');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
const popupScript = fs.readFileSync(path.join(extensionDir, 'popup.js'), 'utf8');
const sidePanelHtml = fs.readFileSync(path.join(extensionDir, 'sidepanel.html'), 'utf8');
const sidePanelLoader = fs.readFileSync(path.join(extensionDir, 'sidepanel-loader.js'), 'utf8');
const packageScript = fs.readFileSync(path.join(extensionDir, 'scripts/package.mjs'), 'utf8');

describe('browser extension persistent import panel', () => {
  it('declares a global side panel with the required permission', () => {
    expect(manifest.permissions).toContain('sidePanel');
    expect(manifest.side_panel).toEqual({ default_path: 'sidepanel.html' });
  });

  it('packages all modules referenced by the popup and manifest', () => {
    for (const entry of [
      "'background'",
      "'popup'",
      "'shared'",
      "'sidepanel.html'",
      "'sidepanel-loader.js'",
    ]) {
      expect(packageScript).toContain(entry);
    }
  });

  it('loads the shared extension UI in side-panel mode', () => {
    expect(sidePanelHtml).toContain('<script src="sidepanel-loader.js"></script>');
    expect(sidePanelLoader).toContain("popup.html?surface=sidepanel");
    const popupHtml = fs.readFileSync(path.join(extensionDir, 'popup.html'), 'utf8');
    const captureClientTag = '<script src="shared/capture-client.js"></script>';
    const popupTag = '<script src="popup.js"></script>';
    expect(popupHtml).toContain(captureClientTag);
    expect(popupHtml.indexOf(captureClientTag)).toBeLessThan(popupHtml.indexOf(popupTag));
  });

  it('keeps the side panel open and refreshes it after active-tab navigation', () => {
    expect(popupScript).toContain("if (!isSidePanel) window.close()");
    expect(popupScript).toContain('chrome.tabs.onActivated.addListener');
    expect(popupScript).toContain('chrome.tabs.onUpdated.addListener');
    expect(popupScript).toContain('changeInfo.status === \'complete\'');
  });
});
