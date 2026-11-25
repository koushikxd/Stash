import Foundation

/// The URL if it parses and is http(s). Anything else handed to `NSWorkspace.open` could
/// launch another app, and inbox URLs arrive from the phone unvalidated.
func httpURL(_ string: String) -> URL? {
  guard let url = URL(string: string),
        let scheme = url.scheme?.lowercased(),
        scheme == "http" || scheme == "https"
  else { return nil }
  return url
}

/// Typed or pasted input as a link. Anything with whitespace or no dotted host is text.
func toURL(_ raw: String) -> String? {
  let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty, !trimmed.contains(where: \.isWhitespace) else { return nil }
  let candidate = trimmed.prefixMatch(of: /https?:\/\//.ignoresCase()) == nil ? "https://" + trimmed : trimmed
  guard let url = httpURL(candidate), url.host()?.contains(".") == true else { return nil }
  return url.absoluteString
}

func lowercasedHost(of url: String) -> String {
  URL(string: url)?.host()?.lowercased() ?? ""
}

/// Dedupe key for links: lowercase scheme and host, no fragment, and `/` equals an empty path.
func canonicalURL(_ url: String) -> String {
  guard var components = URLComponents(string: url) else { return url }
  components.scheme = components.scheme?.lowercased()
  components.percentEncodedHost = components.percentEncodedHost?.lowercased()
  components.fragment = nil
  if components.path == "/" { components.path = "" }
  return components.string ?? url
}

/// Dedupe key for text: trimmed, with runs of whitespace collapsed to one space.
func canonicalText(_ text: String) -> String {
  text.trimmingCharacters(in: .whitespacesAndNewlines).replacing(/\s+/, with: " ")
}
