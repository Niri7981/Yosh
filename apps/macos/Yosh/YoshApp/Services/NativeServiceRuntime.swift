import Darwin
import Foundation
import os

enum ServiceRuntimeError: Error, Equatable {
    case configuration
    case portConflict
    case authenticatedShutdownFailed
    case authenticatedShutdownTimedOut
    case authenticationFailed
    case credentialUnavailable
    case requestTimedOut
    case responseTooLarge
    case cannotStart
    case notReady
    case processExited
    case dataDirectoryInUse
    case restartLimitReached
    case unavailable
    case environmentBusy
}

enum ServiceStartupPhase: String, Sendable {
    case spawning, httpAvailable, managementAuthenticated, coreReady
}
enum WalletStartupPhase: String, Decodable, Sendable {
    case walletChecking, walletAvailable, walletUnavailable
}
enum RecoveryStartupPhase: String, Decodable, Sendable {
    case recoveryPending, recoveryRunning, recoveryComplete
}
struct NativeServiceStatus: Sendable {
    let phase: ServiceStartupPhase
    let wallet: WalletStartupPhase
    let recovery: RecoveryStartupPhase
    let pid: Int32?
    let failure: ServiceRuntimeError?
}

extension Notification.Name {
    static let nativeServiceExited = Notification.Name("Yosh.nativeServiceExited")
    static let nativeServiceReady = Notification.Name("Yosh.nativeServiceReady")
}

/// Only a backend authenticated with this installation's management identity may be stopped.
actor NativeServiceRuntime {
    private let launch: BackendLaunchConfiguration
    private let allowsLaunch: Bool
    private let sandboxProfileOverride: URL?
    private let managementTokenOverride: String?
    private let managementTokenLoader: (@Sendable () throws -> String)?
    private let logger = Logger(subsystem: "com.yosh.macos", category: "backend-lifecycle")
    private let diagnostics: BackendDiagnostics?
    private var phase: ServiceStartupPhase = .spawning
    private var walletPhase: WalletStartupPhase = .walletChecking
    private var recoveryPhase: RecoveryStartupPhase = .recoveryPending
    private var restartHistory: [Date] = []
    private var restartTask: Task<Void, Never>?
    private var monitoring: Task<Void, Never>?
    private var readinessObservation: Task<Void, Never>?
    private var process: BackendChildProcess?
    private var ownedConfiguration: ServiceConfiguration?
    private var readyConfiguration: ServiceConfiguration?
    private var loadedManagementToken: String?
    private var credentialRetryAfter: Date?
    private var startup: Task<ServiceConfiguration, Error>?
    private var lastFailure: ServiceRuntimeError?
    private var isShuttingDown = false
    private var switchingEnvironment = false

    init(
        allowsLaunch: Bool = true,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        bundleURL: URL = Bundle.main.bundleURL,
        managementTokenOverride: String? = nil,
        managementTokenLoader: (@Sendable () throws -> String)? = nil,
        diagnosticsDirectory: URL? = nil,
        developmentHome: URL? = nil,
        sandboxProfileOverride: URL? = nil
    ) {
        self.allowsLaunch = allowsLaunch
        self.sandboxProfileOverride = sandboxProfileOverride
        var launch = BackendLaunchConfiguration(environment: environment, bundleURL: bundleURL)
        if let developmentHome { launch.developmentHome = developmentHome }
        self.launch = launch
        self.managementTokenOverride = managementTokenOverride
        self.managementTokenLoader = managementTokenLoader
        do {
            let directory = try diagnosticsDirectory ?? (launch.isPayDevelopment ? launch.dataDirectory().appending(path: "Logs") : nil)
            self.diagnostics = try BackendDiagnostics(directory: directory)
        }
        catch {
            self.diagnostics = nil
            Logger(subsystem: "com.yosh.macos", category: "backend-lifecycle")
                .error("Private backend diagnostics unavailable")
        }
    }

    func status() -> NativeServiceStatus {
        NativeServiceStatus(phase: phase, wallet: walletPhase, recovery: recoveryPhase,
            pid: process?.isRunning == true ? process?.processIdentifier : nil, failure: lastFailure)
    }

    func developmentEnvironment() throws -> PayDevelopmentSelection? {
        guard launch.isPayDevelopment else { return nil }
        return try YoshPayDevelopment.selection(directory: launch.developmentRoot())
    }

    func switchDevelopmentEnvironment(_ selection: PayDevelopmentSelection) async throws {
        guard launch.isPayDevelopment, !switchingEnvironment else { throw ServiceRuntimeError.configuration }
        switchingEnvironment = true
        defer { switchingEnvironment = false }
        try selection.validate()
        let directory = try launch.developmentRoot()
        if try YoshPayDevelopment.selection(directory: directory) == selection { return }
        let configuration = try await ready()
        let (_, response) = try await configuration.request(.prepareEnvironmentSwitch)
        guard response.statusCode == 200 else { throw ServiceRuntimeError.environmentBusy }
        guard await shutdown() else { throw ServiceRuntimeError.authenticatedShutdownFailed }
        // The old process has drained and exited before selecting a new store.
        // Tokens, liveness and loaded financial UI must never cross environments.
        readyConfiguration = nil; ownedConfiguration = nil; loadedManagementToken = nil
        credentialRetryAfter = nil; lastFailure = nil; restartHistory = []
        defer { isShuttingDown = false }
        do { try YoshPayDevelopment.saveSelection(selection, directory: directory) }
        catch { isShuttingDown = false; _ = try? await ready(); throw error }
        isShuttingDown = false
        _ = try await ready()
    }

    func ready(retry: Bool = false) async throws -> ServiceConfiguration {
        if isShuttingDown { throw ServiceRuntimeError.unavailable }
        if retry && process == nil { readyConfiguration = nil }
        if let readyConfiguration {
            if process == nil || process?.isRunning == true { return readyConfiguration }
            self.readyConfiguration = nil
            lastFailure = nil
        }
        if retry { lastFailure = nil; restartHistory = []; credentialRetryAfter = nil }
        if let lastFailure { throw lastFailure }
        if let startup { return try await startup.value }
        // UI polling shares the scheduled recovery instead of bypassing backoff.
        if let restartTask {
            await restartTask.value
            return try await ready()
        }

        let task = Task { try await start() }
        startup = task
        do {
            let configuration = try await task.value
            guard process == nil || process?.isRunning == true else { throw ServiceRuntimeError.processExited }
            readyConfiguration = configuration
            startup = nil
            await MainActor.run { NotificationCenter.default.post(name: .nativeServiceReady, object: nil) }
            return configuration
        } catch {
            startup = nil
            if let failure = error as? ServiceRuntimeError,
               [.configuration, .portConflict, .authenticationFailed, .dataDirectoryInUse, .restartLimitReached].contains(failure) {
                lastFailure = failure
                restartTask?.cancel()
                restartTask = nil
            }
            if (error as? ServiceRuntimeError) == .notReady { scheduleReadinessObservation() }
            logger.error("Backend startup failed: \(String(describing: error), privacy: .public)")
            throw error
        }
    }

    private func start() async throws -> ServiceConfiguration {
        // Previews and diagnostic fixtures must supply their own identity instead
        // of requesting access to the installation's Keychain item.
        guard allowsLaunch || managementTokenOverride != nil else { throw ServiceRuntimeError.unavailable }
        let port = try launch.servicePort()
        // Validate the current runtime before asking an old backend to stop.
        _ = try launch.normalizedEnvironment()
        let runtime = allowsLaunch ? try launch.runtimeDirectory() : nil
        let root = runtime?.appending(path: "backend", directoryHint: .isDirectory)
        let node = allowsLaunch ? try launch.nodeExecutable() : nil
        let dataDirectory = try launch.dataDirectory().path
        let server = root?.appending(path: "server.js")
        if allowsLaunch, let root, let server,
           (!FileManager.default.fileExists(atPath: server.path) ||
            !FileManager.default.fileExists(atPath: root.appending(path: ".next/BUILD_ID").path)) {
            throw ServiceRuntimeError.configuration
        }
        let token = try managementToken()
        let configuration = ServiceConfiguration(baseURL: URL(string: "http://127.0.0.1:\(port)")!, managementToken: token)

        if process?.isRunning != true && !Self.portAvailable(port) {
            let response: (Data, HTTPURLResponse)
            do { response = try await configuration.request(.health, timeout: 2) }
            catch {
                diagnostics?.record("takeover", code: "UNVERIFIED_LISTENER")
                throw ServiceRuntimeError.portConflict
            }
            guard [200, 503].contains(response.1.statusCode), response.0.count <= 4096,
                  let identity = try? JSONDecoder().decode(BackendHealth.self, from: response.0),
                  identity.matchesTakeover(directory: dataDirectory) else {
                logger.error("Unverified listener occupies backend port \(port, privacy: .public)")
                diagnostics?.record("takeover", code: "IDENTITY_MISMATCH")
                throw ServiceRuntimeError.portConflict
            }
            if !allowsLaunch { return configuration } // The CLI management smoke test only reads a fixture.
            logger.notice("Authenticated stale backend detected, PID \(identity.pid, privacy: .public)")
            try await stopAuthenticatedBackend(configuration, pid: identity.pid, port: port)
            logger.notice("Authenticated stale backend stopped, PID \(identity.pid, privacy: .public)")
        }
        guard allowsLaunch, let root, let server, let node else { throw ServiceRuntimeError.unavailable }

        let child: BackendChildProcess
        if let existing = process, existing.isRunning { child = existing }
        else {
            child = BackendChildProcess(node: node, server: server, root: root,
                environment: try launch.childEnvironment(token: token), diagnostics: try diagnostics ?? BackendDiagnostics(), sandboxProfile: try sandboxProfileOverride ?? launch.sandboxProfile()) { [weak self] pid, status in
                Task { await self?.ownedProcessExited(pid: pid, status: status) }
            }
            try child.run()
            process = child
            phase = .spawning
            diagnostics?.record(phase.rawValue, pid: child.processIdentifier)
            logger.notice("Backend spawned, PID \(child.processIdentifier, privacy: .public)")
        }

        let beginning = ContinuousClock.now
        // Slow Keychain, RPC or recovery work is outside core readiness. A living,
        // progressing child is retained even if observation eventually times out.
        let hardDeadline = beginning.advanced(by: .seconds(90))
        var deadline = beginning.advanced(by: .seconds(45))
        while ContinuousClock.now < deadline {
            if !child.isRunning {
                throw Self.portAvailable(port) ? ServiceRuntimeError.processExited : ServiceRuntimeError.portConflict
            }
            do {
                let (data, response) = try await configuration.request(.health, timeout: 2)
                if phase == .spawning {
                    phase = .httpAvailable
                    deadline = min(hardDeadline, ContinuousClock.now.advanced(by: .seconds(45)))
                    diagnostics?.record(phase.rawValue, pid: child.processIdentifier)
                }
                if response.statusCode == 401 {
                    diagnostics?.record("probe", pid: child.processIdentifier, code: "AUTHENTICATION_FAILED")
                    throw ServiceRuntimeError.authenticationFailed
                }
                if phase == .httpAvailable {
                    phase = .managementAuthenticated
                    diagnostics?.record(phase.rawValue, pid: child.processIdentifier)
                }
                let identity = try? JSONDecoder().decode(BackendHealth.self, from: data)
                if let identity {
                    guard identity.matchesIdentity(pid: child.processIdentifier, directory: dataDirectory) else {
                        diagnostics?.record("probe", pid: child.processIdentifier, code: "IDENTITY_MISMATCH")
                        throw ServiceRuntimeError.portConflict
                    }
                    ownedConfiguration = configuration
                }
                if response.statusCode == 503,
                   (try? JSONDecoder().decode(ServiceErrorResponse.self, from: data).code) == "DATA_DIRECTORY_IN_USE" {
                    diagnostics?.record("probe", pid: child.processIdentifier, code: "DATA_DIRECTORY_IN_USE")
                    throw ServiceRuntimeError.dataDirectoryInUse
                }
                if response.statusCode == 503,
                   (try? JSONDecoder().decode(ServiceErrorResponse.self, from: data).code) == "CORE_CONFIGURATION_INVALID" {
                    diagnostics?.record("probe", pid: child.processIdentifier, code: "CORE_CONFIGURATION_INVALID")
                    throw ServiceRuntimeError.configuration
                }
                if response.statusCode == 200, data.count <= 4096,
                   let identity,
                   identity.matchesNewChild(pid: child.processIdentifier, directory: dataDirectory) {
                    ownedConfiguration = configuration
                    phase = .coreReady
                    walletPhase = identity.wallet ?? .walletChecking
                    recoveryPhase = identity.recovery ?? .recoveryPending
                    diagnostics?.record(phase.rawValue, pid: child.processIdentifier,
                        elapsed: Int(beginning.duration(to: ContinuousClock.now).components.seconds) * 1000)
                    logger.notice("Backend ready, PID \(identity.pid, privacy: .public)")
                    startMonitoring(configuration, pid: identity.pid, directory: dataDirectory)
                    return configuration
                }
                diagnostics?.record("probe", pid: child.processIdentifier, code: "HTTP_\(response.statusCode)")
            } catch let failure as ServiceRuntimeError where failure == .authenticationFailed || failure == .dataDirectoryInUse || failure == .configuration || failure == .portConflict {
                diagnostics?.record("probeRejected", pid: child.processIdentifier, code: "IDENTITY_OR_CONFIGURATION_FAILURE")
                throw failure
            } catch {
                let code: String
                if let failure = error as? ServiceRuntimeError {
                    switch failure {
                    case .requestTimedOut: code = "REQUEST_TIMEOUT"
                    case .responseTooLarge: code = "RESPONSE_TOO_LARGE"
                    default: code = "HTTP_UNAVAILABLE"
                    }
                } else { code = "HTTP_UNAVAILABLE" }
                diagnostics?.record("probe", pid: child.processIdentifier, code: code)
            }
            try await Task.sleep(for: beginning.duration(to: ContinuousClock.now) < .seconds(5) ? .milliseconds(250) : .seconds(1))
        }
        diagnostics?.record("observationTimedOut", pid: child.processIdentifier, code: "CORE_NOT_READY")
        throw ServiceRuntimeError.notReady
    }

    private func managementToken() throws -> String {
        if let loadedManagementToken { return loadedManagementToken }
        if let credentialRetryAfter, credentialRetryAfter > Date() {
            throw ServiceRuntimeError.credentialUnavailable
        }
        let token: String
        do { token = try managementTokenOverride ?? managementTokenLoader?() ?? launch.managementToken() }
        catch {
            credentialRetryAfter = Date().addingTimeInterval(30)
            diagnostics?.record("keychain", code: "MANAGEMENT_CREDENTIAL_UNAVAILABLE")
            throw ServiceRuntimeError.credentialUnavailable
        }
        guard launch.validToken(token) else { throw ServiceRuntimeError.configuration }
        // Backend retries/restarts reuse the same installation identity. Cache
        // only validated success; denied Keychain access remains retryable.
        loadedManagementToken = token
        return token
    }

    private func stopAuthenticatedBackend(_ configuration: ServiceConfiguration, pid: Int32, port: Int) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(30))
        logger.notice("Requesting graceful shutdown, PID \(pid, privacy: .public)")
        let response: (Data, HTTPURLResponse)?
        do { response = try await configuration.request(.shutdown, timeout: 15) }
        catch {
            diagnostics?.record("shutdown", pid: pid, code: "RESPONSE_UNAVAILABLE")
            response = nil
        }
        if let response,
           (response.1.statusCode != 200 || response.0.count > 4096 ||
            (try? JSONDecoder().decode(ReadyResponse.self, from: response.0).ready) != true) {
            logger.error("Authenticated backend rejected shutdown, PID \(pid, privacy: .public)")
            throw ServiceRuntimeError.authenticatedShutdownFailed
        }
        while ContinuousClock.now < deadline {
            if !Self.pidExists(pid) && Self.portAvailable(port) { return }
            try? await Task.sleep(for: .milliseconds(100))
        }
        logger.error("Authenticated backend shutdown timed out, PID \(pid, privacy: .public)")
        throw ServiceRuntimeError.authenticatedShutdownTimedOut
    }

    private func ownedProcessExited(pid: Int32, status: Int32) async {
        logger.notice("Backend exited, PID \(pid, privacy: .public), status \(status, privacy: .public)")
        guard process?.processIdentifier == pid else { return }
        monitoring?.cancel()
        monitoring = nil
        readinessObservation?.cancel()
        readinessObservation = nil
        process = nil
        ownedConfiguration = nil
        readyConfiguration = nil
        diagnostics?.record("processExited", pid: pid, code: "EXIT_\(status)")
        if !isShuttingDown {
            phase = .spawning
            walletPhase = .walletChecking
            recoveryPhase = .recoveryPending
            await MainActor.run { NotificationCenter.default.post(name: .nativeServiceExited, object: nil) }
            if lastFailure == nil { scheduleRestart() }
        }
    }

    private func scheduleReadinessObservation() {
        guard readinessObservation == nil, process?.isRunning == true, !isShuttingDown, lastFailure == nil else { return }
        readinessObservation = Task {
            do { try await Task.sleep(for: .seconds(5)) } catch { return }
            readinessObservation = nil
            guard process?.isRunning == true, !isShuttingDown, lastFailure == nil else { return }
            do { _ = try await ready() }
            catch { diagnostics?.record("observation", code: "READINESS_UNAVAILABLE") }
        }
    }

    private func scheduleRestart() {
        guard restartTask == nil, !isShuttingDown else { return }
        let now = Date()
        restartHistory = restartHistory.filter { now.timeIntervalSince($0) < 300 }
        guard restartHistory.count < 5 else {
            diagnostics?.record("restartStopped", code: "RESTART_LIMIT")
            lastFailure = .restartLimitReached
            return
        }
        restartHistory.append(now)
        let attempt = restartHistory.count
        diagnostics?.record("restartScheduled", code: "PROCESS_EXITED", attempt: attempt)
        restartTask = Task {
            try? await Task.sleep(for: .seconds(min(16, 1 << (attempt - 1))))
            while startup != nil && !Task.isCancelled { try? await Task.sleep(for: .milliseconds(200)) }
            restartTask = nil
            guard !Task.isCancelled, !isShuttingDown, process == nil, lastFailure == nil else { return }
            do { _ = try await ready() }
            catch { diagnostics?.record("restartFailed", code: "STARTUP_FAILED", attempt: attempt) }
        }
    }

    private func startMonitoring(_ configuration: ServiceConfiguration, pid: Int32, directory: String) {
        monitoring?.cancel()
        monitoring = Task {
            while !Task.isCancelled && !isShuttingDown && process?.processIdentifier == pid {
                do {
                    try await Task.sleep(for: .seconds(5))
                    let (body, response) = try await configuration.request(.health, timeout: 2)
                    let identity = try JSONDecoder().decode(BackendHealth.self, from: body)
                    guard response.statusCode == 200, identity.matchesNewChild(pid: pid, directory: directory) else {
                        diagnostics?.record("supervision", pid: pid, code: "CORE_UNAVAILABLE")
                        continue
                    }
                    let wallet = identity.wallet ?? .walletChecking
                    let recovery = identity.recovery ?? .recoveryPending
                    if wallet != walletPhase { diagnostics?.record(wallet.rawValue, pid: pid) }
                    if recovery != recoveryPhase { diagnostics?.record(recovery.rawValue, pid: pid) }
                    walletPhase = wallet
                    recoveryPhase = recovery
                } catch is CancellationError { return }
                catch {
                    diagnostics?.record("supervision", pid: pid, code: "HEALTH_UNAVAILABLE")
                }
            }
        }
    }

    /// False keeps the native App alive so it cannot silently abandon an active signer.
    func shutdown() async -> Bool {
        isShuttingDown = true
        monitoring?.cancel()
        monitoring = nil
        readinessObservation?.cancel()
        readinessObservation = nil
        restartTask?.cancel()
        restartTask = nil
        let startupDeadline = ContinuousClock.now.advanced(by: .seconds(45))
        while startup != nil && ContinuousClock.now < startupDeadline {
            try? await Task.sleep(for: .milliseconds(100))
        }
        if startup != nil {
            logger.error("Backend startup did not settle before native quit timeout")
            isShuttingDown = false
            return false
        }
        guard let child = process, child.isRunning else { return true }
        guard let configuration = ownedConfiguration else {
            logger.error("Backend quit could not verify ownership, PID \(child.processIdentifier, privacy: .public)")
            isShuttingDown = false
            return false
        }
        do {
            try await stopAuthenticatedBackend(configuration, pid: child.processIdentifier, port: try launch.servicePort())
            process = nil
            ownedConfiguration = nil
            readyConfiguration = nil
            return true
        } catch {
            logger.error("Backend quit failed: \(String(describing: error), privacy: .public)")
            isShuttingDown = false
            return false
        }
    }

    private static func pidExists(_ pid: Int32) -> Bool {
        Darwin.kill(pid, 0) == 0 || errno == EPERM
    }

    private static func portAvailable(_ port: Int) -> Bool {
        let descriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }
        defer { Darwin.close(descriptor) }
        var reuse: Int32 = 1
        _ = withUnsafePointer(to: &reuse) {
            Darwin.setsockopt(descriptor, SOL_SOCKET, SO_REUSEADDR, $0, socklen_t(MemoryLayout<Int32>.size))
        }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(port).bigEndian
        address.sin_addr = in_addr(s_addr: in_addr_t(0x7f000001).bigEndian)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
            }
        }
        return bound && Darwin.listen(descriptor, 1) == 0
    }
}

struct BackendHealth: Decodable {
    let ready: Bool
    let service: String
    let pid: Int32
    let dataDirectory: String
    let coreReady: Bool?
    let wallet: WalletStartupPhase?
    let recovery: RecoveryStartupPhase?

    init(ready: Bool, service: String, pid: Int32, dataDirectory: String,
         coreReady: Bool? = nil, wallet: WalletStartupPhase? = nil, recovery: RecoveryStartupPhase? = nil) {
        self.ready = ready
        self.service = service
        self.pid = pid
        self.dataDirectory = dataDirectory
        self.coreReady = coreReady
        self.wallet = wallet
        self.recovery = recovery
    }

    // Callers only decode these facts after request/response HMAC and nonce verification.
    // The legacy service name is permitted solely for identifying an existing backend.
    func matchesTakeover(directory: String) -> Bool {
        ((service == "Yosh" && (ready || coreReady != nil)) || (service == "2049" && ready))
            && pid > 0 && dataDirectory == directory
    }

    func matchesNewChild(pid expectedPID: Int32, directory: String) -> Bool {
        ready && coreReady == true && matchesIdentity(pid: expectedPID, directory: directory)
    }

    func matchesIdentity(pid expectedPID: Int32, directory: String) -> Bool {
        service == "Yosh" && pid > 0 && pid == expectedPID && dataDirectory == directory
    }
}

private struct ServiceErrorResponse: Decodable {
    let code: String
}
