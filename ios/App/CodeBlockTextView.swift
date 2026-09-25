// CodeBlockTextView.swift
//
// A UIViewRepresentable wrapper around UITextView for rendering code blocks.
//
// SwiftUI's Text view measures monospaced text synchronously on the main thread
// via NSAttributedString / NSCoreTypesetter, which acquires an objc_sync_enter
// lock and can block the main thread for 2000 ms+ on large code responses.
// UITextView uses TextKit 2 (default iOS 16+), which performs layout off the
// main thread — fixing the AppHang without changing the visual output.
//
// isScrollEnabled = false because the parent ScrollView(.horizontal) in
// MarkdownText handles scrolling. We just need the text view to size itself
// to its full content width so the scroll view knows how far to scroll.

import SwiftUI
import UIKit

struct CodeBlockTextView: UIViewRepresentable {
    let text: String
    /// Append the streaming caret character after the last glyph when true.
    var caret: Bool = false

    private var displayText: String {
        caret ? text + "\u{2007}▍" : text
    }

    func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.isScrollEnabled = false
        textView.backgroundColor = .clear
        textView.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        // Disable single-line truncation so the horizontal ScrollView can
        // measure the true content width.
        textView.textContainer.maximumNumberOfLines = 0
        textView.textContainer.lineBreakMode = .byClipping
        // Allow the view to grow as wide as the content needs.
        textView.setContentCompressionResistancePriority(.required, for: .horizontal)
        textView.setContentHuggingPriority(.defaultHigh, for: .vertical)
        textView.text = displayText
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        guard textView.text != displayText else { return }
        textView.text = displayText
    }
}
