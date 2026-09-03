// Keeping the Dynamic Island in step with the bots.
//
// One Live Activity per bot that is doing something — needs you, working,
// or has an unread message — started, updated and ended from the same
// `updates` the pill reads. Tapping the lock-screen card opens that bot's
// thread. The stream is foreground-only and there is no push path yet, so
// the island is exact while the app is alive and goes quiet with it; iOS
// keeps the last state on screen for a while, then the activity is ended
// on the next launch if the bot has moved on.
import ActivityKit
import Combine
import Foundation
import CompanionCore

@MainActor
final class LiveActivityCoordinator {
    private var cancellable: AnyCancellable?
    private var lastSent: [String: BotActivityAttributes.ContentState] = [:]
    /// When each bot's current kind began, so an update does not reset the clock.
    private var since: [String: (kind: String, at: Date)] = [:]

    func attach(to session: Session) {
        // Answer from the island: the intent runs in this process.
        AnswerApprovalIntent.handler = { [weak session] threadId, requestId, choice, isPermission in
            await session?.answer(threadId: threadId, requestId: requestId, choice: choice, isPermission: isPermission)
        }
        cancellable = session.$state
            .debounce(for: .milliseconds(400), scheduler: DispatchQueue.main)
            .sink { [weak self] state in self?.sync(state) }
    }

    private func sync(_ state: CompanionState) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let wanted = state.updates.filter { if case .bot = $0.chat { return true } else { return false } }
        var wantedIds = Set<String>()

        for update in wanted {
            guard case let .bot(bot) = update.chat else { continue }
            wantedIds.insert(bot.id)
            let face = MausState.forBot(bot, last: state.visibleTranscript(forThread: bot.threadId).last)
            let kind = liveActivityKind(update.kind)
            if since[bot.id]?.kind != kind { since[bot.id] = (kind, Date()) }
            let content = BotActivityAttributes.ContentState(
                face: face.rawValue,
                kind: kind,
                headline: liveActivityHeadline(bot.name, kind: update.kind),
                line: update.line.isEmpty ? (update.card?.title ?? "") : update.line,
                requestId: update.card?.isPending == true ? update.card?.requestId : nil,
                options: update.card?.isPending == true ? (update.card?.options ?? []) : [],
                isPermission: update.card?.isPermission ?? false,
                since: since[bot.id]?.at ?? Date()
            )
            if lastSent[bot.id] == content { continue }
            defer { lastSent[bot.id] = content }

            // A bot stopping for you is worth an alert: the island pops open
            // on its own and the lock screen lights up. Working and unread
            // are not — unread dismisses itself once the thread is read.
            let alert: AlertConfiguration? = update.kind == .needsYou
                ? AlertConfiguration(
                    title: LocalizedStringResource(stringLiteral: content.headline),
                    body: LocalizedStringResource(stringLiteral: content.line),
                    sound: .default
                )
                : nil
            if let activity = Activity<BotActivityAttributes>.activities.first(where: { $0.attributes.botId == bot.id }) {
                if activity.attributes.threadId != bot.threadId {
                    Task { await activity.end(nil, dismissalPolicy: .immediate) }
                    requestActivity(bot: bot, content: content, alert: nil)
                    continue
                }
                let newAsk = update.kind == .needsYou && lastSent[bot.id] != nil && lastSent[bot.id]?.requestId != content.requestId
                Task { await activity.update(.init(state: content, staleDate: nil), alertConfiguration: newAsk ? alert : nil) }
            } else {
                requestActivity(bot: bot, content: content, alert: alert)
            }
        }

        // bots that went quiet or whose unread was opened: let the island go
        for activity in Activity<BotActivityAttributes>.activities where !wantedIds.contains(activity.attributes.botId) {
            lastSent.removeValue(forKey: activity.attributes.botId)
            since.removeValue(forKey: activity.attributes.botId)
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
    }

    private func requestActivity(
        bot: Bot,
        content: BotActivityAttributes.ContentState,
        alert: AlertConfiguration?
    ) {
        let attributes = BotActivityAttributes(botId: bot.id, threadId: bot.threadId, name: bot.name, color: bot.color)
        // Closed-app push is not in this version; keep the activity local.
        _ = try? Activity.request(attributes: attributes, content: .init(state: content, staleDate: nil), pushType: nil)
        // a fresh activity cannot alert on request; one immediate alerting update does it.
        // We only do this if it is a genuinely new ask, not a pre-existing state from app launch.
        let newAsk = content.kind == "needsYou" && lastSent[bot.id] != nil && lastSent[bot.id]?.requestId != content.requestId
        if newAsk, let alert, let activity = Activity<BotActivityAttributes>.activities.first(where: { $0.attributes.botId == bot.id }) {
            Task { await activity.update(.init(state: content, staleDate: nil), alertConfiguration: alert) }
        }
    }
}

func liveActivityKind(_ kind: ChatUpdate.Kind) -> String {
    switch kind {
    case .needsYou: return "needsYou"
    case .working: return "working"
    case .toReview: return "toReview"
    }
}

func liveActivityHeadline(_ name: String, kind: ChatUpdate.Kind) -> String {
    switch kind {
    case .needsYou: return "\(name) needs you"
    case .working: return "\(name) is working"
    case .toReview: return "\(name) has an update"
    }
}
