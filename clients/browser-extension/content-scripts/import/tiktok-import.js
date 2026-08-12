// tiktok-import.js — bulk-imports the logged-in user's TikTok collections
// into Mission Control's Triage Queue.
//
// TikTok's collection APIs work with plain cookie auth when fetched from the
// page context. We use the MAIN-world page-fetch-relay so requests carry the
// user's session cookies.

const TIKTOK_COLLECTION_PAGE_SIZE = 30;
const TIKTOK_ITEM_PAGE_SIZE = 16;
const TIKTOK_MAX_PAGES = 100;
const TIKTOK_BATCH_SIZE = 25;

/**
 * Extract the secUid from TikTok page hydration data.
 * Tries multiple sources in order of reliability.
 */
function extractSecUid() {
  // Method 1: __UNIVERSAL_DATA_FOR_REHYDRATION__ script tag
  const universalEl = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
  if (universalEl) {
    try {
      const data = JSON.parse(universalEl.textContent || '');
      const secUid = data?.['__DEFAULT_SCOPE__']?.['webapp.user-detail']?.userInfo?.user?.secUid;
      if (secUid) return secUid;
    } catch { /* ignore parse errors */ }
  }

  // Method 2: SIGI_STATE script tag
  const sigiEl = document.getElementById('SIGI_STATE');
  if (sigiEl) {
    try {
      const data = JSON.parse(sigiEl.textContent || '');
      // Navigate common SIGI_STATE paths
      const userModule = data?.UserModule || data?.UserPage;
      if (userModule) {
        const users = userModule.users || {};
        const firstUser = Object.values(users)[0];
        if (firstUser?.secUid) return firstUser.secUid;
      }
    } catch { /* ignore parse errors */ }
  }

  // Method 3: Regex scan all script tags
  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    const text = script.textContent || '';
    const match = text.match(/secUid"\s*:\s*"([^"]+)"/);
    if (match) return match[1];
  }

  return null;
}

/**
 * Extract the username from the current URL or page.
 */
function extractTikTokUsername() {
  const pathMatch = window.location.pathname.match(/^\/@([^/]+)/);
  if (pathMatch) return pathMatch[1];
  return null;
}

/**
 * Fetch the user's collection list from TikTok API.
 */
async function fetchCollections(secUid) {
  const { relayFetch } = window.MCImportCommon;
  const collections = [];
  let cursor = 0;
  let pages = 0;

  while (pages < TIKTOK_MAX_PAGES) {
    const url = `https://www.tiktok.com/api/user/collection_list/?aid=1988&count=${TIKTOK_COLLECTION_PAGE_SIZE}&cursor=${cursor}&secUid=${encodeURIComponent(secUid)}`;

    const response = await relayFetch(url, { credentials: 'include' });
    if (!response.ok) {
      throw new Error(`TikTok collection_list failed: ${response.status}`);
    }

    const data = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
    const items = Array.isArray(data?.collectionList) ? data.collectionList : [];
    collections.push(...items);

    pages++;
    if (!data?.hasMore) break;
    cursor = data.cursor || cursor + TIKTOK_COLLECTION_PAGE_SIZE;
  }

  return collections;
}

/**
 * Fetch items from a single collection.
 */
async function fetchCollectionItems(collectionId) {
  const { relayFetch } = window.MCImportCommon;
  const items = [];
  let cursor = 0;
  let pages = 0;

  while (pages < TIKTOK_MAX_PAGES) {
    const url = `https://www.tiktok.com/api/collection/item_list/?aid=1988&count=${TIKTOK_ITEM_PAGE_SIZE}&cursor=${cursor}&collectionId=${collectionId}&sourceType=113`;

    const response = await relayFetch(url, { credentials: 'include' });
    if (!response.ok) {
      throw new Error(`TikTok item_list failed: ${response.status}`);
    }

    const data = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
    const pageItems = Array.isArray(data?.itemList) ? data.itemList : [];
    items.push(...pageItems);

    pages++;
    if (!data?.hasMore) break;
    cursor = data.cursor || cursor + TIKTOK_ITEM_PAGE_SIZE;
  }

  return items;
}

/**
 * Normalize a TikTok video item into the Mission Control import format.
 */
function normalizeTikTokItem(item, username, collectionName, collectionId) {
  if (!item || !item.id) return null;

  const author = item.author?.uniqueId || username;

  return {
    sourcePlatform: 'tiktok',
    sourceId: `tiktok:${item.id}`,
    sourceUrl: `https://www.tiktok.com/@${author}/video/${item.id}`,
    canonicalUrl: `https://www.tiktok.com/@${author}/video/${item.id}`,
    title: item.desc || `TikTok by @${author}`,
    contentType: 'video',
    rawMetadata: {
      username: author,
      createTime: item.createTime,
      collectionName,
      collectionId,
      importedVia: 'browser_extension_bulk_import',
    },
  };
}

async function runTikTokImport() {
  const { reportProgress, sendBatch } = window.MCImportCommon;
  const username = extractTikTokUsername();

  if (!username) {
    reportProgress('tiktok', { done: true, error: 'Navigate to a TikTok profile page (@username) to import collections.' });
    return;
  }

  const secUid = extractSecUid();
  if (!secUid) {
    reportProgress('tiktok', { done: true, error: 'Could not extract secUid — make sure you are logged in and on a profile page.' });
    return;
  }

  let totalImported = 0;
  let totalSkipped = 0;
  const errors = [];

  reportProgress('tiktok', { imported: 0, skipped: 0, done: false });

  // Fetch all collections
  let collections;
  try {
    collections = await fetchCollections(secUid);
  } catch (err) {
    reportProgress('tiktok', { done: true, error: `Failed to fetch collections: ${err.message}` });
    return;
  }

  if (!collections.length) {
    reportProgress('tiktok', { done: true, error: 'No collections found for this user.' });
    return;
  }

  // Process each collection
  for (const collection of collections) {
    const collectionId = collection.id;
    const collectionName = collection.name || `Collection ${collectionId}`;

    let items;
    try {
      items = await fetchCollectionItems(collectionId);
    } catch (err) {
      errors.push(`Collection "${collectionName}": ${err.message}`);
      continue;
    }

    const normalized = items.map((item) => normalizeTikTokItem(item, username, collectionName, collectionId)).filter(Boolean);

    for (let i = 0; i < normalized.length; i += TIKTOK_BATCH_SIZE) {
      const batch = normalized.slice(i, i + TIKTOK_BATCH_SIZE);
      try {
        const result = await sendBatch('tiktok', batch);
        totalImported += result.imported;
        totalSkipped += result.skipped;
        if (result.errors?.length) errors.push(...result.errors);
      } catch (err) {
        errors.push(err.message || 'Failed to submit batch');
      }
      reportProgress('tiktok', { imported: totalImported, skipped: totalSkipped, done: false });
    }
  }

  reportProgress('tiktok', { imported: totalImported, skipped: totalSkipped, errors: errors.slice(0, 10), done: true });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'mc-start-import' && message.platform === 'tiktok') {
    runTikTokImport();
    sendResponse({ started: true });
  }
});
