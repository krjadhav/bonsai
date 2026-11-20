import SafariServices
import os.log

// Native side of the Safari Web Extension. Bonsai's JavaScript does not use
// native messaging today (no "nativeMessaging" permission), so this handler
// only answers with an echo. Safari requires the principal class to exist.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private let log = Logger(subsystem: "Bonsai", category: "SafariWebExtensionHandler")

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey]
        log.debug("Received native message: \(String(describing: message), privacy: .private)")

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["echo": message ?? NSNull()]]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
