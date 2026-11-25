import AppKit
import SwiftUI

/// One card. Clicking it copies the item: in the inbox that consumes it, in the reading list it doesn't.
/// Actions show on hover and in the context menu.
struct ItemRow: View {
  let item: StashItem
  let tab: Tab
  let onEdit: () -> Void
  /// Removes the item; the message is shown next to the undo button.
  let onRemove: (_ message: String) -> Void

  private enum Art {
    case thumbnail(NSImage)
    case favicon(NSImage)
  }

  // Stored `State` values instead of `@State`: in this SDK `@State` is a macro whose plugin
  // ships only with Xcode, and the app builds with the Command Line Tools.
  private let loadedArt = State<Art?>(initialValue: nil)
  private let copied = State(initialValue: false)
  private let hovering = State(initialValue: false)

  private var isCopied: Bool { copied.wrappedValue }
  private var isHovering: Bool { hovering.wrappedValue }

  var body: some View {
    HStack(spacing: 10) {
      square
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.system(size: 13, weight: .medium))
          .lineLimit(1)
        if let summary {
          Text(summary)
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
        TimelineView(.periodic(from: .now, by: 30)) { context in
          Text(meta(now: context.date))
            .font(.system(size: 11))
            .foregroundStyle(.tertiary)
            .lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(8)
    .background(
      RoundedRectangle(cornerRadius: 10)
        .fill(isCopied ? Color.green.opacity(0.12) : isHovering ? Color.primary.opacity(0.06) : .clear)
    )
    .overlay(alignment: .trailing) {
      // Inserted rather than faded in: SwiftUI doesn't hit-test fully transparent views.
      if isHovering, !isCopied {
        actions.padding(.trailing, 8)
      }
    }
    .contentShape(Rectangle())
    .onHover { hovering.wrappedValue = $0 }
    .onTapGesture(perform: copy)
    .contextMenu { menu }
    .help(tab == .inbox ? "Click to copy and remove" : "Click to copy")
    .task(id: ArtKey(image: item.image, hostname: item.hostname)) { await loadArt() }
  }

  // MARK: Square

  private var square: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 8).fill(.quaternary)
      if isCopied {
        Image(systemName: "checkmark")
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(.green)
      } else {
        switch loadedArt.wrappedValue ?? cachedArt {
        case .thumbnail(let image):
          Image(nsImage: image)
            .resizable()
            .scaledToFill()
            .frame(width: 48, height: 48)
            .clipped()
        case .favicon(let image):
          Image(nsImage: image)
            .resizable()
            .frame(width: 24, height: 24)
            .clipShape(RoundedRectangle(cornerRadius: 6))
        case nil:
          if item.url == nil {
            Image(systemName: "text.alignleft").foregroundStyle(.secondary)
          }
        }
      }
    }
    .frame(width: 48, height: 48)
    .clipShape(RoundedRectangle(cornerRadius: 8))
  }

  private struct ArtKey: Hashable {
    let image: String?
    let hostname: String
  }

  /// What the caches already hold, so a row scrolled back into view doesn't flicker.
  private var cachedArt: Art? {
    if let image = item.image, let thumbnail = Thumbnails.shared.cachedImage(for: image) {
      return .thumbnail(thumbnail)
    }
    if item.url != nil, let favicon = Favicons.shared.cachedImage(forHost: item.hostname) {
      return .favicon(favicon)
    }
    return nil
  }

  /// og:image first, then the favicon if there is no image or it fails to load.
  private func loadArt() async {
    loadedArt.wrappedValue = nil
    if let image = item.image, let thumbnail = await Thumbnails.shared.image(for: image) {
      if !Task.isCancelled { loadedArt.wrappedValue = .thumbnail(thumbnail) }
      return
    }
    guard item.url != nil, !Task.isCancelled,
          let favicon = await Favicons.shared.image(forHost: item.hostname), !Task.isCancelled
    else { return }
    loadedArt.wrappedValue = .favicon(favicon)
  }

  // MARK: Text

  private var isXPost: Bool {
    ["x.com", "twitter.com"].contains(item.hostname.replacing(/^(www|mobile)\./, with: ""))
  }

  private var title: String {
    if let title = item.title, !title.isEmpty {
      // "Name (@handle) on X": the meta line already says X.
      return isXPost ? decodeEntities(title).replacing(/\ on (X|Twitter)$/, with: "") : decodeEntities(title)
    }
    guard let url = item.url else { return item.text }
    return item.hostname.isEmpty ? url : item.hostname
  }

  private var summary: String? {
    let raw = if let description = item.description, !description.isEmpty {
      description
    } else if item.url != nil, !item.text.isEmpty {
      item.text
    } else {
      String?.none
    }
    // t.co links are X's opaque wrappers around media and links; they say nothing.
    guard let summary = raw.map({ decodeEntities($0.replacing(/https?:\/\/t\.co\/\w+/, with: "")) }),
          !summary.isEmpty
    else { return nil }
    return summary
  }

  private func meta(now: Date) -> String {
    // "X (formerly Twitter)" reads as "X".
    let siteName = item.siteName?.replacing(/\s*\([^)]*\)$/, with: "") ?? ""
    let source = [siteName, item.hostname, item.url == nil ? "Text" : ""].first { !$0.isEmpty }
    let time = relativeTime(item.receivedAt, now: now)
    return source.map { "\($0) · \(time)" } ?? time
  }

  // MARK: Actions

  private var openTarget: URL? { item.url.flatMap(httpURL) }

  private var actions: some View {
    HStack(spacing: 0) {
      if let target = openTarget {
        IconButton(symbol: "arrow.up.right", label: "Open in browser") { NSWorkspace.shared.open(target) }
      }
      if tab == .reading {
        IconButton(symbol: "pencil", label: "Edit", action: onEdit)
      }
      IconButton(symbol: "trash", label: "Delete") { onRemove("Deleted") }
    }
    .padding(2)
    .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
    .shadow(color: .black.opacity(0.15), radius: 3, y: 1)
  }

  @ViewBuilder
  private var menu: some View {
    Button(tab == .inbox ? "Copy and Remove" : "Copy", action: copy)
    if let target = openTarget {
      Button("Open in Browser") { NSWorkspace.shared.open(target) }
    }
    if tab == .reading {
      Button("Edit", action: onEdit)
    }
    Divider()
    Button("Delete", role: .destructive) { onRemove("Deleted") }
  }

  private func copy() {
    guard !isCopied else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(item.url ?? item.text, forType: .string)
    copied.wrappedValue = true
    // Unstructured on purpose: the removal must happen even if the row goes away first.
    switch tab {
    case .inbox:
      Task {
        try? await Task.sleep(for: .milliseconds(220))
        onRemove("Copied")
      }
    case .reading:
      Task {
        try? await Task.sleep(for: .milliseconds(700))
        copied.wrappedValue = false
      }
    }
  }
}

/// `Ns ago`, `Nm ago`, `Nh ago`, `Nd ago`, as the Electron popover wrote it.
func relativeTime(_ receivedAt: Double, now: Date) -> String {
  let seconds = Int(max(0, now.timeIntervalSince1970 * 1000 - receivedAt) / 1000)
  if seconds < 60 { return "\(seconds)s ago" }
  let minutes = seconds / 60
  if minutes < 60 { return "\(minutes)m ago" }
  let hours = minutes / 60
  if hours < 24 { return "\(hours)h ago" }
  return "\(hours / 24)d ago"
}
