import Darwin
import Foundation

/// Runs the packaged backend through its native owner in a disposable HOME.
/// No Mainnet profile, wallet provisioning or purchase endpoint is used.
@main
struct LiveDevnetPackagedLifecycle {
    static func main() async throws {
        guard CommandLine.arguments.count == 3 else { throw Failure.invalid }
        let bundle = URL(fileURLWithPath: CommandLine.arguments[1]).resolvingSymlinksInPath()
        let home = URL(fileURLWithPath: CommandLine.arguments[2]).resolvingSymlinksInPath()
        guard home.lastPathComponent.hasPrefix("yosh-dev-native-"),
              YoshPayDevelopment.isEnabled(bundleURL: bundle) else { throw Failure.invalid }
        let root = try YoshPayDevelopment.dataDirectory(home: home)
        let selection = PayDevelopmentSelection(version: 1, environment: .devnet, mainnetRiskAccepted: false,
            rpcUrl: PayDevelopmentSelection.offline.rpcUrl,
            devnetRpcUrl: "https://solana-devnet.api.onfinality.io/public")
        try YoshPayDevelopment.saveSelection(selection, directory: root)
        let runtime = NativeServiceRuntime(environment: [:], bundleURL: bundle,
            diagnosticsDirectory: home.appending(path: "Logs"), developmentHome: home,
            developmentServicePortOverride: 13048)
        do {
            let devnet = try await runtime.ready()
            try await verify(devnet, mode: .liveDevnet)
            let (_, saved) = try await devnet.request(.setDailyLimit("17000"))
            guard saved.statusCode == 200 else { throw Failure.invalid }
            try await runtime.switchDevelopmentEnvironment(PayDevelopmentSelection(version: 1,
                environment: .simulated, mainnetRiskAccepted: false, rpcUrl: selection.rpcUrl,
                devnetRpcUrl: selection.devnetRpcUrl))
            let simulated = try await runtime.ready()
            try await verify(simulated, mode: .simulated)
            do { _ = try await devnet.request(.execution); throw Failure.invalid }
            catch ServiceRuntimeError.authenticationFailed { }
            try await runtime.switchDevelopmentEnvironment(selection)
            let restored = try await runtime.ready()
            try await verify(restored, mode: .liveDevnet)
            let (data, response) = try await restored.request(.overview)
            let overview = try JSONDecoder().decode(AppOverview.self, from: data)
            guard response.statusCode == 200, overview.service.purchaseMode == .liveDevnet,
                  overview.service.registeredResourceRequired == true else { throw Failure.invalid }
            guard !FileManager.default.fileExists(atPath: root.appending(path: "Mainnet").path),
                  await runtime.shutdown() else { throw Failure.invalid }
            print("Packaged native Devnet → Simulation → Devnet passed: authenticated generations, stale token rejection, isolated stores and resolved network; no provisioning or payment.")
        } catch {
            _ = await runtime.shutdown()
            throw error
        }
    }
    private static func verify(_ configuration: ServiceConfiguration,
        mode: AppOverview.Service.PurchaseMode) async throws {
        let (data, response) = try await configuration.request(.execution)
        let execution = try JSONDecoder().decode(ExecutionEnvironment.self, from: data)
        guard response.statusCode == 200, execution.mode == mode,
              !execution.productionExecutionEnabled else { throw Failure.invalid }
    }
    private enum Failure: Error { case invalid }
}
