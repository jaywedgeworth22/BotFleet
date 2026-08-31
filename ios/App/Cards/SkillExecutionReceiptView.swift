import SwiftUI
import CompanionCore

public struct SkillExecutionReceiptView: View {
    public let skillName: String
    public let status: String // "running", "success", "error"
    public let durationMs: Int
    public let parameters: String
    public let output: String
    
    @Environment(\.colorScheme) private var colorScheme
    @State private var isExpanded: Bool = false
    
    public init(
        skillName: String,
        status: String = "success",
        durationMs: Int = 0,
        parameters: String = "",
        output: String = ""
    ) {
        self.skillName = skillName
        self.status = status
        self.durationMs = durationMs
        self.parameters = parameters
        self.output = output
    }
    
    public var body: some View {
        let isDark = colorScheme == .dark
        let hasDetails = !parameters.isEmpty || !output.isEmpty
        
        VStack(alignment: .leading, spacing: 6) {
            Button {
                guard hasDetails else { return }
                withAnimation(.spring(response: 0.3, dampingFraction: 0.75)) {
                    isExpanded.toggle()
                }
                Haptics.selection()
            } label: {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: toolIcon(for: skillName))
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundColor(Color(hex: "#8B5CF6"))
                        .frame(width: 16, height: 16)
                        .padding(.top, 1)
                    
                    VStack(alignment: .leading, spacing: 2) {
                        Text(skillName)
                            .font(.system(size: 12, weight: .semibold, design: isCommand(skillName) ? .monospaced : .default))
                            .foregroundColor(isDark ? Color(hex: "#F8FAFC") : Color(hex: "#0F172A"))
                            .lineLimit(isExpanded ? nil : 4)
                            .fixedSize(horizontal: false, vertical: true)
                        
                        if durationMs > 0 {
                            Text("\(durationMs)ms")
                                .font(.system(size: 9.5, design: .monospaced))
                                .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                        }
                    }
                    
                    Spacer(minLength: 4)
                    
                    VStack(alignment: .trailing, spacing: 4) {
                        statusBadge
                        
                        if hasDetails {
                            HStack(spacing: 3) {
                                Text(isExpanded ? "Hide" : "Details")
                                    .font(.system(size: 9.5, weight: .medium))
                                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                                    .font(.system(size: 8, weight: .bold))
                            }
                            .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                        }
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(isDark ? Color.white.opacity(0.06) : Color.black.opacity(0.03))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!hasDetails)
            
            if isExpanded && hasDetails {
                VStack(alignment: .leading, spacing: 6) {
                    if !parameters.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("INPUT")
                                .font(.system(size: 8.5, weight: .heavy, design: .monospaced))
                                .foregroundColor(Color(hex: "#8B5CF6"))
                            Text(parameters)
                                .font(.system(size: 10.5, design: .monospaced))
                                .foregroundColor(isDark ? Color(hex: "#E2E8F0") : Color(hex: "#1E293B"))
                                .textSelection(.enabled)
                        }
                        .padding(6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(isDark ? Color.black.opacity(0.4) : Color.white.opacity(0.9))
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }
                    
                    if !output.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("OUTPUT")
                                .font(.system(size: 8.5, weight: .heavy, design: .monospaced))
                                .foregroundColor(Color(hex: "#10B981"))
                            Text(output)
                                .font(.system(size: 10.5, design: .monospaced))
                                .foregroundColor(isDark ? Color(hex: "#E2E8F0") : Color(hex: "#1E293B"))
                                .textSelection(.enabled)
                        }
                        .padding(6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(isDark ? Color.black.opacity(0.4) : Color.white.opacity(0.9))
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }
                }
                .padding(.top, 2)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(8)
        .background(
            LinearGradient(
                colors: isDark ? [
                    Color(hex: "#18181B").opacity(0.94),
                    Color(hex: "#0F172A").opacity(0.90)
                ] : [
                    Color.white.opacity(0.96),
                    Color(hex: "#F8FAFC").opacity(0.92)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(
                    status == "error"
                        ? Color.red.opacity(0.4)
                        : Color(hex: "#8B5CF6").opacity(isDark ? 0.25 : 0.20),
                    lineWidth: 0.75
                )
        )
        .shadow(color: Color.black.opacity(isDark ? 0.22 : 0.04), radius: 3, y: 1)
    }
    
    private func isCommand(_ text: String) -> Bool {
        text.hasPrefix("/") || text.contains("bin/") || text.contains("sh ") || text.contains("pnpm") || text.contains("git ") || text.contains("curl ")
    }
    
    private func toolIcon(for text: String) -> String {
        if text.contains("shell") || text.contains("zsh") || text.contains("bash") || text.hasPrefix("/") {
            return "terminal.fill"
        }
        if text.contains("PR") || text.contains("git") || text.contains("commit") {
            return "point.topleft.down.curvedto.point.bottomright.up"
        }
        if text.contains("test") || text.contains("CI") {
            return "checkmark.seal.fill"
        }
        return "wrench.and.screwdriver.fill"
    }
    
    @ViewBuilder
    private var statusBadge: some View {
        HStack(spacing: 3.5) {
            Circle()
                .fill(status == "success" ? Color.green : (status == "running" ? Color.orange : Color.red))
                .frame(width: 5, height: 5)
            Text(status.capitalized)
                .font(.system(size: 9.5, weight: .bold))
                .foregroundColor(status == "success" ? Color.green : (status == "running" ? Color.orange : Color.red))
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2.5)
        .background(
            status == "success"
                ? Color.green.opacity(0.12)
                : (status == "running" ? Color.orange.opacity(0.12) : Color.red.opacity(0.12))
        )
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

/// A collapsible group of consecutive tool activities with live counter and latest command.
public struct ActivityRunCardView: View {
    public let messages: [Message]
    public let isBusy: Bool
    
    @Environment(\.colorScheme) private var colorScheme
    @State private var isExpanded: Bool = false
    
    public init(messages: [Message], isBusy: Bool = false) {
        self.messages = messages
        self.isBusy = isBusy
    }
    
    private var hasFailed: Bool {
        messages.contains { $0.tool?.ok == false }
    }
    
    private var isRunning: Bool {
        messages.contains { $0.tool?.ok == nil }
    }
    
    private var latestTool: ToolActivity? {
        messages.last(where: { $0.tool != nil })?.tool
    }
    
    private var toolBreakdown: [(name: String, count: Int)] {
        var counts: [String: Int] = [:]
        for m in messages {
            if let tool = m.tool {
                let name = shortToolName(tool.name)
                counts[name, default: 0] += 1
            }
        }
        return counts.map { ($0.key, $0.value) }.sorted { $0.count > $1.count }
    }
    
    private func shortToolName(_ raw: String) -> String {
        if raw.contains("apple-notes") { return "notes" }
        if raw.hasPrefix("auto-approved shell:") || raw.contains("/bin/zsh") || raw.contains("/bin/bash") { return "shell" }
        if raw.hasPrefix("PR #") || raw.contains("pull request") { return "github" }
        if let first = raw.split(separator: " ").first {
            return String(first)
        }
        return raw
    }
    
    public var body: some View {
        let isDark = colorScheme == .dark
        
        VStack(alignment: .leading, spacing: 6) {
            // Header summary button
            Button {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                    isExpanded.toggle()
                }
                Haptics.selection()
            } label: {
                HStack(spacing: 9) {
                    // Status icon
                    ZStack {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(
                                hasFailed
                                    ? Color.red.opacity(0.15)
                                    : (isRunning
                                        ? Color.purple.opacity(0.18)
                                        : Color.green.opacity(0.15))
                            )
                            .frame(width: 28, height: 28)
                        
                        if isRunning {
                            ProgressView()
                                .controlSize(.small)
                                .tint(Color.purple)
                        } else if hasFailed {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundColor(Color.red)
                        } else {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundColor(Color.green)
                        }
                    }
                    
                    VStack(alignment: .leading, spacing: 2.5) {
                        HStack(spacing: 6) {
                            Text(titleText)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(isDark ? Color(hex: "#F8FAFC") : Color(hex: "#0F172A"))
                            
                            if isRunning {
                                HStack(spacing: 3) {
                                    Circle().fill(Color.orange).frame(width: 5, height: 5)
                                    Text("Active")
                                        .font(.system(size: 9, weight: .bold))
                                        .foregroundColor(Color.orange)
                                }
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .background(Color.orange.opacity(0.12))
                                .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                            }
                        }
                        
                        // Breakdown pills or latest tool
                        HStack(spacing: 4) {
                            if isRunning, let latest = latestTool {
                                Text("Running: \(latest.name)")
                                    .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                                    .foregroundColor(isDark ? Color(hex: "#A78BFA") : Color(hex: "#7C3AED"))
                                    .lineLimit(1)
                            } else {
                                ForEach(toolBreakdown.prefix(3), id: \.name) { item in
                                    Text("\(item.name)\(item.count > 1 ? " ×\(item.count)" : "")")
                                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                                        .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 1.5)
                                        .background(isDark ? Color.white.opacity(0.06) : Color.black.opacity(0.04))
                                        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                                }
                                if toolBreakdown.count > 3 {
                                    Text("+\(toolBreakdown.count - 3)")
                                        .font(.system(size: 9.5, weight: .semibold))
                                        .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                                }
                            }
                        }
                    }
                    
                    Spacer(minLength: 4)
                    
                    // Expand/collapse indicator
                    HStack(spacing: 3) {
                        Text(isExpanded ? "Collapse" : "Show \(messages.count)")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(Color(hex: "#8B5CF6"))
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 9.5, weight: .bold))
                            .foregroundColor(Color(hex: "#8B5CF6"))
                    }
                    .padding(.horizontal, 7)
                    .padding(.vertical, 4)
                    .background(Color(hex: "#8B5CF6").opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(
                    LinearGradient(
                        colors: isDark ? [
                            Color(hex: "#1E1E24").opacity(0.95),
                            Color(hex: "#121218").opacity(0.92)
                        ] : [
                            Color.white.opacity(0.98),
                            Color(hex: "#F8FAFC").opacity(0.95)
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(
                            hasFailed
                                ? Color.red.opacity(0.35)
                                : (isRunning
                                    ? Color.purple.opacity(0.35)
                                    : Color.primary.opacity(0.08)),
                            lineWidth: 0.75
                        )
                )
            }
            .buttonStyle(.plain)
            
            // Expanded individual tool receipts
            if isExpanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(messages) { msg in
                        if let tool = msg.tool {
                            SkillExecutionReceiptView(
                                skillName: tool.name,
                                status: tool.ok.map { $0 ? "success" : "error" } ?? "running"
                            )
                        }
                    }
                }
                .padding(.leading, 6)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }
    
    private var titleText: String {
        if isRunning {
            return "\(messages.count) tool \(messages.count == 1 ? "step" : "steps") in progress"
        }
        if hasFailed {
            let failed = messages.filter { $0.tool?.ok == false }.count
            return "\(messages.count) \(messages.count == 1 ? "step" : "steps") (\(failed) failed)"
        }
        return "\(messages.count) tool \(messages.count == 1 ? "step" : "steps") completed"
    }
}
