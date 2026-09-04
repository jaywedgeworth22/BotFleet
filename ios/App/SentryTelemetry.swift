import Foundation
import Sentry

/// Native Sentry crash reporting and telemetry for BotFleet iOS Companion.
enum SentryTelemetry {
    static func start() {
        let dsn = (Bundle.main.object(forInfoDictionaryKey: "SENTRY_DSN") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard dsn.hasPrefix("https://") else { return }

        SentrySDK.start { options in
            options.dsn = dsn
            options.environment = "production"
            options.tracesSampleRate = 0.2
            options.profilesSampleRate = 0.1
            options.enableAppHangTracking = true
            options.appHangTimeoutInterval = 2.0
            options.enableCaptureFailedRequests = true
            options.failedRequestStatusCodes = [HttpStatusCodeRange(min: 500, max: 599)]
            options.attachScreenshot = false
            options.attachViewHierarchy = false
            options.sendDefaultPii = false
            options.sessionReplay.sessionSampleRate = 0.1
            options.sessionReplay.onErrorSampleRate = 1.0
            options.sessionReplay.maskAllText = true
            options.sessionReplay.maskAllImages = true
            options.beforeSend = { event in
                if let request = event.request, let url = request.url {
                    var sanitized = url
                    for param in ["token", "key", "secret", "auth", "password"] {
                        sanitized = sanitized.replacingOccurrences(
                            of: "([?&]\(param)=)[^&#\\s]+",
                            with: "$1[REDACTED]",
                            options: .regularExpression
                        )
                    }
                    request.url = sanitized
                }
                return event
            }
        }
    }
}
