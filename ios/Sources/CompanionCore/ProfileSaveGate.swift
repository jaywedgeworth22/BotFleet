public enum ProfileSaveGate {
    /// Runs a profile save and applies the server-confirmed value only when the
    /// request succeeds.  Callers can use the return value to gate dismissal.
    @MainActor
    public static func run<Value>(
        save: () async -> Value?,
        accept: (Value) -> Void
    ) async -> Bool {
        guard let saved = await save() else { return false }
        accept(saved)
        return true
    }
}
