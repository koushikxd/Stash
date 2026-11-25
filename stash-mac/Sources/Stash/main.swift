import AppKit

if AppDelegate.isAnotherInstanceRunning() { exit(0) }

let app = NSApplication.shared
// LSUIElement covers the bundled app; this keeps `swift run` out of the Dock too.
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
