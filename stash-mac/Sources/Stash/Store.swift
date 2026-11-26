import Foundation
import Observation
import OSLog

private let log = Logger(subsystem: "dev.koushik.stash", category: "store")

enum Tab {
  /// Links from the phone. Stored under the JSON key `links`.
  case inbox
  /// The Mac-local reading list. The relay never touches it.
  case reading
}

struct StashItem: Identifiable, Equatable {
  enum Kind: String { case link, text }

  let id: String
  var kind: Kind
  var text: String
  var url: String?
  var title: String?
  var description: String?
  var image: String?
  var siteName: String?
  var hostname: String
  /// Milliseconds since the epoch, as the Electron app stored it.
  var receivedAt: Double

  init(id: String = UUID().uuidString.lowercased(), url: String?, text: String, receivedAt: Double) {
    self.id = id
    kind = url == nil ? .text : .link
    self.text = text
    self.url = url
    hostname = url.map(lowercasedHost(of:)) ?? ""
    self.receivedAt = receivedAt
  }

  var needsMetadata: Bool {
    url != nil && [title, description, image, siteName].contains { $0?.isEmpty ?? true }
  }
}

extension StashItem: Codable {
  private enum CodingKeys: String, CodingKey {
    case id, kind, text, url, title, description, image, siteName, hostname, receivedAt
  }

  /// Lenient, like `normalizeLink` in the Electron store: missing or wrong-typed fields
  /// get defaults, and `kind` is derived from the url rather than trusted.
  init(from decoder: any Decoder) throws {
    let container = try? decoder.container(keyedBy: CodingKeys.self)
    func string(_ key: CodingKeys) -> String? {
      (try? container?.decodeIfPresent(String.self, forKey: key)) ?? nil
    }
    let url = string(.url) ?? ""
    let text = string(.text)
    id = string(.id) ?? UUID().uuidString.lowercased()
    kind = url.isEmpty ? .text : .link
    self.text = text.flatMap { canonicalText($0).isEmpty ? nil : $0 } ?? url
    self.url = url.isEmpty ? nil : url
    title = string(.title)
    description = string(.description)
    image = string(.image)
    siteName = string(.siteName)
    hostname = string(.hostname) ?? lowercasedHost(of: url)
    receivedAt = ((try? container?.decodeIfPresent(Double.self, forKey: .receivedAt)) ?? nil)
      ?? (Date.now.timeIntervalSince1970 * 1000).rounded()
  }

  /// Writes `null` for absent fields so the file keeps the Electron shape.
  func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id, forKey: .id)
    try container.encode(kind.rawValue, forKey: .kind)
    try container.encode(text, forKey: .text)
    try container.encode(url, forKey: .url)
    try container.encode(title, forKey: .title)
    try container.encode(description, forKey: .description)
    try container.encode(image, forKey: .image)
    try container.encode(siteName, forKey: .siteName)
    try container.encode(hostname, forKey: .hostname)
    try container.encode(receivedAt, forKey: .receivedAt)
  }
}

struct Settings: Codable {
  var launchAtLogin = true
  var maxHistory = 1000

  init() {}

  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    if let value = try? container.decodeIfPresent(Bool.self, forKey: .launchAtLogin) { launchAtLogin = value }
    if let value = try? container.decodeIfPresent(Int.self, forKey: .maxHistory) { maxHistory = value }
  }
}

/// The shape of `stash-store.json`.
private struct StoreFile: Codable {
  var links: [StashItem] = []
  var reading: [StashItem] = []
  var settings = Settings()

  init(links: [StashItem], reading: [StashItem], settings: Settings) {
    self.links = links
    self.reading = reading
    self.settings = settings
  }

  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    links = (try? container.decodeIfPresent([StashItem].self, forKey: .links)) ?? []
    reading = (try? container.decodeIfPresent([StashItem].self, forKey: .reading)) ?? []
    settings = (try? container.decodeIfPresent(Settings.self, forKey: .settings)) ?? Settings()
  }

  subscript(tab: Tab) -> [StashItem] {
    get { tab == .inbox ? links : reading }
    set { if tab == .inbox { links = newValue } else { reading = newValue } }
  }
}

enum StoreError: Error {
  /// `stash-store.json` exists but did not parse at launch. It is left untouched for recovery.
  case unreadableFile
}

@Observable
final class Store {
  static let fileURL = appDataDirectory.appending(path: "stash-store.json")

  private var file = StoreFile(links: [], reading: [], settings: Settings())
  /// False when the file on disk failed to parse. Writing would destroy it, so every
  /// mutation throws instead, which also holds the relay cursor back.
  @ObservationIgnored private var isWritable = true

  var settings: Settings { file.settings }

  init() {
    guard FileManager.default.fileExists(atPath: Self.fileURL.path) else { return }
    do {
      file = try JSONDecoder().decode(StoreFile.self, from: Data(contentsOf: Self.fileURL))
    } catch {
      isWritable = false
      log.fault("stash-store.json is unreadable; running read-only and leaving it untouched: \(error)")
    }
  }

  /// Newest first.
  func items(in tab: Tab) -> [StashItem] {
    file[tab].sorted { $0.receivedAt > $1.receivedAt }
  }

  func isEmpty(_ tab: Tab) -> Bool { file[tab].isEmpty }

  func count(_ tab: Tab) -> Int { file[tab].count }

  // MARK: Mutations

  /// Adds a relayed or typed link to the inbox. A duplicate is updated in place and keeps
  /// its earlier `receivedAt`, so a re-share doesn't jump the order. Throws if the store
  /// can't be saved, so the relay can hold its cursor.
  @discardableResult
  func addLink(url: String?, text: String, receivedAt: Double) throws -> StashItem {
    let url = url.flatMap { $0.isEmpty ? nil : $0 }
    let text = canonicalText(text.isEmpty ? url ?? "" : text)
    return try commit { file in
      if let index = Self.duplicateIndex(in: file.links, url: url, text: text) {
        file.links[index].kind = url == nil ? .text : .link
        file.links[index].text = text
        file.links[index].url = url
        file.links[index].hostname = url.map(lowercasedHost(of:)) ?? ""
        file.links[index].receivedAt = min(file.links[index].receivedAt, receivedAt)
        return file.links[index]
      }
      let item = StashItem(url: url, text: text, receivedAt: receivedAt)
      file.links.append(item)
      let excess = file.links.count - file.settings.maxHistory
      if excess > 0 { file.links.removeFirst(min(excess, file.links.count)) }
      return item
    }
  }

  /// Re-adding a reading item moves it to the top. The reading list is never trimmed.
  @discardableResult
  func addReading(url: String?, text: String) throws -> StashItem {
    let text = canonicalText(text.isEmpty ? url ?? "" : text)
    let now = Self.nowMs
    return try commit { file in
      if let index = Self.duplicateIndex(in: file.reading, url: url, text: text) {
        file.reading[index].receivedAt = now
        return file.reading[index]
      }
      let item = StashItem(url: url, text: text, receivedAt: now)
      file.reading.append(item)
      return item
    }
  }

  /// The `+` button and the input row, on either tab. `input` is a url from `toURL` or text.
  func add(_ input: String, to tab: Tab) {
    let url = toURL(input)
    do {
      let item = switch tab {
      case .inbox: try addLink(url: url, text: url ?? input, receivedAt: Self.nowMs)
      case .reading: try addReading(url: url, text: url ?? input)
      }
      enrich(item, in: tab)
    } catch {
      log.error("Adding an item failed: \(error)")
    }
  }

  /// Replaces the target, so metadata from the previous url is cleared.
  func updateReading(id: String, input: String) {
    let url = toURL(input)
    do {
      let item: StashItem? = try commit { file in
        guard let index = file.reading.firstIndex(where: { $0.id == id }) else { return nil }
        let item = StashItem(id: id, url: url, text: canonicalText(url ?? input), receivedAt: file.reading[index].receivedAt)
        file.reading[index] = item
        return item
      }
      if let item { enrich(item, in: .reading) }
    } catch {
      log.error("Updating a reading item failed: \(error)")
    }
  }

  func remove(_ id: String, from tab: Tab) {
    guard file[tab].contains(where: { $0.id == id }) else { return }
    perform("Removing an item") { $0[tab].removeAll { $0.id == id } }
  }

  func clear(_ tab: Tab) {
    guard !file[tab].isEmpty else { return }
    perform("Clearing a list") { $0[tab] = [] }
  }

  /// Undo for a removal. Items that are already back are skipped.
  func restore(_ items: [StashItem], to tab: Tab) {
    let present = Set(file[tab].map(\.id))
    let missing = items.filter { !present.contains($0.id) }
    guard !missing.isEmpty else { return }
    perform("Restoring items") { $0[tab].append(contentsOf: missing) }
  }

  func setLaunchAtLogin(_ enabled: Bool) {
    perform("Saving settings") { $0.settings.launchAtLogin = enabled }
  }

  // MARK: Metadata

  /// Fetches page metadata for an item that is missing some, and applies it only if the
  /// item still exists with the same url when the fetch returns.
  func enrich(_ item: StashItem, in tab: Tab) {
    guard let url = item.url, item.needsMetadata else { return }
    Task {
      guard let metadata = await fetchMetadata(url) else { return }
      applyMetadata(metadata, to: item.id, in: tab, url: url)
    }
  }

  private func applyMetadata(_ metadata: PageMetadata, to id: String, in tab: Tab, url: String) {
    guard let index = file[tab].firstIndex(where: { $0.id == id }), file[tab][index].url == url else { return }
    var item = file[tab][index]
    func apply(_ value: String?, to field: WritableKeyPath<StashItem, String?>) {
      if let value, !value.isEmpty { item[keyPath: field] = value }
    }
    apply(metadata.title, to: \.title)
    apply(metadata.description, to: \.description)
    apply(metadata.image, to: \.image)
    apply(metadata.siteName, to: \.siteName)
    guard item != file[tab][index] else { return }
    perform("Saving metadata") { $0[tab][index] = item }
  }

  // MARK: Persistence

  /// Applies `change` to a copy, saves it atomically, and only then publishes it.
  private func commit<Result>(_ change: (inout StoreFile) -> Result) throws -> Result {
    guard isWritable else { throw StoreError.unreadableFile }
    var next = file
    let result = change(&next)
    try FileManager.default.createDirectory(at: appDataDirectory, withIntermediateDirectories: true)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
    try encoder.encode(next).write(to: Self.fileURL, options: .atomic)
    file = next
    return result
  }

  /// For UI-driven changes, which have nobody to report a failure to but the log.
  private func perform(_ action: String, _ change: (inout StoreFile) -> Void) {
    do { try commit(change) } catch { log.error("\(action) failed: \(error)") }
  }

  private static var nowMs: Double { (Date.now.timeIntervalSince1970 * 1000).rounded() }

  private static func duplicateIndex(in list: [StashItem], url: String?, text: String) -> Int? {
    if let url {
      let key = canonicalURL(url)
      return list.firstIndex { $0.url.map(canonicalURL) == key }
    }
    return list.firstIndex { $0.url == nil && canonicalText($0.text) == text }
  }
}
