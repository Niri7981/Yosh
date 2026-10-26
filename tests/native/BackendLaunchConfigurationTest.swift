import Foundation
import Darwin

@main
struct BackendLaunchConfigurationTest {
    static func main() async throws {
        func check(_ value: Bool, _ message: String = "", line: UInt = #line) { precondition(value, "line \(line): \(message)") }
        let policy = try JSONDecoder().decode(RegisterAPIRequest.Inputs.self, from: Data(#"{"query":["legacy"],"jsonBody":{"prompt":{"type":"string","required":true,"maxLength":300}}}"#.utf8))
        check(policy.query?.names == ["legacy"] && policy.jsonBody?.names == ["prompt"], "legacy and typed policies decode")
        let request = ResourceDiscoveryRequest(url: "https://unknown.example/analyze", method: "POST", headers: ["content-type": "application/json"],
            body: "{\"prompt\":\"sample\"}", requestInputs: nil, sample: nil)
        let prepare = ServiceEndpoint.prepareResource(.init(kind: "discovery", discovery: request))
        check(prepare.path == "/api/app/resources/prepare" && prepare.method == "POST" && prepare.isMutation, "local preview uses management authentication")
        let hash = String(repeating: "a", count: 64)
        var approved = request; approved.postApprovalHash = hash
        let body = try JSONSerialization.jsonObject(with: ServiceEndpoint.discoverResource(approved).body()!) as! [String: Any]
        check(body["postApprovalHash"] as? String == hash && body["body"] as? String == request.body, "approval preserves exact request")
        let grant = ServiceEndpoint.createGrant(totalLimit: "2000", singleLimit: "1000", expiresAt: 2_000_000_000_000,
            resourceId: "post", postApprovalHash: hash)
        let grantBody = try JSONSerialization.jsonObject(with: grant.body()!) as! [String: Any]
        check(grantBody["postApprovalHash"] as? String == hash, "grant confirmation carries independent scope approval")
        print("Native POST preview, concrete confirmation, typed/legacy policy and Grant transport passed")
        let manager = FileManager.default
        let temporary = manager.temporaryDirectory.appending(path: "yosh-launch-\(UUID().uuidString)")
        try manager.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? manager.removeItem(at: temporary) }
        let app = temporary.appending(path: "Applications/Yosh.app")
        let runtime = app.appending(path: "Contents/Resources/Runtime")
        let node = app.appending(path: "Contents/MacOS/YoshBackendNode")
        try manager.createDirectory(at: runtime.appending(path: "backend"), withIntermediateDirectories: true)
        try manager.createDirectory(at: node.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data().write(to: runtime.appending(path: "backend/server.js"))
        try Data().write(to: runtime.appending(path: "mcp.cjs"))
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: node)
        try manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        let installed = BackendLaunchConfiguration(environment: ["PATH": "/usr/bin:/bin",
            "YOSH_REPOSITORY_ROOT": "/missing/developer/repository", "YOSH_NODE_PATH": "/bin/sh"], bundleURL: app)
        check(try installed.runtimeDirectory().path == runtime.path)
        check(try installed.nodeExecutable().path == node.path, "installed app must use only its bundled Node")

        let token = String(repeating: "k", count: 43)
        let isolated = BackendLaunchConfiguration(environment: ["YOSH_DATA_DIR": temporary.path,
            "APP2049_PORT": "4011", "PRIVATE_KEY": "must-not-inherit", "SOLANA_RPC_URL": "must-not-inherit",
            "YOSH_ENABLE_MAINNET_EXECUTION": "1", "YOSH_MANAGEMENT_TOKEN": "ignored"], bundleURL: app)
        let child = try isolated.childEnvironment(token: token)
        check(child["HOSTNAME"] == "127.0.0.1" && child["PORT"] == "4011")
        check(child["YOSH_MANAGEMENT_TOKEN"] == token && child["APP2049_MANAGEMENT_TOKEN"] == token)
        check(URL(fileURLWithPath: child["YOSH_DATA_DIR"]!).resolvingSymlinksInPath().path == temporary.resolvingSymlinksInPath().path)
        check(child["YOSH_PACKAGED_RUNTIME_DIR"] == runtime.path)
        check(child["PRIVATE_KEY"] == nil && child["SOLANA_RPC_URL"] == nil)
        check(child["YOSH_ENABLE_MAINNET_EXECUTION"] == nil, "ambient env must not enable Mainnet")
        check(child["X402_FACILITATOR_URL"] == nil, "ambient facilitator must not enter installed runtime")

        let configuration = temporary.appending(path: "product-configuration.json")
        try Data(#"{"YOSH_ENABLE_MAINNET_EXECUTION":"0"}"#.utf8).write(to: configuration)
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configuration.path)
        check(try isolated.childEnvironment(token: token)["YOSH_ENABLE_MAINNET_EXECUTION"] == "0")
        try manager.setAttributes([.posixPermissions: 0o644], ofItemAtPath: configuration.path)
        try rejectsConfiguration { _ = try isolated.childEnvironment(token: token) }
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configuration.path)
        try Data(#"{"YOSH_ENABLE_MAINNET_EXECUTION":"1","YOSH_PAY_MCP_MAINNET":"1","X402_FACILITATOR_URL":"https://facilitator.example/x402"}"#.utf8)
            .write(to: configuration)
        let configured = try isolated.childEnvironment(token: token)
        check(configured["YOSH_ENABLE_MAINNET_EXECUTION"] == "1")
        check(configured["YOSH_PAY_MCP_MAINNET"] == "1")
        try Data(#"{"YOSH_PAY_MCP_MAINNET":"true"}"#.utf8).write(to: configuration)
        try rejectsConfiguration { _ = try isolated.childEnvironment(token: token) }
        check(configured["X402_FACILITATOR_URL"] == "https://facilitator.example/x402")
        for invalid in ["http://facilitator.example", "https://user:password@facilitator.example",
                        "https://facilitator.example?token=value", "https://facilitator.example/#fragment",
                        "https://", "facilitator.example", ""] {
            let data = try JSONSerialization.data(withJSONObject: ["X402_FACILITATOR_URL": invalid])
            try data.write(to: configuration)
            check(try isolated.childEnvironment(token: token)["X402_FACILITATOR_URL"] == invalid,
                  "backend must classify invalid facilitator URL without losing status API")
        }
        for unsafe in ["https://facilitator.example\n", "https://facilitator.example\u{0}",
                       String(repeating: "x", count: 2049)] {
            let data = try JSONSerialization.data(withJSONObject: ["X402_FACILITATOR_URL": unsafe])
            try data.write(to: configuration)
            try rejectsConfiguration { _ = try isolated.childEnvironment(token: token) }
        }
        try Data(#"{"PRIVATE_KEY":"forbidden"}"#.utf8).write(to: configuration)
        try rejectsConfiguration { _ = try isolated.childEnvironment(token: token) }
        try manager.removeItem(at: configuration)
        try manager.createSymbolicLink(at: configuration, withDestinationURL: runtime.appending(path: "mcp.cjs"))
        try rejectsConfiguration { _ = try isolated.childEnvironment(token: token) }
        try manager.removeItem(at: configuration)
        try manager.createSymbolicLink(at: configuration, withDestinationURL: runtime.appending(path: "missing.json"))
        try rejectsConfiguration { _ = try isolated.childEnvironment(token: token) }
        try manager.removeItem(at: configuration)

        for suffix in ["PORT", "REPOSITORY_ROOT", "NODE_PATH", "DATA_DIR", "MANAGEMENT_TOKEN"] {
            let conflicting = BackendLaunchConfiguration(environment: ["YOSH_\(suffix)": "new", "APP2049_\(suffix)": "old"], bundleURL: app)
            try rejectsConfiguration { _ = try conflicting.childEnvironment(token: token) }
        }
        try rejectsConfiguration {
            _ = try BackendLaunchConfiguration(environment: ["YOSH_DATA_DIR": "relative"], bundleURL: app).dataDirectory()
        }
        let current = BackendHealth(ready: true, service: "Yosh", pid: 123, dataDirectory: temporary.path, coreReady: true)
        let old = BackendHealth(ready: true, service: "2049", pid: 123, dataDirectory: temporary.path)
        check(current.matchesNewChild(pid: 123, directory: temporary.path))
        check(!current.matchesNewChild(pid: 124, directory: temporary.path))
        check(old.matchesTakeover(directory: temporary.path) && !old.matchesNewChild(pid: 123, directory: temporary.path))
        check(!BackendHealth(ready: true, service: "Yosh", pid: 123, dataDirectory: temporary.path, coreReady: false)
            .matchesNewChild(pid: 123, directory: temporary.path))
        // A separate application identity is required; ambient flags cannot opt
        // the installed product into development or choose a production directory.
        let developmentHome = temporary.resolvingSymlinksInPath().appending(path: "development-home")
        let developmentDirectory = try YoshPayDevelopment.dataDirectory(home: developmentHome)
        check(developmentDirectory.path.hasSuffix("/Library/Application Support/Yosh Pay Dev v0.1.1-rc.5"))
        check(YoshPayDevelopment.bundleIdentifier == "com.yosh.pay-development.v011rc5")
        check(YoshPayDevelopment.servicePorts == [13449, 13450, 13451])
        let developmentToken = try YoshPayDevelopment.managementToken(directory: developmentDirectory)
        check(developmentToken.count == 43)
        check(try YoshPayDevelopment.managementToken(directory: developmentDirectory) == developmentToken, "restarts retain isolated management identity")
        let tokenFile = developmentDirectory.appending(path: "management-token")
        try manager.setAttributes([.posixPermissions: 0o644], ofItemAtPath: tokenFile.path)
        try rejectsConfiguration { _ = try YoshPayDevelopment.managementToken(directory: developmentDirectory) }
        try manager.removeItem(at: tokenFile)
        try manager.createSymbolicLink(at: tokenFile, withDestinationURL: runtime.appending(path: "mcp.cjs"))
        try rejectsConfiguration { _ = try YoshPayDevelopment.managementToken(directory: developmentDirectory) }
        try manager.removeItem(at: tokenFile)
        let unsafeHome = temporary.resolvingSymlinksInPath().appending(path: "unsafe-home")
        let unsafeDirectory = unsafeHome.appending(path: "Library/Application Support/Yosh Pay Dev v0.1.1-rc.5")
        try manager.createDirectory(at: unsafeDirectory.deletingLastPathComponent(), withIntermediateDirectories: true)
        try manager.createSymbolicLink(at: unsafeDirectory, withDestinationURL: developmentDirectory)
        try rejectsConfiguration { _ = try YoshPayDevelopment.dataDirectory(home: unsafeHome) }
        let infoURL = app.appending(path: "Contents/Info.plist")
        func writeDevelopmentIdentity(_ id: String, enabled: Bool) throws {
            let data = try PropertyListSerialization.data(fromPropertyList: ["CFBundleIdentifier": id, "YoshPayDevelopment": enabled], format: .xml, options: 0)
            try data.write(to: infoURL)
        }
        try writeDevelopmentIdentity("com.twentyfortynine.macos", enabled: true)
        check(!YoshPayDevelopment.isEnabled(bundleURL: app), "production identity ignores development flag")
        try writeDevelopmentIdentity(YoshPayDevelopment.bundleIdentifier.replacingOccurrences(of: ".v011rc5", with: ""), enabled: true)
        check(!YoshPayDevelopment.isEnabled(bundleURL: app), "the previous Dev identity cannot select candidate runtime state")
        try writeDevelopmentIdentity(YoshPayDevelopment.bundleIdentifier, enabled: false)
        check(!YoshPayDevelopment.isEnabled(bundleURL: app), "separate identity still requires an explicit bundled flag")
        try writeDevelopmentIdentity(YoshPayDevelopment.bundleIdentifier, enabled: true)
        let development = BackendLaunchConfiguration(environment: ["YOSH_PORT": "3049", "YOSH_PAY_DEV": "0",
            "YOSH_DATA_DIR": "/must-not-use-ambient-data"], bundleURL: app, developmentHome: developmentHome)
        check(try development.isPayDevelopment && development.servicePort() == 13449, "candidate port cannot target another service")
        check(try development.dataDirectory() == developmentDirectory, "ambient data paths cannot select candidate state")
        try rejectsConfiguration { _ = try development.sandboxProfile() }
        try Data("(version 1)".utf8).write(to: runtime.appending(path: "pay-dev.sb"))
        check(try development.sandboxProfile()?.lastPathComponent == "pay-dev.sb")
        check(try YoshPayDevelopment.selection(directory: developmentDirectory) == .offline)
        let offlineToken = try development.managementToken()
        let mainnet = PayDevelopmentSelection(version: 1, environment: .mainnet, mainnetRiskAccepted: true,
            rpcUrl: "https://solana-rpc.publicnode.com")
        try rejectsConfiguration { try PayDevelopmentSelection(version: 1, environment: .mainnet, mainnetRiskAccepted: false, rpcUrl: mainnet.rpcUrl).validate() }
        for rpc in ["http://127.0.0.1:8899", "https://user:pass@rpc.example", "https://rpc.example?key=secret", "https://rpc.example:1234"] {
            try rejectsConfiguration { try PayDevelopmentSelection(version: 1, environment: .mainnet, mainnetRiskAccepted: true, rpcUrl: rpc).validate() }
        }
        try YoshPayDevelopment.saveSelection(mainnet, directory: developmentDirectory)
        try Data("(version 1)".utf8).write(to: runtime.appending(path: "pay-dev-mainnet.sb"))
        let mainnetChild = try development.childEnvironment(token: developmentToken)
        check(mainnetChild["YOSH_DATA_DIR"] == developmentDirectory.appending(path: "Mainnet").path)
        check(mainnetChild["YOSH_PAY_DEV_ENV"] == "mainnet" && mainnetChild["YOSH_PAY_MCP_MAINNET"] == "1")
        check(mainnetChild["YOSH_ENABLE_MAINNET_EXECUTION"] == "0" && mainnetChild["APP2049_ENABLE_MAINNET_EXECUTION"] == "0")
        check(mainnetChild["SOLANA_MAINNET_RPC_URL"] == mainnet.rpcUrl)
        check(try development.sandboxProfile()?.lastPathComponent == "pay-dev-mainnet.sb")
        let mainnetToken = try development.managementToken()
        check(mainnetToken != offlineToken, "environments do not share management credentials")
        let mainnetSettings = developmentDirectory.appending(path: "Mainnet/product-configuration.json")
        try Data(#"{"YOSH_ENABLE_MAINNET_EXECUTION":"1"}"#.utf8).write(to: mainnetSettings)
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: mainnetSettings.path)
        var newTokens: [String] = []
        for mode in [PayDevelopmentMode.devnet, .simulated] {
            let selection = PayDevelopmentSelection(version: 1, environment: mode,
                mainnetRiskAccepted: mainnet.mainnetRiskAccepted, rpcUrl: mainnet.rpcUrl)
            let encoded = try JSONEncoder().encode(selection)
            let object = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
            check(Set(object.keys) == ["version", "environment", "mainnetRiskAccepted", "rpcUrl"],
                "new selections keep the existing four-field version-1 wire format")
            try YoshPayDevelopment.saveSelection(selection, directory: developmentDirectory)
            try Data("(version 1)".utf8).write(to: runtime.appending(path: mode == .devnet ? "pay-dev-devnet.sb" : "pay-dev-simulated.sb"))
            let values = try development.childEnvironment(token: developmentToken)
            check(values["YOSH_PAY_MCP_DEVNET"] == (mode == .devnet ? "1" : nil))
            let name = mode == .devnet ? "Devnet" : "Simulated"
            check(try development.dataDirectory().path == developmentDirectory.appending(path: name).path)
            check(values["HOME"] == developmentDirectory.appending(path: "\(name)/home").path)
            check(values["YOSH_PAY_DEV_ENV"] == mode.rawValue)
            check(values["YOSH_EXECUTION_MODE"] == (mode == .devnet ? "live_devnet" : "simulated"))
            check(values["SOLANA_RPC_URL"] == "https://api.devnet.solana.com")
            check(values["SOLANA_MAINNET_RPC_URL"] == nil && values["YOSH_PAY_MCP_MAINNET"] == nil)
            check(values["YOSH_ENABLE_MAINNET_EXECUTION"] == "0" && values["APP2049_ENABLE_MAINNET_EXECUTION"] == "0",
                "test profiles never import the Mainnet operator flag")
            check(try development.sandboxProfile()?.lastPathComponent == (mode == .devnet ? "pay-dev-devnet.sb" : "pay-dev-simulated.sb"))
            let selectedToken = try development.managementToken()
            check(selectedToken != offlineToken && selectedToken != mainnetToken && !newTokens.contains(selectedToken))
            newTokens.append(selectedToken)
            check(try YoshPayDevelopment.selection(directory: developmentDirectory).rpcUrl == mainnet.rpcUrl,
                "test selection preserves the saved Mainnet RPC")
        }
        try YoshPayDevelopment.saveSelection(mainnet, directory: developmentDirectory)
        check(try development.managementToken() == mainnetToken)
        check(try development.childEnvironment(token: developmentToken)["YOSH_ENABLE_MAINNET_EXECUTION"] == "1",
            "returning to Mainnet restores only its original persisted operator policy")
        try YoshPayDevelopment.saveSelection(.offline, directory: developmentDirectory)
        check(try development.dataDirectory() == developmentDirectory && development.managementToken() == offlineToken)
        check(try development.childEnvironment(token: developmentToken)["YOSH_PAY_MCP_MAINNET"] == nil)
        let offlineChild = try development.childEnvironment(token: developmentToken)
        check(offlineChild["PORT"] == "13449" && offlineChild["YOSH_DATA_DIR"] == developmentDirectory.path)
        check(offlineChild["HOME"] == developmentDirectory.appending(path: "home").path,
              "backend session, runtime and configuration state remain inside the candidate root")
        let customDevnet = PayDevelopmentSelection(version: 1, environment: .devnet,
            mainnetRiskAccepted: true, rpcUrl: mainnet.rpcUrl,
            devnetRpcUrl: "https://devnet-rpc.example/public")
        try YoshPayDevelopment.saveSelection(customDevnet, directory: developmentDirectory)
        check(try YoshPayDevelopment.selection(directory: developmentDirectory) == customDevnet)
        let devnetEnvironment = try development.childEnvironment(token: developmentToken)
        check(devnetEnvironment["SOLANA_RPC_URL"] == customDevnet.devnetRpcUrl)
        check(customDevnet.rpcUrl == mainnet.rpcUrl, "Devnet RPC never replaces the Mainnet endpoint")
        var alternatePort = development
        alternatePort.developmentServicePortOverride = 45431
        check(try alternatePort.servicePort() == 45431)
        check(try alternatePort.childEnvironment(token: developmentToken)["PORT"] == "45431")
        var realHomeOverride = alternatePort
        realHomeOverride.developmentHome = FileManager.default.homeDirectoryForCurrentUser
        try rejectsConfiguration { _ = try realHomeOverride.servicePort() }
        var ordinaryOverride = installed
        ordinaryOverride.developmentServicePortOverride = 45431
        try rejectsConfiguration { _ = try ordinaryOverride.servicePort() }
        for invalidPort in [0, 80, 65536] {
            alternatePort.developmentServicePortOverride = invalidPort
            try rejectsConfiguration { _ = try alternatePort.servicePort() }
        }
        let profile = developmentDirectory.appending(path: "development-environment.json")
        try manager.setAttributes([.posixPermissions: 0o644], ofItemAtPath: profile.path)
        try rejectsConfiguration { _ = try development.childEnvironment(token: developmentToken) }
        try manager.removeItem(at: profile)
        check(try ServiceEndpoint.createDevelopmentPaymentWallet.body() == Data(#"{"action":"create_payment_wallet"}"#.utf8))
        check(ServiceEndpoint.prepareEnvironmentSwitch.isMutation)
        print("Single Dev environment selection, explicit risk, separate directory/token, safe RPC and default-disabled Mainnet passed")
        print("Development identity, fixed isolated port, persistent private token and symlink rejection passed")
        for port in CommandLine.arguments.contains("--skip-fixed-port-tests") ? [] : YoshPayDevelopment.servicePorts {
            let listener = try occupiedPort(port)
            defer { Darwin.close(listener) }
            do {
                try NativeServiceRuntime.preflightDevelopmentPorts(ownedProcessRunning: false)
                preconditionFailure("occupied candidate port \(port) was accepted")
            } catch ServiceRuntimeError.portConflict { }
            try NativeServiceRuntime.preflightDevelopmentPorts(ownedProcessRunning: true)
            let untouchedHome = temporary.appending(path: "port-conflict-home-\(port)")
            let runtimeWithConflict = NativeServiceRuntime(environment: [:], bundleURL: app,
                managementTokenLoader: { throw ServiceRuntimeError.configuration },
                diagnosticsDirectory: temporary.appending(path: "port-conflict-logs-\(port)"),
                developmentHome: untouchedHome)
            do {
                _ = try await runtimeWithConflict.ready()
                preconditionFailure("occupied candidate port \(port) reached startup")
            } catch ServiceRuntimeError.portConflict { }
            check(!manager.fileExists(atPath: untouchedHome.path), "port check must precede candidate identity/configuration access")
            check(await runtimeWithConflict.shutdown(), "a rejected startup owns no process to stop")
            check(Darwin.fcntl(listener, F_GETFD) != -1, "the occupying listener must remain owned by its caller")
        }
        print(CommandLine.arguments.contains("--skip-fixed-port-tests")
            ? "Fixed installation-port probes skipped; isolated fixture-port admission/rejection checks passed"
            : "Every candidate port conflict rejects startup before credentials or state; owned-child observation remains available")
        try manager.removeItem(at: runtime.appending(path: "backend/server.js"))
        try rejectsConfiguration { _ = try installed.runtimeDirectory() }
        print("Packaged launch paths, isolated data, private product config, sanitized environment and authenticated health identity passed")
    }

    private enum Failure: Error { case acceptedInvalidConfiguration }

    private static func occupiedPort(_ port: Int) throws -> Int32 {
        let descriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw ServiceRuntimeError.cannotStart }
        // Match the runtime probe so recently closed test connections do not look like live listeners.
        var reuse: Int32 = 1
        Darwin.setsockopt(descriptor, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
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
        guard bound && Darwin.listen(descriptor, 1) == 0 else {
            Darwin.close(descriptor)
            throw ServiceRuntimeError.portConflict
        }
        return descriptor
    }

    private static func rejectsConfiguration(_ operation: () throws -> Void) throws {
        do { try operation(); throw Failure.acceptedInvalidConfiguration }
        catch ServiceRuntimeError.configuration { }
    }
}
