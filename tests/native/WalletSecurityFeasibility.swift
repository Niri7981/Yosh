import Foundation
import LocalAuthentication
import Security

/// Stage 0 capability checks only: never opens a Keychain, creates a key/item,
/// evaluates authentication, resumes an XPC connection, or launches Yosh.
@main
struct WalletSecurityFeasibility {
    static func main() throws {
        var error: Unmanaged<CFError>?
        guard SecAccessControlCreateWithFlags(nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .userPresence, &error) != nil else {
            fatalError("User-presence access control is unavailable")
        }
        let context = LAContext()
        context.interactionNotAllowed = true
        var authenticationError: NSError?
        let canAuthenticate = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authenticationError)

        // A requirement can be constructed without trusting any ad hoc build.
        // This deliberately nonexistent service is not resumed or contacted.
        let requirementText = "anchor apple generic and identifier \"com.yosh.wallet-security\" and certificate leaf[subject.OU] = \"YOSHSTAGE0\""
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(requirementText as CFString, [], &requirement) == errSecSuccess else {
            fatalError("Code requirement cannot be parsed")
        }
        let connection = NSXPCConnection(serviceName: "com.yosh.stage0.nonexistent")
        connection.setCodeSigningRequirement(requirementText)
        connection.invalidate()

        print("stage0: SecAccessControl userPresence object created in memory")
        print("stage0: noninteractive deviceOwnerAuthentication preflight=\(canAuthenticate)")
        print("stage0: code requirement parsed; XPC requirement API available; no connection started")
        print("stage0: secure peer identity, authentication success/cancel, and Keychain adapter remain UNVERIFIED")
    }
}
