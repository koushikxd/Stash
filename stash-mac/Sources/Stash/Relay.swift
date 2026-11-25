import CoreGraphics
import Foundation
import Observation
import OSLog

private let log = Logger(subsystem: "dev.koushik.stash", category: "relay")

/// Polls the phone's Upstash Redis Stream, decrypts each entry, and stores it in the inbox.
///
/// Entries wait on the stream, so anything sent while the Mac sleeps arrives on the next
/// poll. The persisted cursor (a stream id, never a wall clock) makes delivery exactly-once.
/// Never log the secret, the token, the stream name, or a payload.
@Observable
final class Relay {
  enum Status {
    case connecting
    /// The last request was answered, even with an empty page.
    case connected
  }

  private static let pageSize = 100
  private static let activeInterval = Duration.seconds(30)
  private static let idleInterval = Duration.seconds(5 * 60)
  private static let idleAfterSeconds: Double = 300
  private static let retentionMs: Int64 = 30 * 24 * 60 * 60 * 1000
  private static let cursorURL = appDataDirectory.appending(path: "stash-relay.json")

  private(set) var status = Status.connecting

  @ObservationIgnored private let config: Config
  @ObservationIgnored private let store: Store
  @ObservationIgnored private var crypto: RelayCrypto?
  @ObservationIgnored private var cursor: String?
  @ObservationIgnored private var loop: Task<Void, Never>?
  @ObservationIgnored private var isPolling = false

  var host: String { config.relayHost }

  init(config: Config, store: Store) {
    self.config = config
    self.store = store
  }

  func start() {
    guard loop == nil else { return }
    // With the wrong secret every entry fails to decrypt and the cursor would walk past the
    // whole retained backlog. Not reading leaves it recoverable once the secret is set.
    guard let secret = config.sharedSecret else {
      log.error("No shared secret configured; the relay will not start")
      return
    }
    crypto = RelayCrypto(secret: secret)
    cursor = Self.loadCursor()
    log.notice("Relay starting, host \(self.config.relayHost, privacy: .public), credentials configured: \(self.config.isRelayConfigured, privacy: .public)")
    runLoop()
  }

  func stop() {
    loop?.cancel()
    loop = nil
    status = .connecting
  }

  /// Cancels the pending sleep and polls now, unless a pass is already running.
  func pollNow() {
    guard loop != nil, !isPolling else { return }
    runLoop()
  }

  // MARK: Loop

  /// Only ever replaces a loop that is sleeping (see `pollNow`), so passes never overlap.
  private func runLoop() {
    loop?.cancel()
    loop = Task {
      while !Task.isCancelled {
        await pollPass()
        do { try await Task.sleep(for: nextInterval()) } catch { return }
      }
    }
  }

  /// Drains the stream: full pages are read back to back so a backlog clears at once.
  private func pollPass() async {
    guard let crypto else { return }
    isPolling = true
    defer { isPolling = false }
    while true {
      guard let entries = await readPage(crypto.stream) else {
        if status == .connected { log.notice("Relay unreachable") }
        status = .connecting
        return
      }
      if status == .connecting { log.notice("Relay answered") }
      status = .connected
      log.debug("Read \(entries.count, privacy: .public) entries")
      for entry in entries {
        guard process(entry.body, crypto: crypto) else { return }
        cursor = entry.id
        saveCursor()
      }
      if entries.count < Self.pageSize || Task.isCancelled { return }
    }
  }

  /// Back off when nobody is at the Mac. Wake and unlock force a poll anyway.
  private func nextInterval() -> Duration {
    // ~0 is kCGAnyInputEventType.
    let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
    return idle >= Self.idleAfterSeconds ? Self.idleInterval : Self.activeInterval
  }

  // MARK: Entries

  private struct Payload: Decodable {
    let v: Int
    let t: String
    let text: String
    let url: String?
    let createdAt: Double?

    private enum CodingKeys: String, CodingKey { case v, t, text, url, createdAt }

    init(from decoder: any Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      v = try container.decode(Int.self, forKey: .v)
      t = try container.decode(String.self, forKey: .t)
      text = try container.decode(String.self, forKey: .text)
      url = (try? container.decodeIfPresent(String.self, forKey: .url)) ?? nil
      createdAt = (try? container.decodeIfPresent(Double.self, forKey: .createdAt)) ?? nil
    }
  }

  /// Returns false only if the entry could not be stored, which holds the cursor back.
  /// Undecryptable or malformed entries are dropped so they can't wedge the stream.
  private func process(_ body: String, crypto: RelayCrypto) -> Bool {
    guard let plain = crypto.decrypt(body),
          let payload = try? JSONDecoder().decode(Payload.self, from: Data(plain.utf8)),
          payload.v == 1, payload.t == "link"
    else {
      log.notice("Dropped an undecryptable or malformed entry")
      return true
    }
    // The phone's `id` is ignored: the cursor tracks delivery and the store dedupes.
    let item: StashItem
    do {
      item = try store.addLink(
        url: payload.url,
        text: payload.text,
        receivedAt: payload.createdAt ?? (Date.now.timeIntervalSince1970 * 1000).rounded()
      )
    } catch {
      log.error("Storing an entry failed; it will be retried: \(error)")
      return false
    }
    store.enrich(item, in: .inbox)
    return true
  }

  // MARK: Upstash REST

  private struct Entry {
    let id: String
    let body: String
  }

  /// Up to `pageSize` entries after the cursor, in stream order. nil means unreachable,
  /// which callers must tell apart from an empty page.
  private func readPage(_ stream: String) async -> [Entry]? {
    let start = cursor.map { "(" + $0 } ?? "-"
    guard let result = await command(["XRANGE", stream, start, "+", "COUNT", String(Self.pageSize)]) as? [Any] else {
      return nil
    }
    let entries = result.compactMap { raw -> Entry? in
      guard let pair = raw as? [Any], let id = pair.first as? String, !id.isEmpty else { return nil }
      // Fields arrive flat: [name, value, ...]. A missing body still yields the id, so the
      // cursor can move past the entry.
      let fields = pair.count > 1 ? pair[1] as? [Any] ?? [] : []
      var body = ""
      for index in stride(from: 0, to: fields.count - 1, by: 2) where fields[index] as? String == "body" {
        if let value = fields[index + 1] as? String {
          body = value
          break
        }
      }
      return Entry(id: id, body: body)
    }
    if !entries.isEmpty {
      // Best-effort retention. Its failure never matters.
      let minID = Int64(Date.now.timeIntervalSince1970 * 1000) - Self.retentionMs
      Task { _ = await command(["XTRIM", stream, "MINID", "~", "\(minID)-0"]) }
    }
    return entries
  }

  /// One Redis command. Returns its `result`, or nil if the relay is unreachable for any
  /// reason: non-2xx, an `error` key, a timeout, or a malformed body.
  private func command(_ arguments: [String]) async -> Any? {
    guard config.isRelayConfigured, let url = URL(string: config.relayURL) else { return nil }
    var request = URLRequest(url: url, timeoutInterval: 20)
    request.httpMethod = "POST"
    request.setValue("Bearer \(config.relayToken)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    do {
      request.httpBody = try JSONSerialization.data(withJSONObject: arguments)
      let (data, response) = try await URLSession.stash.data(for: request)
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            object["error"] == nil,
            let result = object["result"], !(result is NSNull)
      else { return nil }
      return result
    } catch {
      return nil
    }
  }

  // MARK: Cursor

  private static func loadCursor() -> String? {
    guard let data = try? Data(contentsOf: cursorURL),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return object["cursor"] as? String
  }

  /// Best effort. A lost cursor replays the retained window, and the store dedupes it.
  private func saveCursor() {
    do {
      try FileManager.default.createDirectory(at: appDataDirectory, withIntermediateDirectories: true)
      let object: [String: Any] = ["cursor": cursor ?? NSNull()]
      try JSONSerialization.data(withJSONObject: object).write(to: Self.cursorURL, options: .atomic)
    } catch {
      log.error("Saving the cursor failed: \(error)")
    }
  }
}
