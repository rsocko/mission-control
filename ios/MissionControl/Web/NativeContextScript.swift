import Foundation
import WebKit

enum NativeContextScript {
    static func source(trustedOrigin: TrustedOrigin) -> String {
        let encodedOrigin = javascriptStringLiteral(trustedOrigin.serialized)
        return """
        (() => {
          "use strict";
          const trustedOrigin = \(encodedOrigin);
          if (window.top !== window || window.location.origin !== trustedOrigin) {
            return;
          }
          const context = Object.freeze({
            platform: "ios",
            contractVersion: 1
          });
          Object.defineProperty(window, "MCNativeContext", {
            value: context,
            writable: false,
            configurable: false,
            enumerable: true
          });
          Object.defineProperty(window, "isMCNativeApp", {
            value: true,
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

    static func javascriptStringLiteral(_ value: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [value])
        let encoded = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        return String(encoded.dropFirst().dropLast())
    }
}
