import AppKit
import Observation
import SwiftUI

/// Popover state that lives in memory and survives close and open.
@Observable
final class PopoverModel {
  enum Screen { case list, settings }

  /// The input rows exclude each other.
  enum ListMode: Equatable {
    case browsing
    case adding(prefill: String)
    case editing(id: String, text: String)
  }

  /// The last removal, which the undo bar can put back.
  struct Removal: Equatable {
    let message: String
    let tab: Tab
    let items: [StashItem]
  }

  var screen = Screen.list
  var tab = Tab.inbox
  var mode = ListMode.browsing
  var removal: Removal?
  /// The last launch-at-login failure, from startup or the toggle, shown in settings.
  var loginError: String?

  /// The tab survives; everything transient resets.
  func prepareForOpen() {
    screen = .list
    mode = .browsing
    removal = nil
  }
}

struct PopoverView: View {
  let store: Store
  let relay: Relay
  @Bindable var model: PopoverModel

  var body: some View {
    Group {
      switch model.screen {
      case .list: list
      case .settings: SettingsView(store: store, relay: relay, model: model) { model.screen = .list }
      }
    }
    .frame(width: 360, height: 480)
  }

  private var list: some View {
    let items = store.items(in: model.tab)
    return VStack(spacing: 0) {
      toolbar(items)
      Divider()
      // Outside the scroll view: a lazy row scrolled out of view never mounts, so it
      // couldn't take focus.
      if case .adding(let prefill) = model.mode {
        InputRow(text: prefill, placeholder: "Paste or type a link") { value in
          store.add(value, to: model.tab)
          model.mode = .browsing
        } onCancel: {
          cancel(.adding(prefill: prefill))
        }
        // A new prefill needs a new row: `State` keeps the first initial value.
        .id(prefill)
        Divider()
      }
      content(items)
    }
    .overlay(alignment: .bottom) {
      if let removal = model.removal {
        UndoBar(message: removal.message) { undo(removal) }
          .transition(.move(edge: .bottom).combined(with: .opacity))
          .task(id: removal) {
            try? await Task.sleep(for: .seconds(5))
            if model.removal == removal { model.removal = nil }
          }
      }
    }
    .animation(.snappy(duration: 0.25), value: model.removal)
    .onChange(of: model.tab) { model.mode = .browsing }
  }

  private func toolbar(_ items: [StashItem]) -> some View {
    HStack(spacing: 2) {
      Picker("Tab", selection: $model.tab) {
        Text(tabLabel("Inbox", count: store.count(.inbox))).tag(Tab.inbox)
        Text(tabLabel("Reading", count: store.count(.reading))).tag(Tab.reading)
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .fixedSize()
      Spacer()
      IconButton(symbol: "plus", label: "Add from clipboard", action: addFromClipboard)
      IconButton(symbol: "trash", label: model.tab == .inbox ? "Clear inbox" : "Clear reading list") {
        clear(items)
      }
      .disabled(items.isEmpty)
      IconButton(symbol: "gearshape", label: "Settings") { model.screen = .settings }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
  }

  private func tabLabel(_ name: String, count: Int) -> String {
    count == 0 ? name : "\(name)  \(count)"
  }

  @ViewBuilder
  private func content(_ items: [StashItem]) -> some View {
    let isAdding = if case .adding = model.mode { true } else { false }
    if items.isEmpty, !isAdding {
      EmptyState(tab: model.tab)
    } else {
      let tab = model.tab
      ScrollView {
        LazyVStack(spacing: 2) {
          ForEach(items) { item in
            if case .editing(item.id, let text) = model.mode {
              InputRow(text: text, placeholder: "Link or note") { value in
                store.updateReading(id: item.id, input: value)
                model.mode = .browsing
              } onCancel: {
                cancel(.editing(id: item.id, text: text))
              }
            } else {
              ItemRow(item: item, tab: tab) {
                model.mode = .editing(id: item.id, text: item.url ?? item.text)
              } onRemove: { message in
                remove([item], from: tab, message: message)
              }
            }
          }
        }
        .padding(6)
      }
    }
  }

  // MARK: Actions

  /// A row losing focus because another row opened must not close the new one.
  private func cancel(_ mode: PopoverModel.ListMode) {
    if model.mode == mode { model.mode = .browsing }
  }

  /// A url on the clipboard is added straight away. Anything else opens a prefilled input.
  private func addFromClipboard() {
    let clipboard = NSPasteboard.general.string(forType: .string) ?? ""
    if toURL(clipboard) != nil {
      withAnimation(.snappy) { store.add(clipboard, to: model.tab) }
      model.mode = .browsing
    } else {
      model.mode = .adding(prefill: clipboard.trimmingCharacters(in: .whitespacesAndNewlines))
    }
  }

  private func remove(_ items: [StashItem], from tab: Tab, message: String) {
    withAnimation(.snappy) {
      for item in items { store.remove(item.id, from: tab) }
    }
    model.removal = PopoverModel.Removal(message: message, tab: tab, items: items)
  }

  /// No confirmation step: the undo bar makes clearing reversible.
  private func clear(_ items: [StashItem]) {
    let tab = model.tab
    withAnimation(.snappy) { store.clear(tab) }
    let noun = tab == .inbox ? "link" : "item"
    model.removal = PopoverModel.Removal(
      message: "Cleared \(items.count) \(noun)\(items.count == 1 ? "" : "s")", tab: tab, items: items
    )
  }

  private func undo(_ removal: PopoverModel.Removal) {
    withAnimation(.snappy) { store.restore(removal.items, to: removal.tab) }
    model.removal = nil
  }
}

struct IconButton: View {
  let symbol: String
  let label: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .frame(width: 24, height: 24)
        .contentShape(Rectangle())
    }
    .buttonStyle(.borderless)
    .help(label)
    .accessibilityLabel(label)
  }
}

private struct UndoBar: View {
  let message: String
  let onUndo: () -> Void

  var body: some View {
    HStack {
      Text(message).lineLimit(1)
      Spacer()
      Button("Undo", action: onUndo)
        .buttonStyle(.borderless)
        .fontWeight(.semibold)
        // Borderless buttons dim when the app isn't active, which it often isn't here.
        .foregroundStyle(Color.accentColor)
    }
    .font(.system(size: 12))
    .padding(.horizontal, 12)
    .padding(.vertical, 9)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.separator))
    .shadow(color: .black.opacity(0.2), radius: 8, y: 2)
    .padding(10)
  }
}

private struct EmptyState: View {
  let tab: Tab

  var body: some View {
    VStack(spacing: 6) {
      Image(systemName: tab == .inbox ? "tray" : "book")
        .font(.system(size: 28, weight: .light))
        .foregroundStyle(.tertiary)
        .padding(.bottom, 4)
      Text(tab == .inbox ? "Inbox zero" : "Nothing to read")
        .font(.headline)
      Text(tab == .inbox ? "Links you share from your phone land here." : "Copy a link, then press +.")
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
