import WebKit

enum WebBridgeScript {
    static let handlerName = "mcNativeBridgeHandler"
    static let receiverName = "__mcNativeBridgeReceive"

    static func source(trustedOrigin: TrustedOrigin) -> String {
        let encodedOrigin = NativeContextScript.javascriptStringLiteral(
            trustedOrigin.serialized
        )
        let encodedHandler = NativeContextScript.javascriptStringLiteral(handlerName)
        let encodedReceiver = NativeContextScript.javascriptStringLiteral(receiverName)
        return """
        (() => {
          "use strict";
          const trustedOrigin = \(encodedOrigin);
          if (window.top !== window || window.location.origin !== trustedOrigin) {
            return;
          }
          const handler = window.webkit?.messageHandlers?.[\(encodedHandler)];
          if (!handler || typeof handler.postMessage !== "function") {
            return;
          }

          const contractVersion = 1;
          const maximumMessageBytes = 65536;
          const capabilities = Object.freeze([
            "badge", "externalLinks", "haptics", "push", "shareCaptureStatus"
          ]);
          const supportedActions = Object.freeze([
            "bootstrap", "requestPushPermission", "hapticFeedback", "openURL", "setBadge"
          ]);
          const eventActions = new Set([
            "authenticationChanged", "networkStatus",
            "pushRegistrationChanged", "shareCaptureCompleted"
          ]);
          const pending = new Map();
          const listeners = new Map();
          const deliveredEventIds = new Set();
          const deliveredEventOrder = [];

          const isRecord = (value) =>
            typeof value === "object" && value !== null && !Array.isArray(value);
          const isUUID = (value) =>
            typeof value === "string"
            && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
          const failure = (requestId, action, code, message, retryable) =>
            Object.freeze({
              version: contractVersion,
              requestId,
              action,
              ok: false,
              error: Object.freeze({ code, message, retryable })
            });

          const receive = (message) => {
            if (!isRecord(message)
                || message.version !== contractVersion
                || !isUUID(message.requestId)
                || typeof message.action !== "string") {
              return;
            }

            if (typeof message.ok === "boolean") {
              const entry = pending.get(message.requestId);
              if (!entry || entry.action !== message.action) {
                return;
              }
              pending.delete(message.requestId);
              clearTimeout(entry.timeout);
              entry.resolve(message);
              return;
            }

            if (!eventActions.has(message.action)
                || !isRecord(message.payload)
                || deliveredEventIds.has(message.requestId)) {
              return;
            }
            deliveredEventIds.add(message.requestId);
            deliveredEventOrder.push(message.requestId);
            if (deliveredEventOrder.length > 256) {
              deliveredEventIds.delete(deliveredEventOrder.shift());
            }
            for (const listener of listeners.get(message.action) ?? []) {
              listener(message);
            }
          };

          Object.defineProperty(window, \(encodedReceiver), {
            value: Object.freeze(receive),
            writable: false,
            configurable: false,
            enumerable: false
          });

          const bridge = Object.freeze({
            contractVersion,
            capabilities,
            supportedActions,
            request(action, payload) {
              if (!supportedActions.includes(action) || !isRecord(payload)) {
                return Promise.resolve(
                  failure(
                    crypto.randomUUID(),
                    typeof action === "string" ? action : "unknown",
                    "INVALID_MESSAGE",
                    "The bridge request is invalid",
                    false
                  )
                );
              }

              let requestId;
              for (let attempt = 0; attempt < 4; attempt += 1) {
                const candidate = crypto.randomUUID();
                if (!pending.has(candidate)) {
                  requestId = candidate;
                  break;
                }
              }
              if (!requestId) {
                return Promise.reject(new Error("Unable to allocate a bridge request ID"));
              }

              const request = { version: contractVersion, requestId, action, payload };
              let serialized;
              try {
                serialized = JSON.stringify(request);
              } catch {
                return Promise.resolve(
                  failure(
                    requestId, action, "INVALID_MESSAGE",
                    "The bridge request is invalid", false
                  )
                );
              }
              if (new TextEncoder().encode(serialized).byteLength > maximumMessageBytes) {
                return Promise.resolve(
                  failure(
                    requestId, action, "INVALID_MESSAGE",
                    "The bridge request exceeds the maximum size", false
                  )
                );
              }

              return new Promise((resolve) => {
                const timeout = setTimeout(() => {
                  if (!pending.delete(requestId)) {
                    return;
                  }
                  resolve(
                    failure(
                      requestId, action, "TIMEOUT",
                      "The native request timed out", true
                    )
                  );
                }, 30000);
                pending.set(requestId, { action, resolve, timeout });
                try {
                  handler.postMessage(request);
                } catch {
                  clearTimeout(timeout);
                  pending.delete(requestId);
                  resolve(
                    failure(
                      requestId, action, "NATIVE_FAILURE",
                      "The native request could not be sent", true
                    )
                  );
                }
              });
            },
            addEventListener(action, listener) {
              if (!eventActions.has(action) || typeof listener !== "function") {
                throw new TypeError("Invalid native bridge event listener");
              }
              let actionListeners = listeners.get(action);
              if (!actionListeners) {
                actionListeners = new Set();
                listeners.set(action, actionListeners);
              }
              actionListeners.add(listener);
              let isRemoved = false;
              return () => {
                if (isRemoved) {
                  return;
                }
                isRemoved = true;
                actionListeners.delete(listener);
                if (actionListeners.size === 0) {
                  listeners.delete(action);
                }
              };
            }
          });

          Object.defineProperty(window, "mcNativeBridge", {
            value: bridge,
            writable: false,
            configurable: false,
            enumerable: true
          });
        })();
        """
    }

    static func userScript(trustedOrigin: TrustedOrigin) -> WKUserScript {
        WKUserScript(
            source: source(trustedOrigin: trustedOrigin),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
    }
}
