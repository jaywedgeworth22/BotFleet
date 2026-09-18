// Roster order for the chat list.
//
// Messages.app (and the Mac sidebar) pin first, then newest activity.
// Unread is a badge, not a sort key — putting unread rows above a chat
// that just moved is what made Plumber at 10:05 sit below Monitor at 8:01.
import Foundation

public enum ChatListOrder {
    /// Max of loaded transcript, each task's lastActivity (or createdAt),
    /// and the chat's own createdAt.
    public static func activity(
        createdAt: Double,
        taskActivities: [Double],
        loadedMessageAt: Double?
    ) -> Double {
        var stamp = createdAt
        if let loadedMessageAt, loadedMessageAt > stamp { stamp = loadedMessageAt }
        for taskAt in taskActivities where taskAt > stamp { stamp = taskAt }
        return stamp
    }

    /// `true` when `left` belongs above `right` in the roster.
    public static func orderedBefore(
        pinnedLeft: Bool,
        activityLeft: Double,
        pinnedRight: Bool,
        activityRight: Double
    ) -> Bool {
        if pinnedLeft != pinnedRight { return pinnedLeft }
        return activityLeft > activityRight
    }
}
