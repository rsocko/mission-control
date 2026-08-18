// pinterest-import.js — bulk-imports the logged-in user's Pinterest boards/pins
// into Mission Control's Triage Queue.
//
// Pinterest uses a resource-based API pattern with CSRF token auth. Requests
// must carry specific headers (X-CSRFToken, X-Requested-With, etc.) and the
// page's session cookies — so we use the MAIN-world page-fetch-relay.

const PINTEREST_MAX_PAGES = 100;
const PINTEREST_BATCH_SIZE = 25;

/**
 * Extract CSRF token from Pinterest cookies.
 */
function getPinterestCsrfToken() {
  const match = document.cookie.split('; ').find((c) => c.startsWith('csrftoken='));
  return match ? match.split('=')[1] : null;
}

/**
 * Extract the username from the current Pinterest URL.
 */
function extractPinterestUsername() {
  // Match /{username}/ or /{username}/{board}/
  const pathMatch = window.location.pathname.match(/^\/([^_][^/]+)\/?/);
  if (pathMatch) {
    const candidate = pathMatch[1];
    // Filter out known non-user paths
    const reserved = ['search', 'categories', 'topics', 'today', 'pin', 'settings', 'business', 'ideas'];
    if (!reserved.includes(candidate)) return candidate;
  }
  return null;
}

/**
 * Extract board slug from URL if on a board page.
 */
function extractPinterestBoard() {
  const pathMatch = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
  if (pathMatch) {
    const username = pathMatch[1];
    const board = pathMatch[2];
    const reserved = ['search', 'categories', 'topics', 'today', 'pin', 'settings', 'business', 'ideas'];
    if (!reserved.includes(username) && board !== '_saved' && board !== '_created') {
      return { username, board };
    }
  }
  return null;
}

/**
 * Build Pinterest API headers.
 */
function buildPinterestHeaders(csrfToken, username) {
  return {
    'X-CSRFToken': csrfToken,
    'X-Requested-With': 'XMLHttpRequest',
    'X-Pinterest-PWS-Handler': `www/${username}.js`,
    'X-Pinterest-Source-Url': `/${username}/`,
    'Accept': 'application/json',
  };
}

/**
 * Fetch user's boards list from Pinterest resource API.
 */
async function fetchPinterestBoards(csrfToken, username) {
  const { collectPages, relayFetch } = window.MCImportCommon;
  return collectPages({
    maxPages: PINTEREST_MAX_PAGES,
    initialCursor: null,
    async fetchPage(bookmark) {
      const options = { username, field_set_key: 'profile_grid_item' };
      if (bookmark) options.bookmarks = [bookmark];
      const dataParam = encodeURIComponent(JSON.stringify({ options, context: {} }));
      const url = `https://www.pinterest.com/resource/BoardsResource/get/?data=${dataParam}&source_url=/${username}/`;
      const response = await relayFetch(url, {
        credentials: 'include',
        headers: buildPinterestHeaders(csrfToken, username),
      });
      if (!response.ok) throw new Error(`Pinterest BoardsResource failed: ${response.status}`);
      const data = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
      const next = data?.resource_response?.bookmark;
      return {
        items: Array.isArray(data?.resource_response?.data) ? data.resource_response.data : [],
        nextCursor: next && next !== '-end-' ? next : null,
      };
    },
  });
}

/**
 * Fetch pins from a single board.
 */
async function fetchBoardPins(csrfToken, username, boardId, boardSlug) {
  const { collectPages, relayFetch } = window.MCImportCommon;
  return collectPages({
    maxPages: PINTEREST_MAX_PAGES,
    initialCursor: null,
    async fetchPage(bookmark) {
      const options = { board_id: boardId, field_set_key: 'partner_react_grid_pin' };
      if (bookmark) options.bookmarks = [bookmark];
      const dataParam = encodeURIComponent(JSON.stringify({ options, context: {} }));
      const sourceUrl = `/${username}/${boardSlug}/`;
      const url = `https://www.pinterest.com/resource/BoardFeedResource/get/?data=${dataParam}&source_url=${encodeURIComponent(sourceUrl)}`;
      const response = await relayFetch(url, {
        credentials: 'include',
        headers: buildPinterestHeaders(csrfToken, username),
      });
      if (!response.ok) throw new Error(`Pinterest BoardFeedResource failed: ${response.status}`);
      const data = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
      const next = data?.resource_response?.bookmark;
      return {
        items: Array.isArray(data?.resource_response?.data) ? data.resource_response.data : [],
        nextCursor: next && next !== '-end-' ? next : null,
      };
    },
  });
}

/**
 * Normalize a Pinterest pin into Mission Control import format.
 */
function normalizePinterestPin(pin, boardName, boardId) {
  if (!pin || !pin.id) return null;

  const title = pin.title || (pin.description ? pin.description.slice(0, 100) : 'Pinterest pin');

  return {
    sourcePlatform: 'pinterest',
    sourceId: `pinterest:${pin.id}`,
    sourceUrl: `https://www.pinterest.com/pin/${pin.id}/`,
    canonicalUrl: pin.link || `https://www.pinterest.com/pin/${pin.id}/`,
    title,
    description: pin.description || undefined,
    contentType: 'image',
    rawMetadata: {
      boardName,
      boardId,
      thumbnailUrl: pin.image_cover_hd_url || pin.image_cover_url || pin.images?.orig?.url || null,
      importedVia: 'browser_extension_bulk_import',
    },
  };
}

async function runPinterestImport() {
  const { createImportSession, reportProgress } = window.MCImportCommon;
  const username = extractPinterestUsername();

  if (!username) {
    reportProgress('pinterest', { done: true, error: 'Navigate to a Pinterest profile or board page to import pins.' });
    return;
  }

  const csrfToken = getPinterestCsrfToken();
  if (!csrfToken) {
    reportProgress('pinterest', { done: true, error: 'Could not find Pinterest CSRF token — make sure you are logged in.' });
    return;
  }

  reportProgress('pinterest', { imported: 0, skipped: 0, done: false });
  const session = createImportSession('pinterest', PINTEREST_BATCH_SIZE);

  // Check if we're on a specific board page
  const boardInfo = extractPinterestBoard();

  let boardsToProcess = [];

  if (boardInfo) {
    // Import just this board — we need to fetch the board ID
    try {
      const allBoards = await fetchPinterestBoards(csrfToken, boardInfo.username);
      const targetBoard = allBoards.find((b) => b.url && b.url.includes(`/${boardInfo.board}/`));
      if (targetBoard) {
        boardsToProcess = [targetBoard];
      } else {
        // Try to use board slug directly
        boardsToProcess = [{ id: null, name: boardInfo.board, url: `/${boardInfo.username}/${boardInfo.board}/` }];
      }
    } catch (err) {
      session.addError(new Error(`Failed to find board: ${err.message}`));
    }
  } else {
    // Import all boards for this user
    try {
      boardsToProcess = await fetchPinterestBoards(csrfToken, username);
    } catch (err) {
      reportProgress('pinterest', { done: true, error: `Failed to fetch boards: ${err.message}` });
      return;
    }
  }

  if (!boardsToProcess.length) {
    reportProgress('pinterest', { done: true, error: 'No boards found to import.' });
    return;
  }

  // Process each board
  for (const board of boardsToProcess) {
    const boardId = board.id;
    const boardName = board.name || 'Unknown board';
    // Extract slug from URL or use name
    const boardSlug = board.url ? board.url.split('/').filter(Boolean).pop() : boardName.toLowerCase().replace(/\s+/g, '-');

    if (!boardId) {
      session.addError(new Error(`Board "${boardName}": missing board ID, skipping`));
      continue;
    }

    let pins;
    try {
      pins = await fetchBoardPins(csrfToken, username, boardId, boardSlug);
    } catch (err) {
      session.addError(new Error(`Board "${boardName}": ${err.message}`));
      continue;
    }

    const normalized = pins.map((pin) => normalizePinterestPin(pin, boardName, boardId)).filter(Boolean);

    await session.submit(normalized);
  }

  session.finish();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'mc-start-import' && message.platform === 'pinterest') {
    runPinterestImport();
    sendResponse({ started: true });
  }
});
