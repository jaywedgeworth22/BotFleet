// The Mac Update card's contract: `MacUpdateStatus` decoding for every
// outcome it has to render, the `update.status` stream frame, and the fold
// into `CompanionState`.
//
// The shapes here are pinned against `server/update-control.ts` and the
// route handlers in PR #382 (branch `claude/remote-update`) — not yet merged
// to `main` at the time this was written, so there is no captured fixture
// from a live run yet.  These are hand-written to match that PR's diff
// verbatim rather than `scripts/capture-companion-fixtures.mjs` output.
// Re-capture and replace once the route lands on `main`, the same way
// `options-card.json` is called out in `DecodingTests.swift` as the one
// fixture a run does not regenerate.
import Foundation
import XCTest
@testable import CompanionCore

final class MacUpdateTests: XCTestCase {
    // MARK: - MacUpdateStatus decoding

    func testUpToDateHasNoAvailableUpdateOrRun() throws {
        let json = Data(#"""
        {
          "installed": {"version": "1.0.30", "sourceCommit": "abcdef1234567890", "installedAt": "2026-09-12T10:00:00Z"},
          "available": null,
          "checkedAt": "2026-09-13T09:00:00Z",
          "running": null,
          "lastRun": null,
          "capabilities": {"canCheck": true, "canRun": false, "reasons": ["Already up to date."]}
        }
        """#.utf8)
        let status = try JSONDecoder().decode(MacUpdateStatus.self, from: json)
        XCTAssertEqual(status.installed.version, "1.0.30")
        XCTAssertNil(status.available)
        XCTAssertNil(status.running)
        XCTAssertNil(status.lastRun)
        XCTAssertTrue(status.capabilities.canCheck)
        XCTAssertFalse(status.capabilities.canRun)
    }

    func testUpdateAvailableCarriesCommitsAheadBy() throws {
        let json = Data(#"""
        {
          "installed": {"version": "1.0.30", "sourceCommit": "abc1234"},
          "available": {
            "sourceCommit": "def5678",
            "version": "1.0.31",
            "aheadBy": 3,
            "commits": [
              {"sha": "def5678", "subject": "feat: room turns on the HTTP lane"},
              {"sha": "cba9876", "subject": "fix: approval broker race"}
            ]
          },
          "checkedAt": "2026-09-13T09:00:00Z",
          "running": null,
          "lastRun": null,
          "capabilities": {"canCheck": true, "canRun": true, "reasons": []}
        }
        """#.utf8)
        let status = try JSONDecoder().decode(MacUpdateStatus.self, from: json)
        let available = try XCTUnwrap(status.available)
        XCTAssertEqual(available.aheadBy, 3)
        XCTAssertEqual(available.commits.count, 2)
        XCTAssertEqual(available.commits.first?.subject, "feat: room turns on the HTTP lane")
        XCTAssertTrue(status.capabilities.canRun)
    }

    func testRunningCarriesProgressAndLogTail() throws {
        let json = Data(#"""
        {
          "installed": {"version": "1.0.30", "sourceCommit": "abc1234"},
          "available": null,
          "checkedAt": "2026-09-13T09:00:00Z",
          "running": {
            "runId": "run-1",
            "startedAt": "2026-09-13T09:05:00Z",
            "step": "Staging build",
            "progress": 0.42,
            "logTail": ["Fetching origin/main…", "Building…"]
          },
          "lastRun": null,
          "capabilities": {"canCheck": false, "canRun": false, "reasons": ["An update is already running."]}
        }
        """#.utf8)
        let status = try JSONDecoder().decode(MacUpdateStatus.self, from: json)
        let running = try XCTUnwrap(status.running)
        XCTAssertEqual(running.step, "Staging build")
        XCTAssertEqual(running.progress, 0.42)
        XCTAssertEqual(running.logTail, ["Fetching origin/main…", "Building…"])
        XCTAssertFalse(status.capabilities.canRun)
    }

    func testEveryDocumentedOutcomeDecodes() throws {
        for outcome in ["verified", "rolled-back", "failed", "refused"] {
            let json = Data(#"""
            {
              "installed": {"version": "1.0.31", "sourceCommit": "def5678"},
              "available": null,
              "checkedAt": "2026-09-13T09:10:00Z",
              "running": null,
              "lastRun": {
                "runId": "run-1",
                "startedAt": "2026-09-13T09:05:00Z",
                "finishedAt": "2026-09-13T09:09:00Z",
                "outcome": "\#(outcome)",
                "message": "Done.",
                "receiptPath": "/Users/jay/apps/update-botfleet-mac/stage/receipt.json"
              },
              "capabilities": {"canCheck": true, "canRun": true, "reasons": []}
            }
            """#.utf8)
            let status = try JSONDecoder().decode(MacUpdateStatus.self, from: json)
            let lastRun = try XCTUnwrap(status.lastRun, "outcome \(outcome)")
            XCTAssertEqual(lastRun.outcome.rawValue, outcome)
        }
    }

    func testAFutureOutcomeFallsBackRatherThanFailingTheDecode() throws {
        let json = Data(#"""
        {"runId": "r", "startedAt": "t0", "finishedAt": "t1", "outcome": "superseded", "message": "m"}
        """#.utf8)
        let lastRun = try JSONDecoder().decode(MacUpdateLastRun.self, from: json)
        XCTAssertEqual(lastRun.outcome, .unknown)
    }

    /// `checkedAt` is `null` on a Mac that has never checked — distinct from
    /// "no update available", which is what a real timestamp with `available:
    /// null` means instead.
    func testCheckedAtIsNilBeforeTheFirstCheck() throws {
        let json = Data(#"""
        {
          "installed": {"version": "1.0.30", "sourceCommit": "abc1234"},
          "available": null,
          "checkedAt": null,
          "running": null,
          "lastRun": null,
          "capabilities": {"canCheck": true, "canRun": true, "reasons": []}
        }
        """#.utf8)
        let status = try JSONDecoder().decode(MacUpdateStatus.self, from: json)
        XCTAssertNil(status.checkedAt)
    }

    // MARK: - `POST /api/update/run`'s two response bodies

    /// The 202 body carries a full status alongside the run id, so the phone
    /// never needs a follow-up GET just to see what starting the run changed.
    func testRunStartedCarriesTheRunIdAndAFullStatus() throws {
        let json = Data(#"""
        {"runId": "run-42", "status": \#(sampleStatusJSON)}
        """#.utf8)
        let started = try JSONDecoder().decode(MacUpdateRunStarted.self, from: json)
        XCTAssertEqual(started.runId, "run-42")
        XCTAssertEqual(started.status.installed.version, "1.0.30")
    }

    /// The 409 body is `{ error, status }` — the same status a 202 would
    /// have carried, plus why it refused instead of a run id.
    func testRunRefusalBodyCarriesTheReasonAndAFullStatus() throws {
        let json = Data(#"""
        {"error": "An update is already running.", "status": \#(sampleStatusJSON)}
        """#.utf8)
        let refusal = try JSONDecoder().decode(MacUpdateRunRefusalBody.self, from: json)
        XCTAssertEqual(refusal.error, "An update is already running.")
        XCTAssertEqual(refusal.status.installed.sourceCommit, "abc1234")
    }

    // MARK: - A check the harness could not complete

    /// `checkError` is the harness saying the comparison in this very reply
    /// is stale — `available` and `checkedAt` are both left where the last
    /// check that worked put them, so a client that ignores the field
    /// reports a week-old answer as a fresh one.
    func testCheckErrorCarriesTheReasonTheComparisonIsStale() throws {
        let json = Data(#"""
        {
          "installed": {"version": "1.0.30", "sourceCommit": "abc1234"},
          "available": null,
          "checkedAt": "2026-09-06T09:00:00Z",
          "checkError": "Could not reach the update source.\u00a0 fatal: could not resolve host: github.com",
          "running": null,
          "lastRun": null,
          "capabilities": {"canCheck": true, "canRun": false, "reasons": []}
        }
        """#.utf8)
        let status = try JSONDecoder().decode(MacUpdateStatus.self, from: json)
        let checkError = try XCTUnwrap(status.checkError)
        XCTAssertTrue(checkError.hasPrefix("Could not reach the update source."))
        // The stale pair the field exists to contradict is still populated —
        // this is exactly the payload that would read as "Up to date".
        XCTAssertNil(status.available)
        XCTAssertEqual(status.checkedAt, "2026-09-06T09:00:00Z")
    }

    /// A harness that predates the field omits it, and that is a check that
    /// worked, not one that failed — the optional has to decode as `nil`
    /// rather than making every older Mac undecodable.
    func testAStatusWithoutCheckErrorDecodesAsNil() throws {
        let status = try JSONDecoder().decode(MacUpdateStatus.self, from: Data(sampleStatusJSON.utf8))
        XCTAssertNil(status.checkError)
    }

    /// The 502 body is `{ error, status }` — the same pairing the 409
    /// refusal uses, so `checkForUpdates()` can hand back both the sentence
    /// and a status whose installed build and capabilities are still current.
    func testCheckFailureBodyCarriesTheReasonAndAFullStatus() throws {
        let json = Data(#"""
        {"error": "Could not read origin/main in /Users/jay/Code/BotFleet.", "status": \#(sampleStatusJSON)}
        """#.utf8)
        let failure = try JSONDecoder().decode(MacUpdateCheckFailureBody.self, from: json)
        XCTAssertEqual(failure.error, "Could not read origin/main in /Users/jay/Code/BotFleet.")
        XCTAssertEqual(failure.status.installed.sourceCommit, "abc1234")
        XCTAssertTrue(failure.status.capabilities.canCheck)
    }

    // MARK: - The `update.status` stream frame

    private var sampleStatusJSON: String {
        #"""
        {"installed": {"version": "1.0.30", "sourceCommit": "abc1234"}, "available": null, "checkedAt": "2026-09-13T09:00:00Z", "running": null, "lastRun": null, "capabilities": {"canCheck": true, "canRun": true, "reasons": []}}
        """#
    }

    /// The confirmed wrapped shape, verbatim from `server/index.ts`'s
    /// `emit: (status) => broadcast({ kind: "update.status", status })` — a
    /// `status`-nested payload, not the flat-fields shape `screen` and
    /// `computer` use.  `broadcast()` may stamp its own `seq` onto the wire
    /// payload the way it does for every other frame kind; `StreamFrame.seq`
    /// stays optional regardless, so this decodes with or without one.
    func testDecodesTheConfirmedWrappedShapeExactly() throws {
        let json = Data(#"{"kind": "update.status", "status": \#(sampleStatusJSON)}"#.utf8)
        let frame = try JSONDecoder().decode(StreamFrame.self, from: json)
        guard case let .updateStatus(status) = frame.frame else {
            return XCTFail("expected .updateStatus")
        }
        XCTAssertEqual(status.installed.version, "1.0.30")
        XCTAssertNil(frame.seq)
    }

    func testDecodesTheEventWhenTheStatusIsNestedUnderAKey() throws {
        let json = Data(#"{"kind": "update.status", "seq": 9, "status": \#(sampleStatusJSON)}"#.utf8)
        let frame = try JSONDecoder().decode(StreamFrame.self, from: json)
        guard case let .updateStatus(status) = frame.frame else {
            return XCTFail("expected .updateStatus")
        }
        XCTAssertEqual(status.installed.version, "1.0.30")
        XCTAssertEqual(frame.seq, 9)
    }

    func testDecodesTheEventWhenTheStatusFieldsAreFlatOnTheFrame() throws {
        // If the harness instead spreads the status fields onto the frame
        // itself — the shape `screen` and `computer` use — this must still
        // decode rather than silently dropping every update.status event.
        // Strip exactly the outer `{`/`}` (not every trailing brace, which
        // `trimmingCharacters` would also eat into "capabilities") so the
        // inner fields land as siblings of "kind" and "seq" instead.
        let innerFields = String(sampleStatusJSON.dropFirst().dropLast())
        let json = "{\"kind\": \"update.status\", \"seq\": 9, " + innerFields + "}"
        let frame = try JSONDecoder().decode(StreamFrame.self, from: Data(json.utf8))
        guard case let .updateStatus(status) = frame.frame else {
            return XCTFail("expected .updateStatus")
        }
        XCTAssertEqual(status.installed.version, "1.0.30")
    }

    func testAnUnrecognisedKindStillAbsorbsRatherThanThrows() throws {
        let json = Data(#"{"kind": "update.progress", "seq": 1}"#.utf8)
        let frame = try JSONDecoder().decode(StreamFrame.self, from: json)
        guard case .unknown = frame.frame else {
            return XCTFail("expected .unknown")
        }
    }

    /// A `status`-keyed payload missing a required field (here, `installed`)
    /// fails both the wrapped and the flat decode attempt.  This must fold
    /// to `.unknown` — like any other kind this build cannot make sense
    /// of — rather than throwing out of `Frame.init(from:)` and taking the
    /// whole `StreamFrame` decode down with it.
    func testAMalformedStatusPayloadFoldsToUnknownRatherThanThrowing() throws {
        let json = Data(#"""
        {"kind": "update.status", "seq": 9, "status": {"checkedAt": null}}
        """#.utf8)
        let frame = try JSONDecoder().decode(StreamFrame.self, from: json)
        guard case .unknown(kind: "update.status") = frame.frame else {
            return XCTFail("expected .unknown(kind: \"update.status\"), got \(frame.frame)")
        }
    }

    /// Same claim, at the flat shape: no `status` key at all, and the
    /// top-level object is missing every required field too.
    func testACompletelyUnrecognisableUpdateStatusFrameFoldsToUnknown() throws {
        let json = Data(#"{"kind": "update.status", "seq": 9}"#.utf8)
        let frame = try JSONDecoder().decode(StreamFrame.self, from: json)
        guard case .unknown(kind: "update.status") = frame.frame else {
            return XCTFail("expected .unknown(kind: \"update.status\"), got \(frame.frame)")
        }
    }

    // MARK: - The fold

    func testApplyingTheFrameStoresStatusOnState() {
        var state = CompanionState()
        XCTAssertNil(state.macUpdateStatus)
        let status = MacUpdateStatus(
            installed: MacInstalledBuild(version: "1.0.30", sourceCommit: "abc1234"),
            checkedAt: "2026-09-13T09:00:00Z",
            capabilities: MacUpdateCapabilities(canCheck: true, canRun: true)
        )
        state.apply(.updateStatus(status))
        XCTAssertEqual(state.macUpdateStatus?.installed.sourceCommit, "abc1234")
    }

    func testANewerFrameReplacesAnOlderOne() {
        var state = CompanionState()
        state.apply(.updateStatus(MacUpdateStatus(
            installed: MacInstalledBuild(sourceCommit: "abc1234"),
            checkedAt: "t0",
            capabilities: MacUpdateCapabilities(canCheck: true, canRun: false, reasons: ["An update is already running."])
        )))
        state.apply(.updateStatus(MacUpdateStatus(
            installed: MacInstalledBuild(sourceCommit: "def5678"),
            checkedAt: "t1",
            capabilities: MacUpdateCapabilities(canCheck: true, canRun: true)
        )))
        XCTAssertEqual(state.macUpdateStatus?.installed.sourceCommit, "def5678")
        XCTAssertTrue(state.macUpdateStatus?.capabilities.canRun == true)
    }
    // MARK: - Timestamp parsing

    /// The exact shape the harness emits: `deps.now().toISOString()` in
    /// `server/update-control.ts` always carries milliseconds, and until
    /// `MacUpdateTimestamp` existed the card rendered that string raw.
    func testParsesTheMillisecondSpellingTheHarnessActuallyEmits() throws {
        let date = try XCTUnwrap(MacUpdateTimestamp.date(from: "2026-09-14T08:46:09.123Z"))
        XCTAssertEqual(date.timeIntervalSince1970, 1_789_375_569.123, accuracy: 0.001)
    }

    /// The other spelling that has to keep working: a whole-second stamp,
    /// which is what every hand-written fixture in this file carries.
    func testParsesTheWholeSecondSpellingToo() throws {
        let date = try XCTUnwrap(MacUpdateTimestamp.date(from: "2026-09-14T08:46:09Z"))
        XCTAssertEqual(date.timeIntervalSince1970, 1_789_375_569, accuracy: 0.001)
    }

    /// Why the helper exists at all — pinned so nobody "simplifies" it back
    /// to a default-configured formatter.
    func testADefaultFormatterIsWhyThisHelperExists() {
        XCTAssertNil(ISO8601DateFormatter().date(from: "2026-09-14T08:46:09.123Z"))
    }

    func testRejectsSomethingThatIsNotATimestamp() {
        XCTAssertNil(MacUpdateTimestamp.date(from: "never"))
        XCTAssertNil(MacUpdateTimestamp.date(from: ""))
    }
}
