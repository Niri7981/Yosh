import Darwin
import Foundation

/// Authenticated loopback mock only. No installed process, real profile, Keychain or chain RPC is used.
@main
struct IsolatedExecutionProfileLifecycle {
    private final class Events: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        func record() { lock.lock(); count += 1; lock.unlock() }
        func value() -> Int { lock.lock(); defer { lock.unlock() }; return count }
    }

    static func main() async throws {
        guard CommandLine.arguments.count == 2 else { throw Failure.argument }
        let node = URL(fileURLWithPath: CommandLine.arguments[1]).resolvingSymlinksInPath()
        guard FileManager.default.isExecutableFile(atPath: node.path) else { throw Failure.argument }
        let manager = FileManager.default
        let folder = manager.temporaryDirectory.appending(path: "yosh-dev-native-\(UUID().uuidString)").resolvingSymlinksInPath()
        try manager.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? manager.removeItem(at: folder) }
        let app = folder.appending(path: "Fixture.app")
        let resources = app.appending(path: "Contents/Resources/Runtime")
        try manager.createDirectory(at: resources.appending(path: "backend/.next"), withIntermediateDirectories: true)
        try manager.createDirectory(at: app.appending(path: "Contents/MacOS"), withIntermediateDirectories: true)
        try manager.createSymbolicLink(at: app.appending(path: "Contents/MacOS/YoshBackendNode"), withDestinationURL: node)
        let identity: [String: Any] = ["CFBundleIdentifier": YoshPayDevelopment.bundleIdentifier, "YoshPayDevelopment": true]
        try PropertyListSerialization.data(fromPropertyList: identity, format: .xml, options: 0)
            .write(to: app.appending(path: "Contents/Info.plist"))
        try Data("fixture".utf8).write(to: resources.appending(path: "backend/.next/BUILD_ID"))
        try Data().write(to: resources.appending(path: "mcp.cjs"))
        for name in ["pay-dev.sb", "pay-dev-mainnet.sb", "pay-dev-devnet.sb", "pay-dev-simulated.sb"] {
            // This child is the self-contained HTTP mock below; it has no wallet/signing code.
            try Data("(version 1)\n(allow default)\n".utf8).write(to: resources.appending(path: name))
        }
        try Data(server.utf8).write(to: resources.appending(path: "backend/server.js"))
        let port = try unusedPort()
        let runtime = NativeServiceRuntime(environment: [:], bundleURL: app,
            diagnosticsDirectory: folder.appending(path: "Logs"), developmentHome: folder,
            developmentServicePortOverride: port)
        let events = Events()
        let observer = NotificationCenter.default.addObserver(forName: .nativeServiceExited, object: nil, queue: nil) { _ in events.record() }
        defer { NotificationCenter.default.removeObserver(observer) }
        let root = try YoshPayDevelopment.dataDirectory(home: folder)
        let mainnet = PayDevelopmentSelection(version: 1, environment: .mainnet, mainnetRiskAccepted: true,
            rpcUrl: "https://mainnet.example/rpc")
        let devnet = PayDevelopmentSelection(version: 1, environment: .devnet, mainnetRiskAccepted: true, rpcUrl: mainnet.rpcUrl)
        let simulated = PayDevelopmentSelection(version: 1, environment: .simulated, mainnetRiskAccepted: true, rpcUrl: mainnet.rpcUrl)
        do {
            let offline = try await runtime.ready()
            let first = try await health(offline)
            check(first.dataDirectory == root.path)
            try await runtime.switchDevelopmentEnvironment(mainnet)
            let production = try await runtime.ready()
            let second = try await health(production)
            check(second.dataDirectory == root.appending(path: "Mainnet").path && second.pid != first.pid)
            try await mode(production, equals: "live_mainnet")
            try await rejectsOldCapability(offline)
            let marker = root.appending(path: "Mainnet/ledger-fixture-marker")
            try Data("unchanged-mainnet-test-ledger".utf8).write(to: marker)

            try await runtime.switchDevelopmentEnvironment(devnet)
            let testnet = try await runtime.ready()
            let third = try await health(testnet)
            check(third.dataDirectory == root.appending(path: "Devnet").path && third.pid != second.pid)
            try await mode(testnet, equals: "live_devnet")
            try await rejectsOldCapability(production)
            try await runtime.switchDevelopmentEnvironment(simulated)
            let simulation = try await runtime.ready()
            let fourth = try await health(simulation)
            check(fourth.dataDirectory == root.appending(path: "Simulated").path && fourth.pid != third.pid)
            try await mode(simulation, equals: "simulated")
            try await rejectsOldCapability(testnet)
            try await runtime.switchDevelopmentEnvironment(mainnet)
            try await mode(try await runtime.ready(), equals: "live_mainnet")
            check(try Data(contentsOf: marker) == Data("unchanged-mainnet-test-ledger".utf8))
            check(events.value() >= 4, "Intentional environment stops must invalidate old financial UI")

            let mainnetDirectory = root.appending(path: "Mainnet")
            try control(["busy": true], in: mainnetDirectory)
            let beforeBusy = try await health(try await runtime.ready())
            do { try await runtime.switchDevelopmentEnvironment(devnet); throw Failure.acceptedBusy }
            catch ServiceRuntimeError.environmentBusy { }
            check(try YoshPayDevelopment.selection(directory: root) == mainnet)
            check(try await health(try await runtime.ready()).pid == beforeBusy.pid)
            try control([:], in: mainnetDirectory)

            let testDirectory = root.appending(path: "Devnet")
            try control(["fail": true], in: testDirectory)
            do { try await runtime.switchDevelopmentEnvironment(devnet); throw Failure.acceptedFailure }
            catch ServiceRuntimeError.configuration { }
            check(try YoshPayDevelopment.selection(directory: root) == mainnet,
                "A safely stopped failed target must restore the previous persisted selection")
            let restored = try await runtime.ready()
            try await mode(restored, equals: "live_mainnet")
            check(try await health(restored).pid != beforeBusy.pid)
            check(try Data(contentsOf: marker) == Data("unchanged-mainnet-test-ledger".utf8))

            try control(["readyDelayMs": 700], in: testDirectory)
            let changing = Task { try await runtime.switchDevelopmentEnvironment(devnet) }
            try await Task.sleep(for: .milliseconds(100))
            check(await runtime.shutdown() == false, "App quit cannot race an in-flight environment transition")
            try await changing.value
            try await mode(try await runtime.ready(), equals: "live_devnet")

            // An uncooperative target stays selected until it is safely stopped; no forced termination or false rollback.
            try control(["fail": true, "refuseShutdown": true], in: mainnetDirectory)
            do { try await runtime.switchDevelopmentEnvironment(mainnet); throw Failure.acceptedFailure }
            catch ServiceRuntimeError.authenticatedShutdownFailed { }
            check(try YoshPayDevelopment.selection(directory: root) == mainnet)
            let failed = await runtime.status()
            check(failed.pid != nil, "An uncooperative mock target must not be force killed")
            try control([:], in: mainnetDirectory)
            check(await runtime.shutdown(), "Mock cleanup must use authenticated shutdown")
            print("Isolated profile lifecycle: Mainnet/Devnet/Simulation directories, authenticated generations and stale-capability rejection, busy gate, startup rollback, transition/quit ordering and no-force-kill handling passed. Mock loopback only; no installed state, Keychain, RPC or payment.")
        } catch {
            for name in ["Mainnet", "Devnet", "Simulated"] { try? control([:], in: root.appending(path: name)) }
            _ = await runtime.shutdown()
            throw error
        }
    }

    private static func check(_ value: Bool, _ message: String = "") { precondition(value, message) }

    private enum Failure: Error { case argument, acceptedBusy, acceptedFailure, wrongMode, invalidHealth, acceptedOldCapability }
    private static func control(_ values: [String: Any], in directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try JSONSerialization.data(withJSONObject: values).write(to: directory.appending(path: "fixture-control.json"), options: .atomic)
    }
    private static func health(_ configuration: ServiceConfiguration) async throws -> BackendHealth {
        let (data, response) = try await configuration.request(.health)
        guard response.statusCode == 200 else { throw Failure.invalidHealth }
        return try JSONDecoder().decode(BackendHealth.self, from: data)
    }
    private static func mode(_ configuration: ServiceConfiguration, equals expected: String) async throws {
        let (data, response) = try await configuration.request(.execution)
        let value = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard response.statusCode == 200, value?["mode"] as? String == expected,
              value?["productionExecutionEnabled"] as? Bool == false else { throw Failure.wrongMode }
    }
    private static func rejectsOldCapability(_ configuration: ServiceConfiguration) async throws {
        do { _ = try await configuration.request(.health); throw Failure.acceptedOldCapability }
        catch ServiceRuntimeError.authenticationFailed { }
    }
    private static func unusedPort() throws -> Int {
        let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard socket >= 0 else { throw ServiceRuntimeError.cannotStart }
        defer { Darwin.close(socket) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr = in_addr(s_addr: in_addr_t(0x7f000001).bigEndian)
        let result = withUnsafePointer(to: &address) { value in
            value.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard result == 0 else { throw ServiceRuntimeError.cannotStart }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let read = withUnsafeMutablePointer(to: &address) { value in
            value.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.getsockname(socket, $0, &length) }
        }
        guard read == 0 else { throw ServiceRuntimeError.cannotStart }
        return Int(UInt16(bigEndian: address.sin_port))
    }

    private static let server = #"""
    const http = require('node:http');
    const crypto = require('node:crypto');
    const fs = require('node:fs');
    const path = require('node:path');
    const directory = process.env.YOSH_DATA_DIR;
    const secret = process.env.YOSH_MANAGEMENT_TOKEN;
    const began = Date.now();
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    const proof = value => crypto.createHmac('sha256', secret).update(value).digest('hex');
    const control = () => { try { return JSON.parse(fs.readFileSync(path.join(directory, 'fixture-control.json'), 'utf8')); } catch { return {}; } };
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const nonce = request.headers['x-2049-nonce'];
        const canonical = ['2049-management-v1', request.method, request.url, request.headers['x-2049-timestamp'], nonce, hash(body)].join('\n');
        const send = (status, value) => {
          const bytes = JSON.stringify(value);
          response.writeHead(status, {'content-type': 'application/json', 'x-2049-response-proof': proof(['2049-management-response-v1', nonce, String(status), hash(bytes)].join('\n'))});
          response.end(bytes);
        };
        if (request.headers['x-2049-proof'] !== proof(canonical)) { send(401, {code:'UNAUTHORIZED'}); return; }
        const current = control();
        if (request.url === '/api/app/health') {
          const failed = current.fail === true;
          const ready = !failed && Date.now() - began >= (current.readyDelayMs || 0);
          send(ready ? 200 : 503, {ready, coreReady:ready, service:'Yosh', pid:process.pid, dataDirectory:directory,
            wallet:'walletUnavailable', recovery:'recoveryComplete', ...(failed ? {code:'CORE_CONFIGURATION_INVALID'} : {})});
        } else if (request.url === '/api/app/execution') {
          send(200, {mode: process.env.YOSH_EXECUTION_MODE || 'live_devnet', productionExecutionEnabled:false});
        } else if (request.url === '/api/app/lifecycle') {
          const action = JSON.parse(body || '{}').action;
          if (action === 'prepareEnvironmentSwitch') { send(current.busy ? 409 : 200, {ready:!current.busy}); }
          else if (action === 'shutdown') {
            send(current.refuseShutdown ? 409 : 200, {ready:!current.refuseShutdown});
            if (!current.refuseShutdown) setTimeout(() => { server.close(); process.exit(0); }, 20);
          } else send(400, {code:'INVALID_REQUEST'});
        } else send(404, {code:'NOT_FOUND'});
      });
    });
    server.listen(Number(process.env.PORT), '127.0.0.1');
    """#
}
