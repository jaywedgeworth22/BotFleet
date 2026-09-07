import SwiftUI

/// A small brand mark for the provider driving a bot's current model — the
/// Claude, Grok, OpenAI, etc. logo.  Mirrors `ProviderMark(driverKind:)` in
/// src/components/ProviderIcons.tsx so web and iOS agree; add a provider in
/// both places, keeping this switch as the single source of truth for the
/// iOS mapping.
///
/// Falls back to an uppercase monogram when no logo asset exists for the
/// driver kind, matching the house pattern in `BotAvatarView`: identity
/// never becomes an empty placeholder.
struct ProviderMarkView: View {
    let driverKind: String
    var size: CGFloat = 15

    private enum Mark {
        /// Full-color brand asset, rendered as-is.
        case asset(String)
        /// Monochrome brand asset, tinted to the current foreground style so
        /// it stays visible on both light and dark headers.
        case templateAsset(String)
        /// A generic SF Symbol standing in for a mark that has no brand
        /// artwork of its own (e.g. the "computer" driver).
        case symbol(String)
        /// No art shipped for this driver kind — fall back to a monogram.
        case monogram
    }

    private var mark: Mark {
        switch driverKind {
        case "claude", "claudeAgent":
            return .asset("ProviderMarkClaude")
        case "grok", "grokAgent":
            return .templateAsset("ProviderMarkGrok")
        case "deepseek", "deepseekAgent", "dsh", "dshAgent":
            return .asset("ProviderMarkDeepSeek")
        case "codex":
            return .asset("ProviderMarkCodex")
        case "openai-compat", "openai":
            return .templateAsset("ProviderMarkOpenAI")
        case "gemini", "geminiAgent", "antigravity", "antigravityAgent":
            return .asset("ProviderMarkGemini")
        case "cursor", "cursorAgent":
            return .templateAsset("ProviderMarkCursor")
        case "minimax", "minimaxAgent":
            return .asset("ProviderMarkMiniMax")
        case "boxAgent":
            return .symbol("desktopcomputer")
        // No source art shipped for these — they render on the monogram
        // fallback below, which is expected and fine.
        case "droid", "droidAgent", "kimi", "kimiAgent", "qwenAgent",
             "opencodeGo", "hermesAgent", "piAgent":
            return .monogram
        default:
            return .monogram
        }
    }

    /// Human-readable provider name for VoiceOver — this mark is identity,
    /// not decoration, so it must never read as silent chrome.
    private var displayName: String {
        switch driverKind {
        case "claude", "claudeAgent": return "Claude"
        case "grok", "grokAgent": return "Grok"
        case "deepseek", "deepseekAgent", "dsh", "dshAgent": return "DeepSeek"
        case "codex": return "Codex"
        case "openai-compat", "openai": return "OpenAI"
        case "gemini", "geminiAgent", "antigravity", "antigravityAgent": return "Gemini"
        case "cursor", "cursorAgent": return "Cursor"
        case "minimax", "minimaxAgent": return "MiniMax"
        case "boxAgent": return "Computer"
        case "kimi", "kimiAgent": return "Kimi"
        case "droid", "droidAgent": return "Droid"
        case "qwenAgent": return "Qwen"
        case "opencodeGo": return "OpenCode"
        case "hermesAgent": return "Hermes"
        case "piAgent": return "Pi"
        default: return driverKind
        }
    }

    /// Mirrors the web fallback exactly: `driverKind.replace(/Agent$/i, "").slice(0, 1).toUpperCase()`.
    private var monogram: String {
        var stripped = driverKind
        if stripped.lowercased().hasSuffix("agent") {
            stripped = String(stripped.dropLast(5))
        }
        return stripped.first.map { String($0).uppercased() } ?? "?"
    }

    var body: some View {
        Group {
            switch mark {
            case let .asset(name):
                Image(name)
                    .resizable()
                    .scaledToFit()
                    .padding(size * 0.14)
            case let .templateAsset(name):
                Image(name)
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .padding(size * 0.16)
                    .foregroundStyle(Color.primary)
            case let .symbol(systemImage):
                Image(systemName: systemImage)
                    .font(.system(size: size * 0.6, weight: .medium))
                    .foregroundStyle(Color.secondary)
            case .monogram:
                Text(monogram)
                    .font(.system(size: size * 0.55, weight: .semibold))
                    .foregroundStyle(Color.secondary)
            }
        }
        .frame(width: size, height: size)
        .background(Circle().fill(Color(uiColor: .systemBackground)))
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(displayName)
    }
}
