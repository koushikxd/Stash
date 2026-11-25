import AppKit
import CryptoKit
import os

private let log = Logger(subsystem: "dev.koushik.stash", category: "favicons")

final class Favicons {
  static let shared = Favicons()

  private let cache = NSCache<NSString, NSImage>()
  private let directory = appDataDirectory.appending(path: "favicons", directoryHint: .isDirectory)
  private let maxBytes = 256 * 1024

  private init() {
    cache.countLimit = 200
  }

  /// Synchronous lookup in the NSCache only (for first render).
  func cachedImage(forHost host: String) -> NSImage? {
    cache.object(forKey: host as NSString)
  }

  /// NSCache, then the disk cache, then `/favicon.ico` over https, then http. nil if unavailable.
  func image(forHost host: String) async -> NSImage? {
    guard host.wholeMatch(of: /[a-z0-9.-]+/.ignoresCase()) != nil else { return nil }
    if let cached = cachedImage(forHost: host) { return cached }

    let key = SHA256.hash(data: Data(host.utf8)).map { String(format: "%02x", $0) }.joined().prefix(32)
    let file = directory.appending(path: "\(key).ico")
    if let data = try? Data(contentsOf: file) { return remember(data, for: host) }

    for scheme in ["https", "http"] {
      guard let url = URL(string: "\(scheme)://\(host)/favicon.ico"), let data = await download(url) else { continue }
      do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: file, options: .atomic)
      } catch {
        log.error("Writing a favicon to the disk cache failed: \(error)")
      }
      return remember(data, for: host)
    }
    return nil
  }

  private func download(_ url: URL) async -> Data? {
    var request = URLRequest(url: url)
    request.timeoutInterval = 2
    guard let (data, response) = try? await URLSession.stash.data(for: request),
          let status = (response as? HTTPURLResponse)?.statusCode,
          (200...299).contains(status),
          (1...maxBytes).contains(data.count)
    else { return nil }
    return data
  }

  private func remember(_ data: Data, for host: String) -> NSImage? {
    guard let image = NSImage(data: data) else { return nil }
    cache.setObject(image, forKey: host as NSString)
    return image
  }
}
