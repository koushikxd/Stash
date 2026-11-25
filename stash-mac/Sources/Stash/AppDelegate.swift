import AppKit
import Observation
import OSLog
import ServiceManagement
import SwiftUI

private let log = Logger(subsystem: "dev.koushik.stash", category: "app")

final class AppDelegate: NSObject, NSApplicationDelegate {
  private let store: Store
  private let relay: Relay
  private let model = PopoverModel()
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  private let popover = NSPopover()
  private let idleIcon = statusIcon("iconTemplate", fallbackSymbol: "tray")
  private let unreadIcon = statusIcon("icon-unreadTemplate", fallbackSymbol: "tray.full")

  override init() {
    let store = Store()
    self.store = store
    relay = Relay(config: .load(), store: store)
    super.init()
  }

  static func isAnotherInstanceRunning() -> Bool {
    let current = ProcessInfo.processInfo.processIdentifier
    return NSRunningApplication.runningApplications(withBundleIdentifier: "dev.koushik.stash")
      .contains { $0.processIdentifier != current }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    if let button = statusItem.button {
      button.target = self
      button.action = #selector(statusItemClicked)
      button.sendAction(on: [.leftMouseUp, .rightMouseUp])
    }
    observeInbox()

    popover.behavior = .transient
    popover.contentSize = NSSize(width: 360, height: 480)
    popover.contentViewController = NSHostingController(rootView: PopoverView(store: store, relay: relay, model: model))

    let workspace = NSWorkspace.shared.notificationCenter
    workspace.addObserver(self, selector: #selector(pollNow), name: NSWorkspace.didWakeNotification, object: nil)
    DistributedNotificationCenter.default().addObserver(
      self, selector: #selector(pollNow), name: Notification.Name("com.apple.screenIsUnlocked"), object: nil
    )

    applyLaunchAtLogin()
    relay.start()
  }

  func applicationWillTerminate(_ notification: Notification) {
    relay.stop()
  }

  @objc private func pollNow() {
    relay.pollNow()
  }

  // MARK: Status item

  private static func statusIcon(_ name: String, fallbackSymbol: String) -> NSImage? {
    // `swift run` has no bundle resources, so fall back to a symbol there.
    let image = Bundle.main.image(forResource: name)
      ?? NSImage(systemSymbolName: fallbackSymbol, accessibilityDescription: "stash")
    image?.isTemplate = true
    return image
  }

  /// The icon shows unread while the inbox has items. The reading list never changes it.
  private func observeInbox() {
    let unread = withObservationTracking {
      !store.isEmpty(.inbox)
    } onChange: { [weak self] in
      Task { @MainActor in self?.observeInbox() }
    }
    statusItem.button?.image = unread ? unreadIcon : idleIcon
  }

  @objc private func statusItemClicked(_ sender: NSStatusBarButton) {
    if NSApp.currentEvent?.type == .rightMouseUp {
      let menu = NSMenu()
      menu.addItem(withTitle: "Quit stash", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
      menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
    } else if popover.isShown {
      popover.performClose(nil)
    } else {
      model.prepareForOpen()
      // A menubar-only app must activate, or the input row can't take keyboard focus.
      NSApp.activate()
      popover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
      popover.contentViewController?.view.window?.makeKey()
      relay.pollNow()
    }
  }

  // MARK: Launch at login

  /// Applies the stored setting without fighting a choice made in System Settings
  /// (which shows up as `.requiresApproval`): only an app that was never registered is
  /// registered, and only an enabled one unregistered.
  private func applyLaunchAtLogin() {
    let service = SMAppService.mainApp
    log.notice("Launch at login: stored \(self.store.settings.launchAtLogin, privacy: .public), status \(service.status.rawValue, privacy: .public)")
    do {
      if store.settings.launchAtLogin, [.notRegistered, .notFound].contains(service.status) {
        try service.register()
      } else if !store.settings.launchAtLogin, service.status == .enabled {
        try service.unregister()
      }
    } catch {
      log.error("Applying launch at login failed: \(error)")
      model.loginError = error.localizedDescription
    }
  }
}
