import Foundation
import Darwin

/// Operational facts only. Child output is classified, never persisted verbatim.
final class BackendDiagnostics: @unchecked Sendable {
    private let lock = NSLock()
    private let directory: URL
    private let log: URL

    init(directory override: URL? = nil) throws {
        directory = override ?? FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Application Support/Yosh/Logs", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else {
            throw ServiceRuntimeError.configuration
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        log = directory.appending(path: "backend-lifecycle.jsonl")
    }

    func record(_ phase: String, pid: Int32 = 0, code: String = "none", elapsed: Int = 0, attempt: Int = 0) {
        lock.lock()
        defer { lock.unlock() }
        // Callers supply fixed phase/error labels, never backend text or credentials.
        let value: [String: Any] = ["time": ISO8601DateFormatter().string(from: Date()),
            "phase": phase, "pid": pid, "code": code, "elapsedMs": elapsed, "attempt": attempt]
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let line = String(data: data, encoding: .utf8) else { return }
        if let size = try? FileManager.default.attributesOfItem(atPath: log.path)[.size] as? NSNumber,
           size.intValue > 1_000_000 {
            let old = directory.appending(path: "backend-lifecycle.previous.jsonl")
            try? FileManager.default.removeItem(at: old)
            try? FileManager.default.moveItem(at: log, to: old)
        }
        let descriptor = Darwin.open(log.path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { return }
        defer { Darwin.close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_uid == getuid(),
              (info.st_mode & S_IFMT) == S_IFREG, fchmod(descriptor, 0o600) == 0 else { return }
        let bytes = Array((line + "\n").utf8)
        _ = bytes.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress, bytes.count) }
    }

    func classify(_ data: Data, pid: Int32) {
        guard let output = String(data: data.prefix(8192), encoding: .utf8)?.lowercased() else { return }
        if let range = output.range(of: "yosh_pay_dev_startup_failed:[a-z][a-z0-9_]{2,80}", options: .regularExpression),
           let code = output[range].split(separator: ":").last {
            record("startupRejected", pid: pid, code: code.uppercased())
        }
        let codes: [(String, String)] = [
            ("eaddrinuse", "PORT_IN_USE"), ("data_directory_in_use", "DATA_DIRECTORY_IN_USE"),
            ("sqlit", "DATABASE_ERROR"), ("module_not_found", "MISSING_RUNTIME_MODULE"),
            ("cannot find module", "MISSING_RUNTIME_MODULE"), ("permission denied", "FILE_PERMISSION"),
            ("eacces", "FILE_PERMISSION"), ("invalid_payment_environment", "PAYMENT_CONFIGURATION"),
            ("configuration_conflict", "CONFIGURATION_CONFLICT"),
            ("core_configuration_invalid", "CORE_CONFIGURATION_INVALID"),
            ("core_initialization_failed", "CORE_INITIALIZATION_FAILED"),
        ]
        for (needle, code) in codes where output.contains(needle) { record("childOutput", pid: pid, code: code) }
    }
}

/// Owns the child process mechanics; NativeServiceRuntime decides when it is safe to stop.
final class BackendChildProcess {
    private let process: Process

    init(node: URL, server: URL, root: URL, environment: [String: String], diagnostics: BackendDiagnostics, sandboxProfile: URL? = nil,
         onExit: @escaping @Sendable (Int32, Int32) -> Void) {
        let child = Process()
        if let sandboxProfile {
            child.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
            child.arguments = ["-D", "REAL_HOME=\(FileManager.default.homeDirectoryForCurrentUser.path)", "-f", sandboxProfile.path, node.path, server.path]
        } else {
            child.executableURL = node
            child.arguments = [server.path]
        }
        child.currentDirectoryURL = root
        child.environment = environment
        let stdout = Pipe()
        let stderr = Pipe()
        child.standardOutput = stdout
        child.standardError = stderr
        for pipe in [stdout, stderr] {
            pipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                if data.isEmpty { handle.readabilityHandler = nil }
                else { diagnostics.classify(data, pid: child.processIdentifier) }
            }
        }
        child.terminationHandler = { terminated in onExit(terminated.processIdentifier, terminated.terminationStatus) }
        self.process = child
    }

    var isRunning: Bool { process.isRunning }
    var processIdentifier: Int32 { process.processIdentifier }

    func run() throws {
        do { try process.run() }
        catch { throw ServiceRuntimeError.cannotStart }
    }

}
