import SwiftUI

/// An inline text field. Enter submits a non-empty value; Escape and losing focus cancel.
struct InputRow: View {
  let placeholder: String
  let onSubmit: (String) -> Void
  let onCancel: () -> Void

  // Stored `State` values instead of `@State`: in this SDK `@State` is a macro whose plugin
  // ships only with Xcode, and the app builds with the Command Line Tools.
  private let draft: State<String>
  private let selection: State<TextSelection?>
  @FocusState private var isFocused: Bool

  init(text: String, placeholder: String, onSubmit: @escaping (String) -> Void, onCancel: @escaping () -> Void) {
    self.placeholder = placeholder
    self.onSubmit = onSubmit
    self.onCancel = onCancel
    draft = State(initialValue: text)
    selection = State(initialValue: nil)
  }

  var body: some View {
    TextField(placeholder, text: draft.projectedValue, selection: selection.projectedValue)
      .textFieldStyle(.roundedBorder)
      .focused($isFocused)
      .onSubmit {
        let value = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if !value.isEmpty { onSubmit(value) }
      }
      .onExitCommand(perform: onCancel)
      .onChange(of: isFocused) { _, focused in
        if !focused { onCancel() }
      }
      .task {
        isFocused = true
        // Focusing selects all. Put the cursor at the end once focus has landed.
        await Task.yield()
        selection.wrappedValue = TextSelection(insertionPoint: draft.wrappedValue.endIndex)
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
  }
}
