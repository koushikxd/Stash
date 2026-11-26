import Foundation

/// `~/Library/Application Support/dev.koushik.stash/`.
let appDataDirectory = URL.applicationSupportDirectory.appending(path: "dev.koushik.stash", directoryHint: .isDirectory)

extension URLSession {
  /// The app's only session. `URLSession.shared` keeps an in-memory cache we don't want to pay for.
  static let stash: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil
    return URLSession(configuration: configuration)
  }()
}

/// The shared secret and the Upstash REST credentials. Never log any of these values.
struct Config {
  /// `nil` when unset. The relay must never run without the real secret: every entry
  /// would fail to decrypt and the cursor would walk past the whole backlog.
  let sharedSecret: String?
  let relayURL: String
  let relayToken: String

  var isRelayConfigured: Bool { !relayURL.isEmpty && !relayToken.isEmpty }
  var relayHost: String { URL(string: relayURL)?.host() ?? "unconfigured" }

  /// Each value comes from, in order: the environment, `stash.secret.json` in the app's
  /// Resources, then `stash.secret.json` in the working directory (for `swift run`).
  static func load() -> Config {
    let environment = ProcessInfo.processInfo.environment
    let files = [Bundle.main.resourceURL, URL.currentDirectory()]
      .compactMap { $0 }
      .map { secretFile(at: $0.appending(path: "stash.secret.json")) }

    func value(env: String, file: String) -> String {
      let candidates = [environment[env]] + files.map { $0[file] as? String }
      return candidates.lazy
        .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
        .first { !$0.isEmpty } ?? ""
    }

    let secret = value(env: "STASH_SHARED_SECRET", file: "sharedSecret")
    var url = value(env: "UPSTASH_REDIS_REST_URL", file: "upstashRedisRestUrl")
    while url.hasSuffix("/") { url.removeLast() }
    return Config(
      sharedSecret: secret.isEmpty ? nil : secret,
      relayURL: url,
      relayToken: value(env: "UPSTASH_REDIS_REST_TOKEN", file: "upstashRedisRestToken")
    )
  }

  private static func secretFile(at url: URL) -> [String: Any] {
    guard let data = try? Data(contentsOf: url),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return [:] }
    return object
  }
}
