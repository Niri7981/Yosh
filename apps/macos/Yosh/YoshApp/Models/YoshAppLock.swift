import Foundation
import Observation

/// Gates native account surfaces only. It never authorizes payments or changes backend identity.
@MainActor
@Observable
final class YoshAppLock {
    enum State: Equatable { case loading, locked, unlocked }
    enum EntryStep: Equatable { case create, confirm, unlock }

    private(set) var state: State = .loading
    private(set) var entryStep: EntryStep = .create
    private(set) var pinConfigured = false
    private(set) var enabled = true
    private(set) var digitCount: Int
    private(set) var isBusy = false
    private(set) var error: String?
    private(set) var loadSucceeded = false

    @ObservationIgnored private let store: any YoshAppLockStoring
    @ObservationIgnored private var credential: YoshAppLockCredential?
    // Confirmation retains a verifier in memory, never the first plaintext PIN.
    @ObservationIgnored private var pendingCredential: YoshAppLockCredential?

    var isUnlocked: Bool { state == .unlocked }
    var canEnterPIN: Bool { loadSucceeded && state == .locked && !isBusy }

    init(store: any YoshAppLockStoring = YoshKeychainAppLockStore(), pinLength: Int = 4, developmentSession: Bool = false) {
        precondition(pinLength == 4 || pinLength == 6)
        self.store = store
        digitCount = pinLength
        if developmentSession {
            state = .unlocked
            enabled = false
            loadSucceeded = true
        }
    }

    func load() async {
        // Reopening a window and ordinary navigation preserve this process's unlocked session.
        guard !loadSucceeded, !isBusy else { return }
        isBusy = true
        error = nil
        defer { isBusy = false }
        do {
            let saved = try await store.load()
            try saved?.validate()
            credential = saved
            pinConfigured = saved != nil
            if let saved {
                digitCount = saved.digitCount
                enabled = saved.enabled
                entryStep = .unlock
                state = saved.enabled ? .locked : .unlocked
            } else {
                enabled = true
                entryStep = .create
                state = .locked
            }
            loadSucceeded = true
        } catch {
            // A denied or damaged Keychain item is never treated as an unconfigured lock.
            state = .locked
            self.error = "App Lock could not be read. Try again."
        }
    }

    /// Returns true only after verification (and, for setup, a successful Keychain write).
    func submitPIN(_ pin: String) async -> Bool {
        guard canEnterPIN else { return false }
        guard validPIN(pin, length: digitCount) else {
            error = "Enter a \(digitCount)-digit PIN."
            return false
        }
        isBusy = true
        error = nil
        defer { isBusy = false }
        do {
            switch entryStep {
            case .create:
                let length = digitCount
                pendingCredential = try await Task.detached(priority: .userInitiated) {
                    try YoshPINVerifier.create(pin: pin, digitCount: length)
                }.value
                entryStep = .confirm
                return false
            case .confirm:
                guard let pending = pendingCredential else {
                    entryStep = .create
                    return false
                }
                let matches = try await Task.detached(priority: .userInitiated) {
                    try YoshPINVerifier.matches(pin: pin, credential: pending)
                }.value
                guard matches else {
                    error = "PINs do not match. Try again."
                    return false
                }
                try await store.save(pending)
                credential = pending
                pendingCredential = nil
                pinConfigured = true
                enabled = pending.enabled
                entryStep = .unlock
                state = .unlocked
                return true
            case .unlock:
                guard let saved = credential else { return false }
                let matches = try await Task.detached(priority: .userInitiated) {
                    try YoshPINVerifier.matches(pin: pin, credential: saved)
                }.value
                guard matches else {
                    error = "Incorrect PIN. Try again."
                    return false
                }
                state = .unlocked
                return true
            }
        } catch {
            self.error = "App Lock could not be updated. Try again."
            return false
        }
    }

    func restartSetup(pinLength: Int) {
        guard loadSucceeded, !pinConfigured, !isBusy, pinLength == 4 || pinLength == 6 else { return }
        digitCount = pinLength
        pendingCredential = nil
        entryStep = .create
        error = nil
    }

    func changePIN(_ pin: String, confirmation: String, digitCount: Int) async -> Bool {
        guard isUnlocked, pinConfigured, !isBusy else { return false }
        guard (digitCount == 4 || digitCount == 6), validPIN(pin, length: digitCount),
              validPIN(confirmation, length: digitCount) else {
            error = "Enter and confirm a four- or six-digit PIN."
            return false
        }
        isBusy = true
        error = nil
        defer { isBusy = false }
        let remainsEnabled = enabled
        do {
            let replacement = try await Task.detached(priority: .userInitiated) {
                let value = try YoshPINVerifier.create(pin: pin, digitCount: digitCount, enabled: remainsEnabled)
                guard try YoshPINVerifier.matches(pin: confirmation, credential: value) else { return nil as YoshAppLockCredential? }
                return value
            }.value
            guard let replacement else {
                error = "PINs do not match. Try again."
                return false
            }
            try await store.save(replacement)
            credential = replacement
            self.digitCount = replacement.digitCount
            return true
        } catch {
            self.error = "The PIN could not be changed. Try again."
            return false
        }
    }

    func setEnabled(_ newValue: Bool) async -> Bool {
        guard isUnlocked, pinConfigured, !isBusy, var saved = credential else { return false }
        guard newValue != enabled else { return true }
        isBusy = true
        error = nil
        defer { isBusy = false }
        saved.enabled = newValue
        do {
            // Keep the existing verifier when disabled; enabling never creates a default PIN.
            try await store.save(saved)
            credential = saved
            enabled = newValue
            return true
        } catch {
            self.error = "App Lock could not be updated. Try again."
            return false
        }
    }

    func clearError() { error = nil }

    private func validPIN(_ pin: String, length: Int) -> Bool {
        pin.utf8.count == length && pin.utf8.allSatisfy { (48...57).contains($0) }
    }
}
