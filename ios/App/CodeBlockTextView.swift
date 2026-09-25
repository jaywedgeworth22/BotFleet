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

    private static let font = UIFont.monospacedSystemFont(ofSize: 14, weight: .regular)
    /// Figure space + block, matching the old `Text(...) + caretText(...)`
    /// path's glyphs exactly.
    private static let caretGlyphs = "\u{2007}▍"

    /// The plain string actually on screen, caret glyphs included — used to
    /// decide whether `updateUIView` has anything new to draw.
    private var displayText: String {
        caret ? text + Self.caretGlyphs : text
    }

    /// `.label` for the body so it matches the label color the old `Text`
    /// view inherited (dynamic — UIKit re-resolves it on every trait/appearance
    /// change without any extra code), and `.secondaryLabel` for the caret so
    /// it reads as a cursor rather than as part of the code, matching the old
    /// `Color.secondary` caret.  Two colors in one line means an attributed
    /// string rather than the `text`/`textColor` pair, which can only ever
    /// hold one color.
    private var displayAttributedText: NSAttributedString {
        let result = NSMutableAttributedString(
            string: text,
            attributes: [.font: Self.font, .foregroundColor: UIColor.label]
        )
        if caret {
            result.append(NSAttributedString(
                string: Self.caretGlyphs,
                attributes: [.font: Self.font, .foregroundColor: UIColor.secondaryLabel]
            ))
        }
        return result
    }

    func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.isScrollEnabled = false
        textView.backgroundColor = .clear
        textView.font = Self.font
        // Belt-and-suspenders: the body color really comes from the
        // `.foregroundColor` attribute above (attributedText ignores
        // `textColor`), but this keeps a sane fallback if anything ever
        // assigns `.text` directly instead of `.attributedText`.
        textView.textColor = .label
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        // Disable single-line truncation so the horizontal ScrollView can
        // measure the true content width.
        textView.textContainer.maximumNumberOfLines = 0
        textView.textContainer.lineBreakMode = .byClipping
        // Allow the view to grow as wide as the content needs.
        textView.setContentCompressionResistancePriority(.required, for: .horizontal)
        textView.setContentHuggingPriority(.defaultHigh, for: .vertical)
        textView.attributedText = displayAttributedText
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        guard textView.attributedText.string != displayText else { return }
        textView.attributedText = displayAttributedText
        // The parent ScrollView measures this view's intrinsic size; without
        // this, streaming a longer block in place can leave the scroll
        // width/height stale until some unrelated layout pass.
        textView.invalidateIntrinsicContentSize()
    }
}
