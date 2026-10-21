import Foundation

/// Pure native App Lock fixtures. The store is an actor in memory; no Keychain or backend is used.
@main
@MainActor
struct YoshAppLockTest {
    private static let originalPIN = "2468"
    private static let replacementPIN = "135790"

    static func main() async throws {
        let original = try validateVerifierAndEncoding()
        let offlineStore = FakeCredentialStore()
        await offlineStore.setLoadFailure(true)
        let offlineSession = YoshAppLock(store: offlineStore, developmentSession: true)
        await offlineSession.load()
        expect(offlineSession.isUnlocked && !offlineSession.enabled && offlineSession.loadSucceeded,
            "Explicit offline session must not access the supplied credential store")
        await validateFirstSetup()
        await validateSetupSaveFailure()
        await validateUnlockAndSettings(original)
        await validateFailedSettingsPreserveCredential(original)
        await validateLoadFailureAndRetry(original)
        await validateBusyReentry()
        print("Yosh App Lock passed: confirmed setup, PIN verification/change, persistent enablement, fail-closed storage, busy serialization and credential validation (fake store only)")
    }

    private static func validateVerifierAndEncoding() throws -> YoshAppLockCredential {
        let credential = try YoshPINVerifier.create(pin: originalPIN, digitCount: 4, enabled: true)
        try credential.validate()
        expect(credential.version == 1 && credential.enabled && credential.digitCount == 4)
        expect(credential.iterations >= 600_000 && credential.salt.count >= 16
            && credential.verifier.count == 32,
            "Persisted PIN verification must use a salted, expensive derivation")
        expect(try YoshPINVerifier.matches(pin: originalPIN, credential: credential))
        let wrongPINMatches = try YoshPINVerifier.matches(pin: "1357", credential: credential)
        expect(!wrongPINMatches, "A different valid PIN must not verify")
        let second = try YoshPINVerifier.create(pin: originalPIN, digitCount: 4, enabled: true)
        expect(second.salt != credential.salt && second.verifier != credential.verifier,
            "Creating the same PIN twice must use independent random salts")
        let sixDigits = try YoshPINVerifier.create(pin: replacementPIN, digitCount: 6, enabled: false)
        let sixDigitsMatch = try YoshPINVerifier.matches(pin: replacementPIN, credential: sixDigits)
        expect(sixDigitsMatch && !sixDigits.enabled && sixDigits.digitCount == 6)

        // Independently generated with Python hashlib.pbkdf2_hmac("sha256", ..., 600000).
        let knownVerifier: [UInt8] = [
            0x59, 0x45, 0x5b, 0x86, 0x59, 0x14, 0x9a, 0x4d,
            0xfa, 0x80, 0x59, 0x15, 0xb2, 0x4d, 0xf6, 0x25,
            0x00, 0xae, 0x5f, 0x6a, 0x5b, 0x63, 0xf7, 0x32,
            0x7d, 0x6a, 0x6f, 0x69, 0x5e, 0x60, 0x2c, 0x18,
        ]
        let known = YoshAppLockCredential(enabled: true, digitCount: 4, iterations: 600_000,
            salt: Data((0..<32).map(UInt8.init)), verifier: Data(knownVerifier))
        expect(try YoshPINVerifier.matches(pin: originalPIN, credential: known),
            "The native derivation must match an independent PBKDF2-HMAC-SHA256 vector")

        let encoded = try JSONEncoder().encode(credential)
        guard let object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] else {
            preconditionFailure("The credential must encode as a record")
        }
        expect(Set(object.keys) == ["version", "enabled", "digitCount", "iterations", "salt", "verifier"],
            "The persisted record must contain no plaintext PIN or candidate field")
        expect(object.values.allSatisfy { ($0 as? String) != originalPIN },
            "No persisted string may contain the plaintext PIN")
        expect(try JSONDecoder().decode(YoshAppLockCredential.self, from: encoded) == credential)
        expect(try YoshKeychainAppLockStore.decode(YoshKeychainAppLockStore.encode(credential)) == credential)
        for data in [Data(), Data("not a credential".utf8), Data(repeating: 0, count: 2_049)] {
            expectThrows("The store decoder must reject empty, corrupt and oversized records") {
                _ = try YoshKeychainAppLockStore.decode(data)
            }
        }

        for (pin, count) in [("12a4", 4), ("123", 4), ("12345", 4), ("１２３４", 4), ("1234", 6), ("12345", 5)] {
            expectThrows("Invalid PIN structure must be rejected before derivation") {
                _ = try YoshPINVerifier.create(pin: pin, digitCount: count, enabled: true)
            }
        }
        expectThrows("An invalid unlock input must not be accepted") {
            _ = try YoshPINVerifier.matches(pin: "12a4", credential: credential)
        }

        var corruptions: [YoshAppLockCredential] = []
        var invalid = credential
        invalid.version = 99; corruptions.append(invalid)
        invalid = credential; invalid.digitCount = 5; corruptions.append(invalid)
        invalid = credential; invalid.iterations = 1; corruptions.append(invalid)
        invalid = credential; invalid.iterations = 2_000_001; corruptions.append(invalid)
        invalid = credential; invalid.salt = Data(); corruptions.append(invalid)
        invalid = credential; invalid.verifier = Data(repeating: 0, count: 31); corruptions.append(invalid)
        for corrupt in corruptions {
            expectThrows("Corrupt credentials must be rejected before verification") {
                try corrupt.validate()
            }
            expectThrows("Verification must independently reject corrupt stored parameters") {
                _ = try YoshPINVerifier.matches(pin: originalPIN, credential: corrupt)
            }
            expectThrows("The store encoder must never persist a malformed record") {
                _ = try YoshKeychainAppLockStore.encode(corrupt)
            }
            expectThrows("The store decoder must validate untrusted persisted fields") {
                _ = try YoshKeychainAppLockStore.decode(JSONEncoder().encode(corrupt))
            }
        }
        return credential
    }

    private static func validateFirstSetup() async {
        let store = FakeCredentialStore()
        let lock = YoshAppLock(store: store)
        expect(lock.state == .loading)
        await lock.load()
        expect(lock.state == .locked && !lock.pinConfigured && lock.entryStep == .create
            && lock.digitCount == 4)
        let invalidAccepted = await lock.submitPIN("12a4")
        expect(!invalidAccepted && lock.state == .locked)
        lock.clearError()
        expect(lock.error == nil)
        let firstAccepted = await lock.submitPIN(originalPIN)
        expect(!firstAccepted && lock.entryStep == .confirm && !lock.pinConfigured
            && lock.state == .locked && !lock.isBusy)
        let pending = await store.snapshot()
        expect(pending.saveAttempts == 0 && pending.credential == nil,
            "The first setup entry must remain in memory until confirmation")
        let mismatchAccepted = await lock.submitPIN("1357")
        expect(!mismatchAccepted && lock.state == .locked && lock.error != nil)
        expect(await store.snapshot().saveAttempts == 0,
            "Mismatched confirmation must not write a credential")

        lock.restartSetup(pinLength: 6)
        expect(lock.entryStep == .create && lock.digitCount == 6 && !lock.pinConfigured)
        let restartedFirstAccepted = await lock.submitPIN(replacementPIN)
        expect(!restartedFirstAccepted && lock.entryStep == .confirm)
        let confirmed = await lock.submitPIN(replacementPIN)
        expect(confirmed && lock.state == .unlocked && lock.pinConfigured && lock.enabled
            && lock.digitCount == 6 && lock.error == nil)
        let saved = await store.snapshot()
        expect(saved.successfulSaves == 1 && saved.credential?.digitCount == 6)
        let cold = YoshAppLock(store: store)
        await cold.load()
        expect(cold.state == .locked && cold.entryStep == .unlock && cold.digitCount == 6,
            "A new process session must require the confirmed PIN when the lock is enabled")
        await lock.load()
        expect(lock.state == .unlocked,
            "A repeated load in an unlocked session must not relock the card")
    }

    private static func validateSetupSaveFailure() async {
        let store = FakeCredentialStore()
        let lock = YoshAppLock(store: store)
        await lock.load()
        _ = await lock.submitPIN(originalPIN)
        await store.setSaveFailure(true)
        let accepted = await lock.submitPIN(originalPIN)
        expect(!accepted && lock.state == .locked && !lock.pinConfigured && lock.error != nil,
            "Setup must fail closed if saving the confirmed credential fails")
        let failed = await store.snapshot()
        expect(failed.successfulSaves == 0 && failed.credential == nil)
        await store.setSaveFailure(false)
        lock.restartSetup(pinLength: 4)
        _ = await lock.submitPIN(originalPIN)
        let recovered = await lock.submitPIN(originalPIN)
        expect(recovered && lock.state == .unlocked && lock.pinConfigured,
            "Setup must recover after the storage problem is removed")
    }

    private static func validateUnlockAndSettings(_ original: YoshAppLockCredential) async {
        let store = FakeCredentialStore(credential: original)
        let lock = YoshAppLock(store: store)
        await lock.load()
        await lock.load()
        expect(lock.state == .locked && lock.pinConfigured && lock.enabled
            && lock.entryStep == .unlock)
        expect(await store.snapshot().loadAttempts == 1,
            "Repeated view loads must not reread and reset the cold session")
        let disabledWhileLocked = await lock.setEnabled(false)
        let changedWhileLocked = await lock.changePIN(replacementPIN, confirmation: replacementPIN, digitCount: 6)
        expect(!disabledWhileLocked && !changedWhileLocked && lock.state == .locked)
        expect(await store.snapshot().saveAttempts == 0,
            "Locked sessions must not change the App Lock configuration")
        lock.restartSetup(pinLength: 6)
        expect(lock.digitCount == 4 && lock.entryStep == .unlock,
            "An existing credential must never enter the first-time setup path")
        let wrong = await lock.submitPIN("1357")
        expect(!wrong && lock.state == .locked && lock.error != nil)
        let correct = await lock.submitPIN(originalPIN)
        expect(correct && lock.state == .unlocked && lock.error == nil)

        let mismatchedChange = await lock.changePIN(replacementPIN, confirmation: "246810", digitCount: 6)
        expect(!mismatchedChange && lock.digitCount == 4)
        expect(await store.snapshot().credential == original,
            "Changing a PIN requires matching confirmation and must preserve the old credential on failure")
        let changed = await lock.changePIN(replacementPIN, confirmation: replacementPIN, digitCount: 6)
        expect(changed && lock.state == .unlocked && lock.enabled && lock.digitCount == 6)
        let changedState = await store.snapshot()
        guard let replacement = changedState.credential else { preconditionFailure("Changed PIN was not saved") }
        let oldStillMatches = (try? YoshPINVerifier.matches(pin: originalPIN, credential: replacement)) ?? false
        let newMatches = (try? YoshPINVerifier.matches(pin: replacementPIN, credential: replacement)) ?? false
        expect(!oldStillMatches && newMatches, "Only the new PIN may verify after a successful change")

        let disabled = await lock.setEnabled(false)
        expect(disabled && !lock.enabled && lock.state == .unlocked)
        let disabledCold = YoshAppLock(store: store)
        await disabledCold.load()
        expect(disabledCold.state == .unlocked && disabledCold.pinConfigured && !disabledCold.enabled,
            "The persisted disabled setting must survive relaunch without discarding the credential")
        let changedDisabled = await disabledCold.changePIN(originalPIN, confirmation: originalPIN, digitCount: 4)
        expect(changedDisabled && !disabledCold.enabled,
            "Changing a disabled lock's PIN must preserve its disabled preference")
        let enabledAgain = await disabledCold.setEnabled(true)
        expect(enabledAgain && disabledCold.state == .unlocked && disabledCold.enabled)
        let enabledCold = YoshAppLock(store: store)
        await enabledCold.load()
        expect(enabledCold.state == .locked && enabledCold.enabled && enabledCold.digitCount == 4,
            "Re-enabling the lock must require verification on the next cold session")
        let unlockedAgain = await enabledCold.submitPIN(originalPIN)
        expect(unlockedAgain && enabledCold.state == .unlocked)
    }

    private static func validateFailedSettingsPreserveCredential(_ original: YoshAppLockCredential) async {
        let store = FakeCredentialStore(credential: original)
        let lock = YoshAppLock(store: store)
        await lock.load()
        _ = await lock.submitPIN(originalPIN)
        await store.setSaveFailure(true)
        let disabled = await lock.setEnabled(false)
        expect(!disabled && lock.enabled && lock.error != nil)
        let changed = await lock.changePIN(replacementPIN, confirmation: replacementPIN, digitCount: 6)
        expect(!changed && lock.digitCount == 4 && lock.enabled)
        expect(await store.snapshot().credential == original,
            "Failed settings writes must preserve the prior persistent verifier and enabled preference")
        let cold = YoshAppLock(store: store)
        await cold.load()
        expect(cold.state == .locked && cold.enabled)
        let oldWorks = await cold.submitPIN(originalPIN)
        expect(oldWorks, "The old PIN must remain valid after a failed replacement")
    }

    private static func validateLoadFailureAndRetry(_ original: YoshAppLockCredential) async {
        let store = FakeCredentialStore(credential: original)
        await store.setLoadFailure(true)
        let lock = YoshAppLock(store: store)
        await lock.load()
        expect(lock.state == .locked && lock.error != nil,
            "Unavailable storage must not be treated as an unconfigured or unlocked card")
        let bypassed = await lock.submitPIN(originalPIN)
        expect(!bypassed && lock.state == .locked)
        await store.setLoadFailure(false)
        await lock.load()
        expect(lock.state == .locked && lock.pinConfigured && lock.error == nil)
        let recovered = await lock.submitPIN(originalPIN)
        expect(recovered && lock.state == .unlocked,
            "A failed load must be retryable without erasing or recreating the stored PIN")

        var corrupt = original
        corrupt.iterations = 1
        let corruptStore = FakeCredentialStore(credential: corrupt)
        let corruptLock = YoshAppLock(store: corruptStore)
        await corruptLock.load()
        expect(corruptLock.state == .locked && corruptLock.error != nil,
            "The model must reject malformed records returned by a store")
        let corruptAccepted = await corruptLock.submitPIN(originalPIN)
        expect(!corruptAccepted && corruptLock.state == .locked)
        expect(await corruptStore.snapshot().saveAttempts == 0,
            "Corrupt storage must not silently trigger first-time setup or overwrite the record")
    }

    private static func validateBusyReentry() async {
        let store = FakeCredentialStore()
        let lock = YoshAppLock(store: store)
        await lock.load()
        _ = await lock.submitPIN(originalPIN)
        await store.holdSaves()
        let confirmation = Task { await lock.submitPIN(originalPIN) }
        do { try await store.waitUntilSaving() }
        catch { preconditionFailure("The confirmation did not reach the fake save gate") }
        expect(lock.isBusy && lock.state == .locked)
        let duplicate = await lock.submitPIN(originalPIN)
        let prematureChange = await lock.changePIN(replacementPIN, confirmation: replacementPIN, digitCount: 6)
        let prematureDisable = await lock.setEnabled(false)
        lock.restartSetup(pinLength: 6)
        expect(!duplicate && !prematureChange && !prematureDisable && lock.digitCount == 4)
        expect(await store.snapshot().saveAttempts == 1,
            "Concurrent requests must not cause a second write or replace the pending confirmed credential")
        await store.releaseSaves()
        let accepted = await confirmation.value
        expect(accepted && !lock.isBusy && lock.state == .unlocked && lock.digitCount == 4)
        expect(await store.snapshot().successfulSaves == 1)

        // The same guard must protect settings even when the session is already unlocked.
        await store.holdSaves()
        let disabling = Task { await lock.setEnabled(false) }
        do { try await store.waitUntilSaving() }
        catch { preconditionFailure("The settings update did not reach the fake save gate") }
        expect(lock.isBusy && lock.state == .unlocked)
        let overlappingEnable = await lock.setEnabled(true)
        let overlappingChange = await lock.changePIN(replacementPIN, confirmation: replacementPIN, digitCount: 6)
        expect(!overlappingEnable && !overlappingChange && lock.enabled && lock.digitCount == 4)
        expect(await store.snapshot().saveAttempts == 2,
            "An in-flight settings write must serialize other unlocked-session edits")
        await store.releaseSaves()
        let disabled = await disabling.value
        expect(disabled && !lock.enabled && !lock.isBusy)
        expect(await store.snapshot().successfulSaves == 2)
    }

    private static func expect(_ value: Bool, _ message: String = "",
                               file: StaticString = #file, line: UInt = #line) {
        precondition(value, message, file: file, line: line)
    }

    private static func expectThrows(_ message: String, _ operation: () throws -> Void) {
        var rejected = false
        do { try operation() } catch { rejected = true }
        expect(rejected, message)
    }

    private actor FakeCredentialStore: YoshAppLockStoring {
        struct Snapshot: Sendable {
            let credential: YoshAppLockCredential?
            let loadAttempts: Int
            let saveAttempts: Int
            let successfulSaves: Int
        }

        enum Failure: Error { case unavailable, saveGateTimeout, overlappingSave }
        private var credential: YoshAppLockCredential?
        private var loadAttempts = 0
        private var saveAttempts = 0
        private var successfulSaves = 0
        private var loadFails = false
        private var saveFails = false
        private var saveHeld = false
        private var saveContinuation: CheckedContinuation<Void, Never>?

        init(credential: YoshAppLockCredential? = nil) { self.credential = credential }

        func load() async throws -> YoshAppLockCredential? {
            loadAttempts += 1
            if loadFails { throw Failure.unavailable }
            return credential
        }

        func save(_ value: YoshAppLockCredential) async throws {
            saveAttempts += 1
            if saveHeld {
                guard saveContinuation == nil else { throw Failure.overlappingSave }
                await withCheckedContinuation { saveContinuation = $0 }
            }
            if saveFails { throw Failure.unavailable }
            credential = value
            successfulSaves += 1
        }

        func snapshot() -> Snapshot {
            Snapshot(credential: credential, loadAttempts: loadAttempts,
                saveAttempts: saveAttempts, successfulSaves: successfulSaves)
        }

        func setLoadFailure(_ value: Bool) { loadFails = value }
        func setSaveFailure(_ value: Bool) { saveFails = value }
        func holdSaves() { saveHeld = true }

        func waitUntilSaving() async throws {
            for _ in 0..<300 {
                if saveContinuation != nil { return }
                try await Task.sleep(for: .milliseconds(10))
            }
            throw Failure.saveGateTimeout
        }

        func releaseSaves() {
            saveHeld = false
            saveContinuation?.resume()
            saveContinuation = nil
        }
    }
}
