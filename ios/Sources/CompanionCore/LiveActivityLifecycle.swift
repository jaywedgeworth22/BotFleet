import Foundation

/// App lifecycle states that affect local-only Live Activities.
public enum LiveActivityLifecyclePhase: Sendable, Equatable {
    case active
    case inactive
    case background
}

/// Work the ActivityKit coordinator must perform after a lifecycle change.
public enum LiveActivityLifecycleAction: Sendable, Equatable {
    case sync
    case endAll
}

/// Keeps stale foreground work from landing after a background teardown.
///
/// `.inactive` is a transition on the way to system UI or background.  It
/// retains the preceding update policy; only `.background` disables updates
/// and ends activities, while the next `.active` transition starts a fresh
/// generation and reconciles the current state.
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
            updatesEnabled = true
            return .sync
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
}
