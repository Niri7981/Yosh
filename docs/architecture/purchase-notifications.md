# Purchase notifications

macOS `UserNotifications` presents a local notification after a backend-confirmed Paid or definitive Unpaid outcome. The Settings → General switch defaults off and requests `.alert` permission only when enabled. macOS controls banner delivery; Focus and system notification settings can suppress banners.

The body is `Agent · API name · price × quantity · Paid/Unpaid`. Each current SpendIntent buys one API request, so the backend supplies quantity `1`. This feature does not infer batch quantities, count retries, or change the purchase contract. Devnet amounts carry `Test`; simulated records do not generate Paid notices. Payment confirmation remains distinct from delivery completion. Unknown payments and approvals awaiting execution do not produce Unpaid notices.

The authenticated read-only `/api/app/notifications?after=...` feed scans at most 50 existing ledger events per page and returns a whitelisted DTO, with no payload, delivery content, key or wallet secret. It covers every Agent. An omitted cursor establishes a baseline; existing records are not replayed on first enable. A store identity and persistent native cursors separate environments. Native delivery identifiers bind store, purchase and outcome; failed OS scheduling retries without advancing the cursor. macOS-delivered identifiers prevent re-alerting an existing notification if a crash occurs between OS acceptance and cursor persistence. This is best-effort local notification delivery, not a transactional exactly-once guarantee across macOS and SQLite.

The monitor belongs to the app lifecycle and survives hiding the window. Quit cancels monitoring before the existing graceful backend shutdown. Notifications never create payment, approval, grant or retry actions. A disabled switch stops new notifications; it does not remove already delivered notifications from Notification Center.

## Manual acceptance

The independently identified notification preview uses new Offline-only storage, ports and preferences, with no copied wallet, Keychain item, Grant or Ledger. Only this preview exposes **Send test notification**. Its example content explicitly says `Test`; it is OS presentation evidence only, not purchase or on-chain evidence. Native permission requests and banner acceptance are performed by the user. No Computer Use is needed.

The existing installed backend source baseline can be reconstructed from its signed source manifest; the notification preview adds only the read-only ledger method and management route to that baseline. Dependency source labels may differ in bundled JS because the reconstruction uses a shared dependency directory. No payment execution changes are included in this backend overlay.

## 2026-11-04 formal delivery verification

The formal `/Users/irin/Applications/Yosh.app` was updated through the existing stable installer after normal App/backend shutdown. The staged artifact changes only the native executable, the read-only backend notification overlay, and source provenance/signature records. The installed bundle matches staging and passes deep strict signature verification. Its App and backend run from the installed bundle; current lifecycle records report authenticated management and core readiness on loopback port 13449. Actual signed baseline and cursor reads verify response proofs; unsigned access returns 401. These read-only checks do not request a purchase or establish banner-display acceptance.

Validation: 99 backend regression tests, four notification tests against the reconstructed installed backend baseline, native notification lifecycle/format tests, and the native signed-query transport fixture pass. Typecheck, lint, production backend build and macOS Release builds pass. Native permission and banner display remain under the user's macOS notification settings; formal and preview preferences/permissions are separate.

### Native switch visual-state regression

A native switch fixture reproduced the control appearing Off after an On click while the asynchronous OS authorization callback was pending: the Binding getter retained its old value until authorization returned. The UI now records the permission-request state synchronously, shows the switch On while waiting, and settles to the actual enabled result. Existing system permission is read before requesting again. This changes control-state synchronization, not purchase outcome classification or notification delivery. Native control tests cover pending authorization, grant, persisted On, Off and re-enabling with existing permission; the lifecycle and signed-transport regressions still pass.
