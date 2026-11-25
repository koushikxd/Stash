import AppKit
import ImageIO
import os

private let log = Logger(subsystem: "dev.koushik.stash", category: "thumbnails")

final class Thumbnails {
  static let shared = Thumbnails()

  private let cache = NSCache<NSString, NSImage>()

  private init() {
    cache.countLimit = 100
  }

  func cachedImage(for url: String) -> NSImage? {
    cache.object(forKey: url as NSString)
  }

  /// Fetches the image and keeps only a downsampled copy. Only http(s) URLs.
  func image(for url: String) async -> NSImage? {
    if let cached = cachedImage(for: url) { return cached }
    guard let remote = httpURL(url) else { return nil }
    var request = URLRequest(url: remote)
    request.timeoutInterval = 10

    let image: NSImage?
    do {
      let (data, response) = try await URLSession.stash.data(for: request)
      guard let status = (response as? HTTPURLResponse)?.statusCode, (200...299).contains(status) else { return nil }
      image = thumbnail(from: data)
    } catch {
      log.debug("Thumbnail fetch failed: \(error)")
      return nil
    }
    guard let image else { return nil }
    cache.setObject(image, forKey: url as NSString)
    return image
  }
}

/// Shown 48 pt square, cropped to fill, at 2x: the shorter side needs about 96 px.
private func thumbnail(from data: Data) -> NSImage? {
  let shortSide = 96
  guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
        let width = properties[kCGImagePropertyPixelWidth] as? Int,
        let height = properties[kCGImagePropertyPixelHeight] as? Int,
        width > 0, height > 0
  else { return nil }

  // Max pixel size bounds the longer side. Cap it so a very wide banner can't decode huge.
  let maxPixelSize = min(shortSide * max(width, height) / min(width, height), 4 * shortSide)
  let options = [
    kCGImageSourceCreateThumbnailFromImageAlways: true,
    kCGImageSourceCreateThumbnailWithTransform: true,
    kCGImageSourceShouldCache: false,
    kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
  ] as CFDictionary
  guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
  return NSImage(cgImage: image, size: NSSize(width: image.width / 2, height: image.height / 2))
}
