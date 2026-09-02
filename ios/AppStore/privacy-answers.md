# App Privacy answers

Use these answers only after confirming that the submitted binary and the
production hosted service still match this repository.

- Tracking: **No**
- Data used for third-party advertising, developer advertising, or marketing:
  **None**
- Third-party advertising or analytics SDKs: **None** for advertising or
  product analytics.  The app links the **Sentry** crash-reporting SDK
  (`sentry-cocoa`, see `ios/App/SentryTelemetry.swift`).  It is inactive unless
  the build was cut with a `SENTRY_DSN`; builds shipped through the fleet
  script and the TestFlight workflow include one.
- Data used for **App Functionality** (diagnostics, not linked to the user):
  - Diagnostics: **Crash Data**, **Performance Data** (app hangs longer than
    two seconds, a 20% sample of traces, and failed HTTP 5xx requests with
    their URL), and **Other Diagnostic Data** (device model, OS version, app
    version, an anonymous installation identifier).
  - Sentry is configured with `sendDefaultPii = false`, no screenshots, and no
    view hierarchy.  Query parameters named `token`, `key`, `secret`, `auth`,
    or `password` are redacted on the phone before an event is sent.  Message
    content, transcripts, and pairing tokens are never attached.
- Data linked to the user, for **App Functionality**:
  - Contact Info: **Email Address** (the profile email exposed by the paired
    computer)
  - Identifiers: **Device ID** (the opaque paired-device identifier returned
    by the user's computer)
- Data used for **Security/Fraud Prevention** and service reliability:
  computer platform/app version, security timestamps, rate-limit state,
  redacted operational errors, and connection/request metadata processed by
  Cloudflare. Select the closest current App Store Connect diagnostic/other-data
  categories during submission and do not mark these as tracking.
- User Content: messages, approvals, transcripts, and screen frames are
  processed transiently when the optional hosted route is used, but are not
  retained by the developer's control plane. Confirm the current App Store
  Connect definition of ephemeral processing when answering the collection
  question for the submitted build.
- Privacy policy URL:
  `https://github.com/jaywedgeworth22/BotFleet/blob/main/docs/ios-privacy.md`

The iOS app does not receive the hosted account's user ID or the computer's
hosted installation ID. Email sign-in for optional hosted access happens on the
companion computer, and local Wi-Fi and Tailscale pairing require no BotFleet
account. If the desktop user opts into **Use your phone anywhere**, Cloudflare
proxies the encrypted phone traffic to that user's computer. The computer
remains the only transcript store; the control plane does not receive a
persistent cloud copy.

Re-evaluate these answers and `PrivacyInfo.xcprivacy` before every upload,
especially if analytics, push delivery, or content retention is added, or if
the Sentry configuration in `SentryTelemetry.swift` changes what it captures.
