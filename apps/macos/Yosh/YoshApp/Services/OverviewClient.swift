import Foundation

enum OverviewLoadError: Error {
    case configuration
    case resourceConflict, resourceDiscoveryUnavailable, resourcePostApprovalRequired
    case executionBusy
    case executionRestartRequired, executionUnconfirmed
    case unavailable
    case unauthorized
    case invalidResponse
    case portConflict
    case authenticatedShutdownFailed
    case authenticatedShutdownTimedOut
    case startupFailed
    case readinessTimedOut
    case requestTimedOut
    case serviceExited
    case dataDirectoryInUse
    case invalidRequest
    case writeRejected
    case memberNotFound
    case memberInactive
    case defaultMemberRequired
    case codexNotInstalled, codexConfigConflict, codexConfigFailed, codexBridgeUnavailable

    var message: String {
        switch self {
        case .resourcePostApprovalRequired: "Review and explicitly approve the exact POST request in Yosh."
        case .resourceConflict: "This API is read-only, removed, or its resource ID is already reserved."
        case .resourceDiscoveryUnavailable: "No supported Mainnet USDC challenge could be safely retrieved."
        case .executionBusy: "Finish pending purchases before changing execution."
        case .executionRestartRequired: "Changing networks requires a safe restart. Reopen Yosh and try again."
        case .executionUnconfirmed: "Network change was not confirmed. Check the selected environment and retry."
        case .configuration: "Local service setup unavailable"
        case .unavailable: "Local service unavailable"
        case .unauthorized: "Management access denied"
        case .invalidResponse: "Local service data unavailable"
        case .portConflict: "Unverified local service is using the port"
        case .authenticatedShutdownFailed: "Owned local service refused to stop"
        case .authenticatedShutdownTimedOut: "Owned local service did not stop in time"
        case .startupFailed: "Local service could not start"
        case .readinessTimedOut: "Local service did not become ready"
        case .requestTimedOut: "Local service request timed out"
        case .serviceExited: "Local service stopped"
        case .dataDirectoryInUse: "Yosh data is open in another service"
        case .invalidRequest: "Check the entered values and try again"
        case .writeRejected: "The setting change was not confirmed"
        case .memberNotFound: "This agent is no longer available"
        case .memberInactive: "This agent has been revoked"
        case .defaultMemberRequired: "The default agent cannot be revoked"
        case .codexNotInstalled: "Install Codex Desktop or CLI to connect"
        case .codexConfigConflict: "The Yosh connection settings in Codex changed outside Yosh. Check them in Codex before reconnecting."
        case .codexConfigFailed: "The Yosh connection settings in Codex could not be confirmed. Check Codex settings and retry."
        case .codexBridgeUnavailable: "The Yosh connection helper is unavailable. Reinstall Yosh."
        }
    }
}

extension OverviewLoadError {
    /// Connection-only language; other pages retain their existing error presentation.
    var connectionMessage: String {
        switch self {
        case .resourceConflict, .resourceDiscoveryUnavailable, .resourcePostApprovalRequired: message
        case .codexNotInstalled: "Install Codex to connect it to Yosh, then try again."
        case .codexConfigConflict: "Codex's Yosh connection settings have changed. Review them in Codex, then try again."
        case .codexConfigFailed: "Yosh couldn't finish setting up Codex. Try setup again."
        case .codexBridgeUnavailable, .configuration: "Yosh needs to be reinstalled before connecting."
        case .unauthorized: "Yosh couldn't confirm access. Reopen Yosh and try again."
        case .memberNotFound, .memberInactive: "This agent's access is no longer available. Choose another agent."
        case .defaultMemberRequired: "The default agent can't be revoked."
        case .invalidRequest: "Check the entered values and try again."
        case .executionBusy: "Finish pending purchases before changing execution."
        case .executionRestartRequired, .executionUnconfirmed: message
        case .writeRejected: "The change wasn't confirmed. Check the current status and try again."
        case .serviceExited: "Yosh stopped unexpectedly. Try again to restore access."
        case .dataDirectoryInUse: "Another copy of Yosh is using your data. Close it, then try again."
        case .portConflict: "Yosh couldn't start because another app is using its connection. Try again after closing it."
        case .authenticatedShutdownFailed, .authenticatedShutdownTimedOut: "Yosh couldn't finish restarting safely. Try again when its current work has finished."
        case .requestTimedOut, .readinessTimedOut: "Yosh is taking too long to respond. Try again."
        case .startupFailed, .unavailable, .invalidResponse: "Yosh couldn't load the connection. Try again."
        }
    }
}

struct OverviewClient {
    let runtime: NativeServiceRuntime

    func load(retry: Bool = false) async throws -> AppOverview {
        let (data, response) = try await request(.overview, retry: retry)
        if response.statusCode == 401 || response.statusCode == 403 { throw OverviewLoadError.unauthorized }
        guard response.statusCode == 200, data.count <= 1_048_576 else { throw OverviewLoadError.invalidResponse }
        do {
            return try JSONDecoder().decode(AppOverview.self, from: data)
        } catch {
            throw OverviewLoadError.invalidResponse
        }
    }

    func loadBalance() async throws -> AppBalance {
        let (data, response) = try await request(.balance)
        if response.statusCode == 401 || response.statusCode == 403 { throw OverviewLoadError.unauthorized }
        guard response.statusCode == 200, data.count <= 65_536 else { throw OverviewLoadError.unavailable }
        guard let balance = try? JSONDecoder().decode(BalanceResponse.self, from: data).balance else {
            throw OverviewLoadError.invalidResponse
        }
        return balance
    }

    /// True means the selected store changed; member IDs must be refreshed from its roster.
    @discardableResult
    func setExecution(_ mode: AppOverview.Service.PurchaseMode) async throws -> Bool {
        do {
            if let previous = try await runtime.developmentEnvironment() {
                let target: PayDevelopmentMode = switch mode {
                case .liveMainnet: .mainnet
                case .liveDevnet: .devnet
                case .simulated: .simulated
                }
                let next = PayDevelopmentSelection(version: previous.version, environment: target,
                    mainnetRiskAccepted: target == .mainnet || previous.mainnetRiskAccepted, rpcUrl: previous.rpcUrl, devnetRpcUrl: previous.devnetRpcUrl)
                try await runtime.switchDevelopmentEnvironment(next)
                let verified = try await read(.execution, as: ExecutionEnvironment.self)
                guard verified.mode == mode else { throw OverviewLoadError.executionUnconfirmed }
                return previous.environment != target
            }
            try await write(.setExecution(mode))
            let verified = try await read(.execution, as: ExecutionEnvironment.self)
            guard verified.mode == mode else { throw OverviewLoadError.executionUnconfirmed }
            return false
        } catch let error as ServiceRuntimeError {
            throw mappedRuntimeError(error)
        }
    }

    func setProductionExecutionEnabled(_ enabled: Bool) async throws {
        try await write(.setProductionExecutionEnabled(enabled))
    }

    func setPaused(_ paused: Bool) async throws {
        try await write(.setPaused(paused))
    }

    func setDailyLimit(_ minorUnits: String) async throws {
        try await write(.setDailyLimit(minorUnits))
    }

    func createGrant(totalLimit: String, singleLimit: String, expiresAt: Int64, resourceId: String? = nil, sample: ResourceRequestSample? = nil, postApprovalHash: String? = nil) async throws {
        try await write(.createGrant(totalLimit: totalLimit, singleLimit: singleLimit, expiresAt: expiresAt, resourceId: resourceId, sample: sample, postApprovalHash: postApprovalHash))
    }

    func revokeGrant(resourceId: String? = nil) async throws {
        try await write(.revokeGrant(resourceId: resourceId))
    }

    func setConnection(_ enabled: Bool) async throws {
        try await write(.setConnection(enabled))
    }

    func loadRegisteredAPIs() async throws -> [RegisteredAPI] {
        try await read(.resources, as: RegisteredAPI.List.self).resources
    }

    func inspectRegisteredAPI(_ id: String) async throws -> RegisteredAPI {
        try await read(.resource(id), as: RegisteredAPI.self)
    }

    func registerAPI(_ input: RegisterAPIRequest) async throws -> RegisteredAPI {
        let result = try await mutate(.registerResource(input), as: RegisteredAPI.self, successStatus: 201)
        NotificationCenter.default.post(name: .registeredAPIsChanged, object: nil)
        return result
    }

    func setResourceState(_ id: String, state: String) async throws -> RegisteredAPI {
        let result = try await mutate(.resourceState(id, state), as: RegisteredAPI.self)
        NotificationCenter.default.post(name: .registeredAPIsChanged, object: nil)
        return result
    }

    func prepareDiscovery(_ input: ResourceDiscoveryRequest) async throws -> PostRequestReview {
        try await mutate(.prepareResource(.init(kind: "discovery", discovery: input)), as: PostRequestReview.self)
    }

    func prepareGrantPOST(_ resourceID: String, sample: ResourceRequestSample?) async throws -> PostRequestReview {
        try await mutate(.prepareResource(.init(kind: "grant", resourceId: resourceID, sample: sample)), as: PostRequestReview.self)
    }

    func discoverAPI(_ input: ResourceDiscoveryRequest) async throws -> ResourceDiscovery {
        try await mutate(.discoverResource(input), as: ResourceDiscovery.self)
    }

    func loadMembers(retry: Bool = false) async throws -> [CardMemberSummary] {
        try await read(.members, as: MembersResponse.self, retry: retry).members
    }

    func loadWallets(retry: Bool = false) async throws -> [CardSettingsPresentation.ExistingWallet] {
        try await read(.wallets, as: CardSettingsPresentation.WalletsResponse.self, retry: retry).wallets
    }

    func loadMember(_ id: UUID, retry: Bool = false) async throws -> CardMemberSnapshot {
        try await read(.member(id), as: CardMemberSnapshot.self, retry: retry)
    }

    func createMember(label: String) async throws -> CardMemberSnapshot {
        try await mutate(.createMember(label), as: CardMemberSnapshot.self, successStatus: 201)
    }

    func renameMember(_ id: UUID, label: String) async throws -> CardMemberSnapshot {
        try await mutate(.renameMember(id, label), as: CardMemberSnapshot.self)
    }

    func revokeMember(_ id: UUID) async throws -> CardMemberSnapshot {
        try await mutate(.revokeMember(id), as: CardMemberSnapshot.self)
    }

    func setMemberConnection(_ id: UUID, enabled: Bool) async throws {
        try await write(.setMemberConnection(id, enabled))
    }

    func createMemberGrant(_ id: UUID, totalLimit: String, singleLimit: String, expiresAt: Int64, resourceId: String? = nil, sample: ResourceRequestSample? = nil, postApprovalHash: String? = nil) async throws {
        try await write(.createMemberGrant(id, totalLimit: totalLimit, singleLimit: singleLimit, expiresAt: expiresAt, resourceId: resourceId, sample: sample, postApprovalHash: postApprovalHash))
    }

    func revokeMemberGrant(_ id: UUID, resourceId: String? = nil) async throws {
        try await write(.revokeMemberGrant(id, resourceId: resourceId))
    }

    private func read<T: Decodable>(_ endpoint: ServiceEndpoint, as type: T.Type, retry: Bool = false) async throws -> T {
        let (data, response) = try await request(endpoint, retry: retry)
        if response.statusCode == 401 || response.statusCode == 403 { throw OverviewLoadError.unauthorized }
        if response.statusCode == 404 { throw OverviewLoadError.memberNotFound }
        guard response.statusCode == 200, data.count <= 1_048_576,
              let value = try? JSONDecoder().decode(type, from: data) else { throw OverviewLoadError.invalidResponse }
        return value
    }

    private func mutate<T: Decodable>(_ endpoint: ServiceEndpoint, as type: T.Type, successStatus: Int = 200) async throws -> T {
        let (data, response) = try await request(endpoint)
        if response.statusCode == 401 || response.statusCode == 403 { throw OverviewLoadError.unauthorized }
        guard data.count <= 1_048_576 else { throw OverviewLoadError.writeRejected }
        guard response.statusCode == successStatus else {
            if let code = try? JSONDecoder().decode(ManagementErrorResponse.self, from: data).code {
                switch code {
                case "RESOURCE_ID_EXISTS", "RESOURCE_READ_ONLY", "RESOURCE_REMOVED": throw OverviewLoadError.resourceConflict
                case "RESOURCE_DISCOVERY_UNAVAILABLE": throw OverviewLoadError.resourceDiscoveryUnavailable
                case "RESOURCE_POST_APPROVAL_REQUIRED": throw OverviewLoadError.resourcePostApprovalRequired
                case "RESOURCE_REQUEST_INPUT_REQUIRED", "RESOURCE_REQUEST_INPUT_INVALID", "RESOURCE_REQUEST_INPUT_UNSUPPORTED", "INVALID_REQUEST": throw OverviewLoadError.invalidRequest
                case "CARD_MEMBER_NOT_FOUND": throw OverviewLoadError.memberNotFound
                case "CARD_MEMBER_NOT_ACTIVE": throw OverviewLoadError.memberInactive
                case "DEFAULT_CARD_MEMBER_REQUIRED": throw OverviewLoadError.defaultMemberRequired
                default: break
                }
            }
            throw OverviewLoadError.writeRejected
        }
        guard let value = try? JSONDecoder().decode(type, from: data) else { throw OverviewLoadError.invalidResponse }
        return value
    }

    private func write(_ endpoint: ServiceEndpoint) async throws {
        let (data, response) = try await request(endpoint)
        if response.statusCode == 401 || response.statusCode == 403 { throw OverviewLoadError.unauthorized }
        guard data.count <= 65_536 else { throw OverviewLoadError.writeRejected }
        if response.statusCode == 200 { return }
        if let code = try? JSONDecoder().decode(ManagementErrorResponse.self, from: data).code {
            if code == "EXECUTION_BUSY" { throw OverviewLoadError.executionBusy }
            if code == "ENVIRONMENT_RESTART_REQUIRED" { throw OverviewLoadError.executionRestartRequired }
            if code == "RESOURCE_POST_APPROVAL_REQUIRED" { throw OverviewLoadError.resourcePostApprovalRequired }
            if ["RESOURCE_REQUEST_INPUT_REQUIRED", "RESOURCE_REQUEST_INPUT_INVALID", "RESOURCE_REQUEST_INPUT_UNSUPPORTED", "INVALID_REQUEST"].contains(code) { throw OverviewLoadError.invalidRequest }
            if code == "DATA_DIRECTORY_IN_USE" { throw OverviewLoadError.dataDirectoryInUse }
            if code == "CARD_MEMBER_NOT_FOUND" { throw OverviewLoadError.memberNotFound }
            if code == "CARD_MEMBER_NOT_ACTIVE" { throw OverviewLoadError.memberInactive }
            if code == "CODEX_NOT_INSTALLED" { throw OverviewLoadError.codexNotInstalled }
            if code == "CODEX_CONFIG_CONFLICT" { throw OverviewLoadError.codexConfigConflict }
            if code == "CODEX_CONFIG_FAILED" { throw OverviewLoadError.codexConfigFailed }
            if code == "CODEX_BRIDGE_UNAVAILABLE" { throw OverviewLoadError.codexBridgeUnavailable }
        }
        throw OverviewLoadError.writeRejected
    }

    private func request(_ endpoint: ServiceEndpoint, retry: Bool = false) async throws -> (Data, HTTPURLResponse) {
        do {
            let configuration = try await runtime.ready(retry: retry)
            return try await configuration.request(endpoint)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as ServiceRuntimeError {
            throw mappedRuntimeError(error)
        } catch {
            throw OverviewLoadError.unavailable
        }
    }

    private func mappedRuntimeError(_ error: ServiceRuntimeError) -> OverviewLoadError {
            switch error {
            case .environmentBusy: .executionBusy
            case .configuration: .configuration
            case .portConflict: .portConflict
            case .authenticatedShutdownFailed: .authenticatedShutdownFailed
            case .authenticatedShutdownTimedOut: .authenticatedShutdownTimedOut
            case .authenticationFailed: .unauthorized
            case .credentialUnavailable: .startupFailed
            case .requestTimedOut: .requestTimedOut
            case .responseTooLarge: .invalidResponse
            case .cannotStart: .startupFailed
            case .notReady: .readinessTimedOut
            case .processExited: .serviceExited
            case .dataDirectoryInUse: .dataDirectoryInUse
            case .restartLimitReached: .startupFailed
            case .unavailable: .unavailable
            }
    }
}

private struct BalanceResponse: Decodable {
    let balance: AppBalance
}

private struct MembersResponse: Decodable {
    let members: [CardMemberSummary]
}

private struct ManagementErrorResponse: Decodable {
    let code: String
}
