import Foundation

@main
struct PayDevelopmentEnvironmentLifecycle {
    static func main() async throws {
        guard CommandLine.arguments.count == 3 else { throw VerificationFailure(message: "test arguments required") }
        let bundle = URL(fileURLWithPath: CommandLine.arguments[1])
        let home = URL(fileURLWithPath: CommandLine.arguments[2]).resolvingSymlinksInPath()
        guard home.lastPathComponent.hasPrefix("yosh-dev-native-"), YoshPayDevelopment.isEnabled(bundleURL: bundle) else {
            throw VerificationFailure(message: "isolated development bundle and test HOME required")
        }
        let runtime = NativeServiceRuntime(environment: [:], bundleURL: bundle,
            diagnosticsDirectory: home.appending(path: "Logs"), developmentHome: home,
            sandboxProfileOverride: home.appending(path: "no-funds.sb"))
        do {
            print("Starting isolated Offline backend")
            let offline = try await runtime.ready()
            print("Offline backend authenticated")
            let (beforeHealth, _) = try await offline.request(.health)
            let first = try JSONDecoder().decode(BackendHealth.self, from: beforeHealth)
            let (_, limit) = try await offline.request(.setDailyLimit("500000"))
            guard limit.statusCode == 200 else { throw VerificationFailure(message: "offline setting failed") }
            let selection = PayDevelopmentSelection(version: 1, environment: .mainnet, mainnetRiskAccepted: true,
                rpcUrl: PayDevelopmentSelection.offline.rpcUrl)
            try await runtime.switchDevelopmentEnvironment(selection)
            print("Mainnet backend authenticated")
            let mainnet = try await runtime.ready()
            let (mainnetHealth, _) = try await mainnet.request(.health)
            let second = try JSONDecoder().decode(BackendHealth.self, from: mainnetHealth)
            let (executionData, executionResponse) = try await mainnet.request(.execution)
            let execution = try JSONDecoder().decode(Execution.self, from: executionData)
            guard executionResponse.statusCode == 200, execution.mode == "live_mainnet", !execution.productionExecutionEnabled,
                  second.dataDirectory == first.dataDirectory + "/Mainnet", first.pid != second.pid else {
                throw VerificationFailure(message: "mainnet isolation or default-disabled state failed")
            }
            // Old management capability cannot read or mutate the new environment.
            do {
                _ = try await offline.request(.overview)
                throw VerificationFailure(message: "old capability crossed environment")
            } catch ServiceRuntimeError.authenticationFailed { }
            try await runtime.switchDevelopmentEnvironment(.offline)
            print("Offline backend restored")
            let restored = try await runtime.ready()
            let (afterHealth, _) = try await restored.request(.health)
            let third = try JSONDecoder().decode(BackendHealth.self, from: afterHealth)
            let (overviewData, overviewResponse) = try await restored.request(.overview)
            let overview = try JSONSerialization.jsonObject(with: overviewData) as? [String: Any]
            let budget = overview?["budget"] as? [String: Any]
            guard overviewResponse.statusCode == 200, budget?["dailyLimit"] as? String == "500000",
                  third.dataDirectory == first.dataDirectory, third.pid != second.pid else {
                throw VerificationFailure(message: "original offline ledger did not return")
            }
            guard await runtime.shutdown() else { throw VerificationFailure(message: "test backend did not stop") }
            print("PASS: same Dev bundle switched Offline → Mainnet → Offline with three safely stopped backend generations; isolated stores, rejected stale credentials, original budget preserved, Mainnet payments disabled. No wallet creation or payment requested.")
        } catch {
            print("Failed native lifecycle: \(error)")
            _ = await runtime.shutdown()
            throw error
        }
    }
    private struct VerificationFailure: Error { let message: String }
    private struct Execution: Decodable { let mode: String; let productionExecutionEnabled: Bool }
}
