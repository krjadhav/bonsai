import SwiftUI

struct ContentView: View {
    private let version =
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(alignment: .center, spacing: 16) {
                    Image(systemName: "leaf.fill")
                        .font(.system(size: 40))
                        .foregroundStyle(.tint)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Bonsai")
                            .font(.largeTitle.bold())
                        Text("Teach your X feed what you want to see.")
                            .foregroundStyle(.secondary)
                    }
                }

                Text("Bonsai runs inside Safari. Turn it on once and it works on x.com.")

                StepList(steps: [
                    "Open x.com in Safari.",
                    "Tap the page menu button in the address bar, then Manage Extensions.",
                    "Turn on Bonsai and tap Done.",
                    "Tap the page menu again, tap Bonsai, and choose Always Allow on This Website. Bonsai also asks once for its sign-in page; allow that too.",
                    "Sign in with Google from the Bonsai welcome tab, then start answering Yes or No on posts.",
                ])

                Text("You can also manage extensions in Settings > Apps > Safari > Extensions.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                Link(destination: URL(string: "https://x.com/home")!) {
                    Label("Open x.com", systemImage: "safari")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
            .padding(24)
            .frame(maxWidth: 560, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        // The repo rule: show the version at the top right of every screen.
        .overlay(alignment: .topTrailing) {
            Text("v\(version)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .accessibilityLabel("Version \(version)")
        }
    }
}

private struct StepList: View {
    let steps: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text("\(index + 1)")
                        .font(.headline.monospacedDigit())
                        .frame(width: 28, height: 28)
                        .background(Circle().fill(.tint.opacity(0.15)))
                        .accessibilityHidden(true)
                    Text(step)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Step \(index + 1): \(step)")
            }
        }
    }
}

#Preview {
    ContentView()
}
