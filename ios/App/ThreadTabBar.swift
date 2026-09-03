import SwiftUI
import CompanionCore

/// In-chat thread switcher. Tasks used to live only in the composer + sheet;
/// they now sit under the chat header the way Safari keeps windows in tabs.
struct ThreadTabBar: View {
    let bot: Bot
    @EnvironmentObject private var session: Session

    private var current: Bot { session.state.bot(bot.id) ?? bot }
    private var tasks: [BotTask] { current.tasks ?? [] }

    var body: some View {
        if tasks.isEmpty {
            EmptyView()
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(tasks, id: \.threadId) { task in
                        Button {
                            Task { await session.switchTask(task, for: current) }
                        } label: {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(task.title.isEmpty ? "Untitled" : task.title)
                                    .font(.system(size: 13, weight: task.threadId == current.threadId ? .semibold : .medium))
                                    .lineLimit(1)
                                Text(RelativeStamp.list(task.lastActivity ?? task.createdAt))
                                    .font(.system(size: 10))
                                    .foregroundStyle(Color.secondary)
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(
                                Capsule().fill(
                                    task.threadId == current.threadId
                                        ? Color.primary.opacity(0.12)
                                        : Color.primary.opacity(0.05)
                                )
                            )
                        }
                        .buttonStyle(.plain)
                        .disabled(current.busy == true && task.threadId != current.threadId)
                        .accessibilityAddTraits(task.threadId == current.threadId ? .isSelected : [])
                        .accessibilityLabel(task.title.isEmpty ? "Untitled thread" : task.title)
                    }
                    Button {
                        Task { await session.createTask(for: current, title: nil) }
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 13, weight: .semibold))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .background(Capsule().fill(Color.primary.opacity(0.05)))
                    }
                    .buttonStyle(.plain)
                    .disabled(current.busy == true)
                    .accessibilityLabel("New thread")
                }
                .padding(.horizontal, 16)
            }
        }
    }
}
