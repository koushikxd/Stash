// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "Stash",
  platforms: [.macOS(.v15)],
  targets: [
    .executableTarget(
      name: "Stash",
      swiftSettings: [
        .defaultIsolation(MainActor.self),
        .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
        .enableUpcomingFeature("InferIsolatedConformances"),
      ]
    )
  ]
)
