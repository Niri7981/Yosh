import CFNetwork
import CryptoKit
import Foundation
import Security

enum ServiceEndpoint {
    case health
    case overview
    case wallets
    case addWallet(AddWalletRequest)
    case createDevelopmentPaymentWallet
    case balance
    case execution
    case setExecution(AppOverview.Service.PurchaseMode)
    case setProductionExecutionEnabled(Bool)
    case setPaused(Bool)
    case setDailyLimit(String)
    case createGrant(totalLimit: String, singleLimit: String, expiresAt: Int64, resourceId: String? = nil, sample: ResourceRequestSample? = nil, postApprovalHash: String? = nil)
    case revokeGrant(resourceId: String? = nil)
    case setConnection(Bool)
    case members
    case member(UUID)
    case createMember(String)
    case renameMember(UUID, String)
    case revokeMember(UUID)
    case setMemberConnection(UUID, Bool)
    case createMemberGrant(UUID, totalLimit: String, singleLimit: String, expiresAt: Int64, resourceId: String? = nil, sample: ResourceRequestSample? = nil, postApprovalHash: String? = nil)
    case revokeMemberGrant(UUID, resourceId: String? = nil)
    case prepareQuit
    case prepareEnvironmentSwitch
    case shutdown
    case resources
    case resource(String)
    case registerResource(RegisterAPIRequest)
    case resourceState(String, String)
    case discoverResource(ResourceDiscoveryRequest)
    case prepareResource(ResourcePrepareRequest)

    var path: String {
        switch self {
        case .resources, .registerResource: "/api/app/resources"
        case .resource(let id), .resourceState(let id, _): "/api/app/resources/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#%"))) ?? "")"
        case .discoverResource: "/api/app/resources/discover"
        case .prepareResource: "/api/app/resources/prepare"
        case .health: "/api/app/health"
        case .overview: "/api/app/overview"
        case .wallets, .addWallet, .createDevelopmentPaymentWallet: "/api/app/wallets"
        case .balance: "/api/app/balance"
        case .execution, .setExecution, .setProductionExecutionEnabled: "/api/app/execution"
        case .setPaused, .setDailyLimit: "/api/app/settings"
        case .createGrant, .revokeGrant: "/api/app/grant"
        case .setConnection: "/api/app/connection"
        case .members, .createMember: "/api/app/members"
        case .member(let id), .renameMember(let id, _), .revokeMember(let id): "/api/app/members/\(id.uuidString.lowercased())"
        case .setMemberConnection(let id, _): "/api/app/members/\(id.uuidString.lowercased())/connection"
        case .createMemberGrant(let id, _, _, _, _, _, _), .revokeMemberGrant(let id, _): "/api/app/members/\(id.uuidString.lowercased())/grant"
        case .prepareQuit, .shutdown, .prepareEnvironmentSwitch: "/api/app/lifecycle"
        }
    }

    var isMutation: Bool {
        switch self {
        case .health, .overview, .wallets, .balance, .execution, .members, .member, .resources, .resource: false
        case .addWallet, .createDevelopmentPaymentWallet, .prepareEnvironmentSwitch, .setExecution, .setProductionExecutionEnabled, .setPaused, .setDailyLimit, .createGrant, .revokeGrant, .setConnection, .createMember,
             .renameMember, .revokeMember, .setMemberConnection, .createMemberGrant, .revokeMemberGrant, .prepareQuit, .shutdown, .registerResource, .resourceState, .discoverResource, .prepareResource: true
        }
    }

    var method: String {
        switch self {
        case .setExecution, .setProductionExecutionEnabled, .setPaused, .setDailyLimit, .createGrant, .revokeGrant, .setConnection,
             .renameMember, .setMemberConnection, .createMemberGrant, .revokeMemberGrant, .resourceState: "PUT"
        case .addWallet, .createDevelopmentPaymentWallet, .prepareEnvironmentSwitch, .createMember, .registerResource, .discoverResource, .prepareResource: "POST"
        case .revokeMember: "DELETE"
        case .prepareQuit, .shutdown: "POST"
        case .health, .overview, .wallets, .balance, .execution, .members, .member, .resources, .resource: "GET"
        }
    }

    func body() throws -> Data? {
        switch self {
        case .createDevelopmentPaymentWallet:
            Data(#"{"action":"create_payment_wallet"}"#.utf8)
        case .prepareEnvironmentSwitch:
            Data(#"{"action":"prepareEnvironmentSwitch"}"#.utf8)
        case .addWallet(let input):
            try JSONEncoder().encode(input)
        case .registerResource(let resource):
            try JSONEncoder().encode(resource)
        case .resourceState(_, let state):
            try JSONEncoder().encode(["state": state])
        case .prepareResource(let input):
            try JSONEncoder().encode(input)
        case .discoverResource(let input):
            try JSONEncoder().encode(input)
        case .setExecution(let mode):
            try JSONEncoder().encode(["mode": mode.rawValue])
        case .setProductionExecutionEnabled(let enabled):
            try JSONEncoder().encode(["productionExecutionEnabled": enabled])
        case .setPaused(let paused):
            try JSONEncoder().encode(["paused": paused])
        case .setDailyLimit(let limit):
            try JSONEncoder().encode(["dailyLimit": limit])
        case .createGrant(let totalLimit, let singleLimit, let expiresAt, let resourceId, let sample, let postApprovalHash):
            try JSONEncoder().encode(GrantCreateRequest(totalLimit: totalLimit, singleLimit: singleLimit, expiresAt: expiresAt, resourceId: resourceId, sample: sample, postApprovalHash: postApprovalHash))
        case .revokeGrant(let resourceId):
            try JSONEncoder().encode(GrantRevokeRequest(resourceId: resourceId))
        case .setConnection(let enabled):
            try JSONEncoder().encode(["enabled": enabled])
        case .createMember(let label), .renameMember(_, let label):
            try JSONEncoder().encode(["label": label])
        case .setMemberConnection(_, let enabled):
            try JSONEncoder().encode(["enabled": enabled])
        case .createMemberGrant(_, let totalLimit, let singleLimit, let expiresAt, let resourceId, let sample, let postApprovalHash):
            try JSONEncoder().encode(GrantCreateRequest(totalLimit: totalLimit, singleLimit: singleLimit, expiresAt: expiresAt, resourceId: resourceId, sample: sample, postApprovalHash: postApprovalHash))
        case .revokeMemberGrant(_, let resourceId):
            try JSONEncoder().encode(GrantRevokeRequest(resourceId: resourceId))
        case .prepareQuit:
            Data(#"{"action":"prepareQuit"}"#.utf8)
        case .shutdown:
            Data(#"{"action":"shutdown"}"#.utf8)
        case .health, .overview, .wallets, .balance, .execution, .members, .member, .revokeMember, .resources, .resource:
            nil
        }
    }
}

private struct GrantRevokeRequest: Encodable {
    let action = "revoke"
    let resourceId: String?
}

private struct GrantCreateRequest: Encodable {
    let action = "create"
    let totalLimit: String
    let singleLimit: String
    let expiresAt: Int64
    let resourceId: String?
    let sample: ResourceRequestSample?
    let postApprovalHash: String?
}

/// Delegate callbacks, cancellation and the absolute timer share only lock-protected state.
private final class ManagementHTTPExchange: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let maximumBytes: Int
    private var data = Data()
    private var response: HTTPURLResponse?
    private var continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>?
    private var result: Result<(Data, HTTPURLResponse), Error>?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var timer: Task<Void, Never>?

    init(maximumBytes: Int) { self.maximumBytes = maximumBytes }

    func receive(_ request: URLRequest, timeout: TimeInterval) async throws -> (Data, HTTPURLResponse) {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let settings = URLSessionConfiguration.ephemeral
                settings.httpShouldSetCookies = false
                settings.timeoutIntervalForResource = timeout
                settings.connectionProxyDictionary = [
                    kCFNetworkProxiesHTTPEnable as NSString: 0,
                    kCFNetworkProxiesHTTPSEnable as NSString: 0,
                    kCFNetworkProxiesSOCKSEnable as NSString: 0,
                    kCFNetworkProxiesProxyAutoConfigEnable as NSString: 0,
                ]
                let session = URLSession(configuration: settings, delegate: self, delegateQueue: nil)
                let task = session.dataTask(with: request)
                lock.lock()
                if let result {
                    lock.unlock()
                    session.invalidateAndCancel()
                    continuation.resume(with: result)
                    return
                }
                self.continuation = continuation
                self.session = session
                self.task = task
                timer = Task {
                    do { try await Task.sleep(for: .seconds(timeout)) }
                    catch { return }
                    self.finish(.failure(ServiceRuntimeError.requestTimedOut))
                }
                task.resume()
                lock.unlock()
            }
        } onCancel: {
            self.finish(.failure(CancellationError()))
        }
    }

    private func finish(_ result: Result<(Data, HTTPURLResponse), Error>) {
        lock.lock()
        guard self.result == nil else { lock.unlock(); return }
        self.result = result
        let continuation = self.continuation
        let session = self.session
        let task = self.task
        let timer = self.timer
        self.continuation = nil
        self.session = nil
        self.task = nil
        self.timer = nil
        lock.unlock()
        task?.cancel()
        session?.invalidateAndCancel()
        timer?.cancel()
        continuation?.resume(with: result)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            finish(.failure(ServiceRuntimeError.unavailable))
            return
        }
        guard response.expectedContentLength <= Int64(maximumBytes) else {
            completionHandler(.cancel)
            finish(.failure(ServiceRuntimeError.responseTooLarge))
            return
        }
        lock.lock()
        self.response = response
        lock.unlock()
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        if chunk.count > maximumBytes - data.count {
            lock.unlock()
            finish(.failure(ServiceRuntimeError.responseTooLarge))
            return
        }
        data.append(chunk)
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let response = self.response
        let data = self.data
        lock.unlock()
        if let error {
            finish(.failure((error as NSError).code == NSURLErrorTimedOut
                ? ServiceRuntimeError.requestTimedOut : ServiceRuntimeError.unavailable))
        } else if let response { finish(.success((data, response))) }
        else { finish(.failure(ServiceRuntimeError.unavailable)) }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

struct ServiceConfiguration: Sendable {
    let baseURL: URL
    private let managementToken: String

    init(baseURL: URL, managementToken: String) {
        self.baseURL = baseURL
        self.managementToken = managementToken
    }

    func request(_ endpoint: ServiceEndpoint, timeout: TimeInterval? = nil) async throws -> (Data, HTTPURLResponse) {
        let defaultTimeout: TimeInterval = switch endpoint {
        case .health: 2
        case .prepareQuit, .shutdown, .prepareEnvironmentSwitch: 15
        case .setMemberConnection: 15
        default: 12
        }
        let timeout = timeout ?? defaultTimeout
        guard timeout.isFinite, timeout > 0 else { throw ServiceRuntimeError.configuration }
        var random = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, random.count, &random) == errSecSuccess else {
            throw ServiceRuntimeError.configuration
        }
        let nonce = Self.hex(random)
        let timestamp = String(Int64(Date.now.timeIntervalSince1970 * 1000))
        let body = try endpoint.body()
        let key = SymmetricKey(data: Data(managementToken.utf8))
        var request = URLRequest(url: baseURL.appending(path: endpoint.path), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = endpoint.method
        request.httpBody = body
        let canonical = ["2049-management-v1", endpoint.method, endpoint.path, timestamp, nonce,
                         Self.hex(SHA256.hash(data: body ?? Data()))].joined(separator: "\n")
        request.setValue(timestamp, forHTTPHeaderField: "X-2049-Timestamp")
        request.setValue(nonce, forHTTPHeaderField: "X-2049-Nonce")
        request.setValue(Self.hex(SHA256.hash(data: body ?? Data())), forHTTPHeaderField: "X-2049-Body-SHA256")
        request.setValue(Self.hex(HMAC<SHA256>.authenticationCode(for: Data(canonical.utf8), using: key)), forHTTPHeaderField: "X-2049-Proof")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if endpoint.isMutation {
            request.setValue(baseURL.absoluteString, forHTTPHeaderField: "Origin")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let maximumBytes: Int
        switch endpoint {
        case .health, .prepareQuit, .shutdown, .prepareEnvironmentSwitch: maximumBytes = 4096
        default: maximumBytes = 65_536
        }
        let (data, response) = try await ManagementHTTPExchange(maximumBytes: maximumBytes).receive(request, timeout: timeout)
        let canonicalResponse = ["2049-management-response-v1", nonce, String(response.statusCode),
                                 Self.hex(SHA256.hash(data: data))].joined(separator: "\n")
        guard let signature = response.value(forHTTPHeaderField: "X-2049-Response-Proof"),
              let bytes = Self.signatureBytes(signature),
              HMAC<SHA256>.isValidAuthenticationCode(bytes, authenticating: Data(canonicalResponse.utf8), using: key) else {
            throw ServiceRuntimeError.authenticationFailed
        }
        return (data, response)
    }

    private static func hex<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
        let digits = Array("0123456789abcdef".utf8)
        return String(decoding: bytes.flatMap { [digits[Int($0 >> 4)], digits[Int($0 & 15)]] }, as: UTF8.self)
    }

    private static func signatureBytes(_ value: String) -> [UInt8]? {
        let bytes = Array(value.utf8)
        guard bytes.count == 64, bytes.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }
        return stride(from: 0, to: bytes.count, by: 2).map {
            let high = bytes[$0] <= 57 ? bytes[$0] - 48 : bytes[$0] - 87
            let low = bytes[$0 + 1] <= 57 ? bytes[$0 + 1] - 48 : bytes[$0 + 1] - 87
            return high * 16 + low
        }
    }
}
