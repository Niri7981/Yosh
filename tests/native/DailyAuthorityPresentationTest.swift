import Foundation

@main
struct DailyAuthorityPresentationTest {
    private static func overview(
        mode: AppOverview.Service.PurchaseMode,
        scopedLimit: String? = "1000000",
        hasAuthority: Bool = true
    ) throws -> AppOverview {
        let network = mode == .liveMainnet
            ? "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
            : "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
        var payload: [String: Any] = [
            "service": ["status": "running", "purchaseMode": mode.rawValue,
                "network": mode == .liveMainnet ? "Solana Mainnet" : "Solana Devnet"],
            "wallet": ["address": "FixturePublicAddress"],
            "budget": ["dailyLimit": "9000000", "dailyLimitDisplay": "Fixture legacy limit",
                "paid": "100000", "reserved": "200000", "remaining": "8000000",
                "remainingDisplay": "Fixture legacy available", "paused": false],
            "connection": ["enabled": true, "lastSeen": NSNull(), "access": "purchase_intent"],
            "purchases": [],
        ]
        if hasAuthority {
            payload["authority"] = [
                "mode": mode.rawValue, "network": network, "assetId": "FixtureAsset", "assetDecimals": 6,
                "assetLabel": "USDC", "dailyLimit": scopedLimit.map { $0 as Any } ?? NSNull(),
                "available": scopedLimit == nil ? NSNull() : "650000",
                "reserved": "200000", "paid": "100000", "availableDisplay": "Fixture available",
                "reservedDisplay": "Fixture reserved", "paidDisplay": "Fixture paid",
                "dailyLimitDisplay": "Fixture scoped limit", "dailyState": scopedLimit == nil ? "required" : "active",
                "blockers": [], "wallet": ["address": "FixturePublicAddress", "network": network, "status": "available"],
            ]
        }
        return try JSONDecoder().decode(AppOverview.self,
            from: JSONSerialization.data(withJSONObject: payload))
    }

    static func main() throws {
        let devnet = DailyAuthorityPresentation(network: "Solana Devnet")
        let mainnet = DailyAuthorityPresentation(network: "Solana Mainnet")
        let balance = AppBalance(amount: "19000000", display: "19.00 Test USDC", available: true)
        precondition(devnet.currency == "Test USDC" && devnet.balanceDisplay(balance) == "19.00 Test USDC")
        precondition(mainnet.currency == "USDC" && mainnet.balanceDisplay(balance) == nil)
        precondition(DailyAuthorityPresentation(network: "Solana Mainnet-Beta").currency == "USDC")
        let unknown = DailyAuthorityPresentation(network: "Unknown network")
        precondition(unknown.currency == nil && unknown.balanceDisplay(balance) == nil)
        precondition(devnet.balanceDisplay(AppBalance(amount: nil, display: "Balance unavailable", available: false)) == nil)
        precondition(mainnet.balanceDisplay(AppBalance(amount: "1", display: "0.000001 USDC", available: true)) == "0.000001 USDC")
        precondition(devnet.balanceDisplay(AppBalance(amount: "1", display: "Invalid currency", available: true)) == nil)

        let valid = ["0": "0", "0.00": "0", "1.00": "1000000", " 2.123456 \n": "2123456",
                     "0.000001": "1", "19.10": "19100000", "999999999.999999": "999999999999999"]
        for (input, expected) in valid { precondition(DailyAuthorityPresentation.minorUnits(input) == expected) }
        for invalid in ["", "-1", "+1", "01", "1.", ".1", "0.0000001", "1e2", "1,00", "1000000000",
                        "NaN", "Infinity", "１２", "1\n2"] {
            precondition(DailyAuthorityPresentation.minorUnits(invalid) == nil, "Invalid limit must not be sent: \(invalid)")
        }
        for (minor, editor) in [(Int64(0), "0.00"), (1, "0.000001"), (1_000_000, "1.00"),
                                (1_200_000, "1.20"), (2_123_456, "2.123456"), (999_999_999_999_999, "999999999.999999")] {
            precondition(DailyAuthorityPresentation.editableLimit(minor) == editor)
            precondition(DailyAuthorityPresentation.minorUnits(editor) == String(minor))
        }
        precondition(DailyAuthorityPresentation.editableLimit(nil).isEmpty, "Unset authority must remain unset")

        let scoped = try overview(mode: .liveMainnet)
        precondition(scoped.selectedAuthority?.available?.value == 650_000)
        precondition(DailyAuthorityPresentation.configuredLimit(in: scoped) == 1_000_000,
            "Editing must use the configured scope limit, not Available or the legacy budget")
        let scopedDevnet = try overview(mode: .liveDevnet, scopedLimit: "2000000")
        precondition(DailyAuthorityPresentation.configuredLimit(in: scopedDevnet) == 2_000_000,
            "A selected Devnet scope must take precedence over the legacy budget")
        let unsetMainnet = try overview(mode: .liveMainnet, scopedLimit: nil)
        precondition(DailyAuthorityPresentation.configuredLimit(in: unsetMainnet) == nil,
            "An unset Mainnet limit must never borrow the legacy budget")
        let missingMainnet = try overview(mode: .liveMainnet, hasAuthority: false)
        precondition(DailyAuthorityPresentation.configuredLimit(in: missingMainnet) == nil,
            "Missing Mainnet scope must never borrow the legacy budget")
        let legacyDevnet = try overview(mode: .liveDevnet, hasAuthority: false)
        precondition(DailyAuthorityPresentation.configuredLimit(in: legacyDevnet) == 9_000_000,
            "Legacy Devnet projections must retain their configured budget fallback")
        print("Daily Authority: network labels, configured/available limit separation, scoped and legacy selection, integer input boundaries, zero/unset limits, and exact six-decimal round trips passed")
    }
}
