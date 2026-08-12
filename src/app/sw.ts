/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { defaultCache } from "@serwist/turbopack/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist, NetworkOnly } from "serwist";
import {
  DEFAULT_CAPTURE_IMAGE_MAX_BYTES,
  OFFLINE_IMAGE_MAX_COUNT,
  OFFLINE_IMAGE_MAX_TOTAL_BYTES,
  detectCaptureImageMimeType,
  isCaptureImageMimeType,
  type CaptureImageMimeType,
} from "@/lib/capture-image";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// API routes must never be cached — always go to network to ensure
// mutations (imports, renames, sync writes) are immediately reflected.
// The defaultCache includes a NetworkFirst rule for /api/ that would
// otherwise take priority (routes match in registration order), so we
// prepend our NetworkOnly rule before defaultCache entries.
const apiNetworkOnly = {
  matcher: ({ url }: { url: URL }) => url.pathname.startsWith("/api/"),
  handler: new NetworkOnly(),
};

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [apiNetworkOnly, ...defaultCache],
  fallbacks: {
    entries: [
      {
        url: "/~offline",
        matcher({ request }) {
          return request.destination === "document";
        },
      },
    ],
  },
});

// ---------------------------------------------------------------------------
// Background Sync — replay offline captures when connectivity returns
// ---------------------------------------------------------------------------
const OFFLINE_SYNC_TAG = "sync-offline-captures";
const OFFLINE_DB_NAME = "mission-control-offline";
const OFFLINE_STORE = "pending-captures";
const OFFLINE_ACTION_STORE = "pending-actions";

interface PendingCapture {
  id: string;
  title: string;
  body?: string;
  createdAt: string;
  attempts: number;
  lastError?: string;
  destination?: {
    connectorType: string;
    connectorInstanceId?: string;
    sourceListId?: string;
    sourceListName?: string;
  };
  image?: {
    blob: Blob;
    name: string;
    type: CaptureImageMimeType;
    size: number;
  };
}

function openOfflineDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OFFLINE_STORE)) {
        db.createObjectStore(OFFLINE_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(OFFLINE_ACTION_STORE)) {
        const store = db.createObjectStore(OFFLINE_ACTION_STORE, { keyPath: "id" });
        store.createIndex("type", "type", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function queueSharedImageCapture(form: FormData, image: File, maxBytes: number): Promise<void> {
  if (!isCaptureImageMimeType(image.type) || image.size > maxBytes) {
    throw new Error("Shared image type or size is not supported");
  }
  const detectedMime = detectCaptureImageMimeType(new Uint8Array(await image.arrayBuffer()));
  if (detectedMime !== image.type) {
    throw new Error("Shared image content does not match its MIME type");
  }

  const db = await openOfflineDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OFFLINE_STORE, "readwrite");
      const store = tx.objectStore(OFFLINE_STORE);
      const getAll = store.getAll();
      getAll.onsuccess = () => {
        const existing = (getAll.result as PendingCapture[]).flatMap((item) => item.image ? [item.image] : []);
        const existingBytes = existing.reduce((sum, queued) => sum + queued.size, 0);
        if (
          existing.length >= OFFLINE_IMAGE_MAX_COUNT
          || existingBytes + image.size > OFFLINE_IMAGE_MAX_TOTAL_BYTES
        ) {
          tx.abort();
          reject(new Error("Offline image queue limit reached"));
          return;
        }

        const title = String(form.get("title") || "").trim()
          || image.name.replace(/\.[^.]+$/, "")
          || "Image capture";
        const text = String(form.get("text") || "").trim();
        const url = String(form.get("url") || "").trim();
        store.add({
          id: `offline-${Date.now()}-${crypto.randomUUID()}`,
          title,
          body: [url, text && text !== url ? text : ""].filter(Boolean).join("\n") || undefined,
          createdAt: new Date().toISOString(),
          attempts: 0,
          image: {
            blob: image,
            name: image.name,
            type: detectedMime,
            size: image.size,
          },
        } satisfies PendingCapture);
      };
      getAll.onerror = () => reject(getAll.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        if (tx.error) reject(tx.error);
      };
    });
  } finally {
    db.close();
  }
}

async function handleShareTarget(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const image = form.get("image");
    if (image instanceof File && image.size > 0) {
      let maxBytes = DEFAULT_CAPTURE_IMAGE_MAX_BYTES;
      try {
        const response = await fetch("/api/triage/capture/image");
        if (response.ok) {
          const config = await response.json() as { maxBytes?: number };
          if (Number.isSafeInteger(config.maxBytes) && config.maxBytes && config.maxBytes > 0) {
            maxBytes = config.maxBytes;
          }
        }
      } catch {
        // Offline share targets use the documented default and retain failures for user review.
      }
      await queueSharedImageCapture(form, image, maxBytes);
      const registration = self.registration as ServiceWorkerRegistration & {
        sync?: { register(tag: string): Promise<void> };
      };
      await registration.sync?.register(OFFLINE_SYNC_TAG);
      return Response.redirect(new URL("/capture?shared_image_queued=1", self.location.origin), 303);
    }

    const params = new URLSearchParams();
    const title = String(form.get("title") || "").trim();
    const text = String(form.get("text") || "").trim();
    const url = String(form.get("url") || "").trim();
    if (title) params.set("shared_title", title);
    if (text) params.set("shared_text", text);
    if (url) params.set("shared_url", url);
    return Response.redirect(
      new URL(`/capture${params.size ? `?${params}` : ""}`, self.location.origin),
      303,
    );
  } catch {
    return Response.redirect(new URL("/capture?shared_image_error=1", self.location.origin), 303);
  }
}

self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.origin === self.location.origin && url.pathname === "/capture") {
    event.respondWith(handleShareTarget(event.request));
  }
});

serwist.addEventListeners();

async function replayOfflineCaptures(): Promise<void> {
  const db = await openOfflineDB();

  try {
    const items: PendingCapture[] = await new Promise((resolve, reject) => {
      const tx = db.transaction(OFFLINE_STORE, "readonly");
      const req = tx.objectStore(OFFLINE_STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    for (const item of items) {
      let res: Response;
      if (item.image) {
        const form = new FormData();
        form.set("image", item.image.blob, item.image.name);
        form.set("title", item.title);
        if (item.body) form.set("description", item.body);
        form.set("client", "browser");
        res = await fetch("/api/triage/capture/image", {
          method: "POST",
          headers: { "X-Idempotency-Key": item.id },
          body: form,
        });
      } else {
        res = await fetch("/api/tasks", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Idempotency-Key": item.id,
          },
          body: JSON.stringify({
            title: item.title,
            description: item.body || undefined,
            status: "todo",
            ...item.destination,
          }),
        });
      }

      if (res.ok) {
        // Remove synced item
        const tx = db.transaction(OFFLINE_STORE, "readwrite");
        tx.objectStore(OFFLINE_STORE).delete(item.id);
        await new Promise<void>((resolve) => {
          tx.oncomplete = () => resolve();
        });
      } else {
        item.attempts++;
        item.lastError = `HTTP ${res.status}`;
        const tx = db.transaction(OFFLINE_STORE, "readwrite");
        tx.objectStore(OFFLINE_STORE).put(item);
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        if (res.status >= 500) {
          throw new Error(`Sync failed: HTTP ${res.status}`);
        }
      }
    }
  } finally {
    db.close();
  }

  // Notify all open clients that sync is complete
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    client.postMessage({ type: "offline-sync-complete" });
  }
}

self.addEventListener("sync", (event: ExtendableEvent & { tag?: string }) => {
  if (event.tag === OFFLINE_SYNC_TAG) {
    event.waitUntil(replayOfflineCaptures());
  }
});

// ---------------------------------------------------------------------------
// Push Notifications
// ---------------------------------------------------------------------------
self.addEventListener("push", (event: PushEvent) => {
  const data = event.data?.json() ?? {};
  const title = data.title || "Mission Control";
  const options: NotificationOptions = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag || "mc-notification",
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        // Focus existing window if available
        for (const client of windowClients) {
          if (client.url.includes(url) && "focus" in client) {
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      })
  );
});
