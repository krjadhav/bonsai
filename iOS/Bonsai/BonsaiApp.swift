import SwiftUI

// Containing app for the Bonsai Safari Web Extension. The extension itself is
// the shared code in ../extension/, copied into the appex at build time. This
// app only explains how to turn the extension on.
@main
struct BonsaiApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
