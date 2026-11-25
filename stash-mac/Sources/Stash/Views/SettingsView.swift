import ServiceManagement
import SwiftUI

struct SettingsView: View {
  let store: Store
  let relay: Relay
  let model: PopoverModel
  let onBack: () -> Void

  // A stored `State` value instead of `@State`: in this SDK `@State` is a macro whose plugin
  // ships only with Xcode, and the app builds with the Command Line Tools.
  private let loginState = State(initialValue: SMAppService.mainApp.status)

  private var loginStatus: SMAppService.Status {
    get { loginState.wrappedValue }
    nonmutating set { loginState.wrappedValue = newValue }
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 4) {
        IconButton(symbol: "chevron.left", label: "Back", action: onBack)
        Text("Settings").font(.headline)
        Spacer()
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 8)
      Divider()
      Form {
        Section {
          let connected = relay.status == .connected
          Label {
            Text(connected ? "Connected to relay" : "Connecting to relay…")
          } icon: {
            Image(systemName: "circle.fill")
              .font(.system(size: 8))
              .foregroundStyle(connected ? .green : .orange)
          }
          LabeledContent("Relay", value: relay.host)
        }
        Section {
          Toggle("Launch at login", isOn: launchAtLogin)
          if loginStatus == .requiresApproval {
            Text("Approve stash in System Settings › General › Login Items.")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          if let loginError = model.loginError {
            Text(loginError)
              .font(.caption)
              .foregroundStyle(.red)
          }
        }
      }
      .formStyle(.grouped)
    }
    .task {
      // The stored status can be minutes old while idle. Poll so it isn't stale.
      relay.pollNow()
      // Relay status is observed live. Login item status isn't observable, so it is
      // re-read while the view is visible, e.g. after approving it in System Settings.
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(3))
        loginStatus = SMAppService.mainApp.status
      }
    }
  }

  private var launchAtLogin: Binding<Bool> {
    Binding {
      loginStatus == .enabled
    } set: { enabled in
      do {
        if enabled {
          try SMAppService.mainApp.register()
        } else {
          try SMAppService.mainApp.unregister()
        }
        store.setLaunchAtLogin(enabled)
        model.loginError = nil
      } catch {
        model.loginError = error.localizedDescription
      }
      loginStatus = SMAppService.mainApp.status
    }
  }
}
