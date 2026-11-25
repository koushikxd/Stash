import Foundation
import os

private let log = Logger(subsystem: "dev.koushik.stash", category: "metadata")

struct PageMetadata: Equatable {
  var title: String?
  var description: String?
  var image: String?
  var siteName: String?
}

/// Also used for display, because items saved by the Electron app can hold numeric entities.
func decodeEntities(_ input: some StringProtocol) -> String {
  String(input)
    .replacing(/&#(x?)([0-9a-fA-F]+);/) { match -> String in
      let (whole, hex, digits) = match.output
      guard let code = UInt32(digits, radix: hex.isEmpty ? 10 : 16), let scalar = Unicode.Scalar(code) else {
        return String(whole)
      }
      return String(Character(scalar))
    }
    .replacing("&lt;", with: "<")
    .replacing("&gt;", with: ">")
    .replacing("&quot;", with: "\"")
    .replacing("&apos;", with: "'")
    .replacing("&nbsp;", with: " ")
    .replacing("&amp;", with: "&")
    .replacing(/\s+/, with: " ")
    .trimmingCharacters(in: .whitespacesAndNewlines)
}

private func attrValue(_ tag: Substring, _ attr: String) -> Substring? {
  // `attr` is always one of our own literal attribute names, so the pattern always compiles.
  let regex = try! Regex(#"\#(attr)=["']([^"']+)["']"#).ignoresCase()
  return tag.firstMatch(of: regex)?.output[1].substring
}

private func metaContent(_ html: String, _ keys: [String]) -> String? {
  for match in html.matches(of: /<meta\s+[^>]*>/.ignoresCase()) {
    let tag = match.output
    guard let property = attrValue(tag, "property") ?? attrValue(tag, "name"),
          keys.contains(property.lowercased())
    else { continue }
    if let content = attrValue(tag, "content") { return decodeEntities(content) }
  }
  return nil
}

private func documentTitle(_ html: String) -> String? {
  guard let title = html.firstMatch(of: /<title[^>]*>([\s\S]*?)<\/title>/.ignoresCase())?.output.1,
        !title.isEmpty
  else { return nil }
  return decodeEntities(title)
}

private func trim(_ value: String?, _ max: Int) -> String? {
  guard let value, !value.isEmpty else { return nil }
  return String(value.prefix(max))
}

private func stripTags(_ input: some StringProtocol) -> String {
  decodeEntities(String(input).replacing(/<[^>]+>/, with: " "))
}

// og:image comes straight off an untrusted page and ends up as an image URL we fetch. Keep it
// to http(s) so a hostile page can't persist a huge data: blob or point at a local file.
private func absoluteURL(_ value: String?, _ base: String) -> String? {
  guard let value, !value.isEmpty,
        let resolved = URL(string: value, relativeTo: URL(string: base))
  else { return nil }
  return httpURL(resolved.absoluteString)?.absoluteString
}

private func xStatusURL(_ url: String) -> URL? {
  guard let parsed = URL(string: url), var host = parsed.host()?.lowercased() else { return nil }
  if host.hasPrefix("www.") { host.removeFirst(4) }
  guard host == "x.com" || host == "twitter.com",
        parsed.path().firstMatch(of: #/^\/[^/]+\/status(?:es)?\/\d+/#) != nil
  else { return nil }
  return parsed
}

private func handleFromXURL(_ url: String) -> String? {
  guard let handle = URL(string: url)?.path().split(separator: "/").first,
        handle.lowercased() != "i"
  else { return nil }
  return String(handle)
}

private func bodyFromXEmbed(_ embed: [String: Any]) -> String? {
  let title = embed["title"] as? String ?? ""
  if let quoted = title.firstMatch(of: /:\s*"([\s\S]+)"\s*\/\s*X\s*$/.ignoresCase())?.output.1 {
    return decodeEntities(quoted)
  }

  let html = embed["html"] as? String ?? ""
  guard !html.isEmpty else { return nil }
  let blockquote = html.firstMatch(of: /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/.ignoresCase())?.output.1 ?? html[...]
  return stripTags(blockquote.replacing(/&mdash;[\s\S]*$/.ignoresCase(), with: "", maxReplacements: 1))
}

/// The TS version returns a partial object that always has title, description and siteName
/// (title and description possibly null) and never image. That is a `PageMetadata` with
/// `image == nil`, and spreading it over page metadata means "take everything except image".
private func fetchXMetadata(_ url: String) async -> PageMetadata? {
  guard let statusURL = xStatusURL(url) else { return nil }

  var components = URLComponents(string: "https://publish.twitter.com/oembed")
  components?.queryItems = [
    URLQueryItem(name: "url", value: statusURL.absoluteString),
    URLQueryItem(name: "omit_script", value: "1"),
  ]
  guard let endpoint = components?.url else { return nil }
  var request = URLRequest(url: endpoint)
  request.timeoutInterval = 2
  request.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X) stash/0.1", forHTTPHeaderField: "User-Agent")

  let embed: [String: Any]
  do {
    let (data, response) = try await URLSession.stash.data(for: request)
    guard let status = (response as? HTTPURLResponse)?.statusCode, (200...299).contains(status) else { return nil }
    embed = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
  } catch {
    log.debug("X oEmbed fetch failed: \(error)")
    return nil
  }

  let author = (embed["author_name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  let authorURL = embed["author_url"] as? String ?? ""
  let handle = handleFromXURL(authorURL) ?? handleFromXURL(url)
  return PageMetadata(
    title: author.isEmpty ? nil : "\(author)\(handle.map { " (@\($0))" } ?? "") on X",
    description: trim(bodyFromXEmbed(embed), 500),
    image: nil,
    siteName: "x.com"
  )
}

private func isWeakXMetadata(_ url: String, _ metadata: PageMetadata) -> Bool {
  guard xStatusURL(url) != nil else { return false }
  let title = metadata.title?.lowercased() ?? ""
  return title.isEmpty || (metadata.description ?? "").isEmpty || title == "x.com" || title == "x"
}

/// Port of metadata.ts `fetchMetadata`, function for function. nil on total failure.
func fetchMetadata(_ url: String) async -> PageMetadata? {
  // Node's fetch rejects non-http(s) URLs; URLSession would happily read file:// ones.
  guard let pageURL = httpURL(url) else { return await fetchXMetadata(url) }
  var request = URLRequest(url: pageURL)
  request.timeoutInterval = 2
  request.setValue("stash/0.1 title fetcher", forHTTPHeaderField: "User-Agent")

  let data: Data
  let response: URLResponse
  do {
    (data, response) = try await URLSession.stash.data(for: request)
  } catch {
    log.debug("Page fetch failed: \(error)")
    return await fetchXMetadata(url)
  }
  guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
    return await fetchXMetadata(url)
  }
  let type = http.value(forHTTPHeaderField: "Content-Type") ?? ""
  if !type.isEmpty && !type.contains("text/html") { return await fetchXMetadata(url) }

  let html = String(decoding: data, as: UTF8.self)
  let metadata = PageMetadata(
    title: trim(metaContent(html, ["og:title", "twitter:title"]) ?? documentTitle(html), 300),
    description: trim(metaContent(html, ["og:description", "twitter:description", "description"]), 500),
    image: absoluteURL(metaContent(html, ["og:image", "twitter:image"]), url),
    siteName: trim(metaContent(html, ["og:site_name"]), 120)
  )
  guard isWeakXMetadata(url, metadata), var xMetadata = await fetchXMetadata(url) else { return metadata }
  xMetadata.image = metadata.image
  return xMetadata
}
