import Foundation

/// Read-only projection of GET /api/app/overview. Payment decisions stay in the backend.
struct AppOverview: Decodable {
    let service: Service
    let wallet: Wallet
    let budget: Budget
    let grant: Grant?
    var grants: [Grant]? = nil
    let connection: Connection
    let purchases: [Purchase]
    var authority: AuthoritySurface? = nil

    /// Activity follows the selected environment, using each record's persisted monetary scope.
    /// Missing or conflicting history stays in the ledger but is not attributed to this environment.
    var activityPurchases: [Purchase] {
        purchases.filter { purchase in
            switch service.purchaseMode {
            case .liveMainnet:
                purchase.monetaryEnvironment == "live_mainnet"
                    && purchase.network == "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
            case .liveDevnet:
                ["live_devnet", "legacy_test"].contains(purchase.monetaryEnvironment ?? "")
                    && purchase.network == "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
            case .simulated:
                purchase.monetaryEnvironment == "simulated"
                    && purchase.network == "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
            }
        }
    }

    /// Shared controls come from the card overview; member facts come only from that member's endpoint.
    init(shared: AppOverview, member: CardMemberSnapshot) {
        authority = member.authority
        service = shared.service
        wallet = shared.wallet
        budget = shared.budget
        grant = member.grant
        grants = member.grants
        connection = member.connection
        purchases = member.purchases
    }

    struct Service: Decodable {
        let status: Status
        let purchaseMode: PurchaseMode
        let network: String
        var paymentEnabled: Bool? = nil
        var registeredResources: [RegisteredResource]? = nil
        var registeredResourceRequired: Bool? = nil
        var execution: ExecutionEnvironment? = nil

        struct RegisteredResource: Decodable, Identifiable {
            var id: String { resourceId }
            let resourceId: String
            let providerId: String
            let url: String
            var name: String? = nil
            var method: String? = nil
            var recipient: String? = nil
            var recipientSource: String? = nil
            var baseAmount: String? = nil
            var maximumAmount: String? = nil
            var basePriceDisplay: String? = nil
            var maximumPriceDisplay: String? = nil
            var requestInputs: RegisterAPIRequest.Inputs? = nil
            var source: String? = nil
            var submission: RegisteredAPI.Submission? = nil
            let network: String
            let assetId: String
            let assetDecimals: Int
        }

        enum Status: String, Decodable {
            case running, stopping
        }

        enum PurchaseMode: String, Codable, CaseIterable {
            case simulated, liveDevnet = "live_devnet", liveMainnet = "live_mainnet"

            var title: String {
                switch self {
                case .simulated: "Simulation"
                case .liveDevnet: "Devnet · Developer"
                case .liveMainnet: "Mainnet"
                }
            }
        }
    }

    struct Wallet: Decodable {
        let address: String
    }

    struct Budget: Decodable {
        let dailyLimit: MinorUnits?
        let dailyLimitDisplay: String
        let paid: MinorUnits
        let reserved: MinorUnits
        let remaining: MinorUnits?
        let remainingDisplay: String
        let paused: Bool

        private enum CodingKeys: String, CodingKey {
            case dailyLimit, dailyLimitDisplay, paid, reserved, remaining, remainingDisplay, paused
        }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            dailyLimit = try values.decodeIfPresent(MinorUnits.self, forKey: .dailyLimit)
            dailyLimitDisplay = try values.decode(String.self, forKey: .dailyLimitDisplay)
            paid = try values.decode(MinorUnits.self, forKey: .paid)
            reserved = try values.decode(MinorUnits.self, forKey: .reserved)
            remaining = try values.decodeIfPresent(MinorUnits.self, forKey: .remaining)
            remainingDisplay = try values.decode(String.self, forKey: .remainingDisplay)
            paused = try values.decode(Bool.self, forKey: .paused)
            guard (dailyLimit == nil) == (remaining == nil) else {
                throw DecodingError.dataCorruptedError(forKey: .remaining, in: values, debugDescription: "Daily limit and remaining must both be set or absent")
            }
        }
    }

    struct Grant: Decodable {
        let id: String
        let resourceId: String?
        var network: String? = nil
        var assetId: String? = nil
        let status: Status
        let totalLimit: MinorUnits
        let remaining: MinorUnits
        let singleLimit: MinorUnits
        let assetDecimals: Int
        let expiresAt: Int64

        enum Status: String, Decodable {
            case active = "ACTIVE", revoked = "REVOKED", expired = "EXPIRED"
        }
    }

    struct Connection: Decodable {
        let enabled: Bool
        let lastSeen: Int64?
        let access: Access
        var integration: Integration? = nil

        var hasLiveMCPSession: Bool {
            enabled && integration?.configured == true && integration?.connected == true
                && integration?.state == "connected" && integration?.lastHandshake != nil
                && integration?.lastHeartbeat != nil
        }

        struct Integration: Decodable {
            let provider: String
            let configured: Bool
            let connected: Bool
            let state: String
            let lastHandshake: Int64?
            let lastHeartbeat: Int64?
        }

        enum Access: String, Decodable {
            case purchaseIntent = "purchase_intent"
            case readOnly = "read_only"
        }
    }

    struct Purchase: Decodable {
        let purchaseId: String
        let status: String
        let deliveryStatus: String
        let amount: MinorUnits
        let createdAt: Int64
        let offerId: String?
        let resourceId: String?
        let reason: String?
        let decisionReason: String?
        let transaction: String?
        let executionMode: ExecutionMode
        var monetaryEnvironment: String? = nil
        let network: String?
        let currency: String?
        let assetId: String?
        let assetDecimals: Int?
        let grantId: String?
        var providerId: String? = nil
        var offline: Bool? = nil
        var executionTrace: ExecutionTrace? = nil

        struct ExecutionTrace: Decodable {
            let source: String
            let traceId: String
            let operationId: String
            let complete: Bool
        }

        enum ExecutionMode: String, Decodable {
            case simulated, liveDevnet = "live_devnet", liveMainnet = "live_mainnet", unknown = "UNKNOWN"
        }
    }
}

struct MinorUnits: Decodable, Equatable {
    let value: Int64

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        guard !raw.isEmpty, raw.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
              let value = Int64(raw), value >= 0 else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid nonnegative minor-unit amount")
        }
        self.value = value
    }
}

struct AppBalance: Decodable {
    let amount: String?
    let display: String
    let available: Bool
    var network: String? = nil
    var assetId: String? = nil
    var assetDecimals: Int? = nil
}

/// Backend-owned member state. The budget is shared; grant, connection and purchases belong to one member.
struct CardMemberSnapshot: Decodable {
    var authority: AuthoritySurface? = nil
    let member: Member
    let connection: AppOverview.Connection
    let grant: AppOverview.Grant?
    var grants: [AppOverview.Grant]? = nil
    let purchases: [AppOverview.Purchase]
    let budget: Budget

    struct Member: Decodable, Identifiable {
        let id: UUID
        let label: String
        let status: Status
        let isDefault: Bool
        let createdAt: Int64
        let updatedAt: Int64

        enum Status: String, Decodable {
            case active = "ACTIVE", revoked = "REVOKED"
        }
    }

    struct Budget: Decodable {
        let dailyLimit: MinorUnits?
        let paid: MinorUnits
        let reserved: MinorUnits
        let remaining: MinorUnits?
        let paused: Bool
    }
}

struct CardMemberSummary: Decodable {
    let member: CardMemberSnapshot.Member
    let connection: AppOverview.Connection
    let grant: AppOverview.Grant?

    init(snapshot: CardMemberSnapshot) {
        member = snapshot.member
        connection = snapshot.connection
        grant = snapshot.grant
    }
}
