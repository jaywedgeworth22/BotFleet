import Foundation

/// App lifecycle states that affect local-only Live Activities.
public enum LiveActivityLifecyclePhase: Sendable, Equatable {
    case active
    case inactive
    case background
}

/// Work the ActivityKit coordinator must perform after a lifecycle change.
public enum LiveActivityLifecycleAction: Sendable, Equatable {
    case awaitFreshState
    case endAll
}

/// Keeps stale foreground work from landing after a background teardown.
///
/// `.inactive` is a transition on the way to system UI or background.  It
/// retains the preceding update policy; only `.background` disables updates
/// and ends activities.  The next `.active` transition starts a fresh
/// generation, but updates stay disabled until a post-resume snapshot lands.
public struct LiveActivityLifecycle: Sendable {
    public private(set) var phase: LiveActivityLifecyclePhase = .inactive
    public private(set) var generation = 0
    public private(set) var updatesEnabled = false

    public init() {}

    public mutating func transition(to next: LiveActivityLifecyclePhase) -> LiveActivityLifecycleAction? {
        guard next != phase else { return nil }
        phase = next
        switch next {
        case .active:
            generation += 1
            updatesEnabled = false
            return .awaitFreshState
        case .inactive:
            return nil
        case .background:
            generation += 1
            updatesEnabled = false
            return .endAll
        }
    }

    public func permitsUpdates(from candidateGeneration: Int) -> Bool {
        updatesEnabled && candidateGeneration == generation
    }

    public mutating func acceptFreshState(for candidateGeneration: Int) -> Bool {
        guard phase == .active, candidateGeneration == generation else { return false }
        updatesEnabled = true
        return true
    }
}
