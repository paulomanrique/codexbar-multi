import CodexBarCore
import Foundation
#if os(Linux)
import Glibc
#else
import Darwin
#endif

private enum OracleCase: String {
    case snapshotSerialization = "snapshot-serialization"
    case qwenCloudFlatSubscription = "qwencloud-flat-subscription"
    case moonshotBalance = "moonshot-balance"
    case moonshotSettings = "moonshot-settings"
    case fireworksSummary = "fireworks-summary"
    case fireworksSettings = "fireworks-settings"
    case fireworksRequest = "fireworks-request"
    case groqScalar = "groq-scalar"
    case groqSettings = "groq-settings"
    case groqRequest = "groq-request"
    case groqSnapshot = "groq-snapshot"

    var fixture: String {
        switch self {
        case .snapshotSerialization:
            "Tests/CodexBarTests/Fixtures/usage-snapshot-current.json"
        case .qwenCloudFlatSubscription:
            "Tests/CodexBarTests/Fixtures/QwenCloud/flat_subscription_summary.json"
        case .moonshotBalance:
            "Tests/CodexBarTests/Fixtures/Providers/Moonshot/balance-deficit.json"
        case .moonshotSettings:
            "Tests/CodexBarTests/Fixtures/Providers/Moonshot/settings-cases.json"
        case .fireworksSummary:
            "Tests/CodexBarTests/Fixtures/Providers/Fireworks/summary-cases.json"
        case .fireworksSettings:
            "Tests/CodexBarTests/Fixtures/Providers/Fireworks/settings-cases.json"
        case .fireworksRequest:
            "Tests/CodexBarTests/Fixtures/Providers/Fireworks/request-cases.json"
        case .groqScalar:
            "Tests/CodexBarTests/Fixtures/Providers/Groq/scalar-cases.json"
        case .groqSettings:
            "Tests/CodexBarTests/Fixtures/Providers/Groq/settings-cases.json"
        case .groqRequest:
            "Tests/CodexBarTests/Fixtures/Providers/Groq/request-cases.json"
        case .groqSnapshot:
            "Tests/CodexBarTests/Fixtures/Providers/Groq/snapshot-cases.json"
        }
    }
}

private enum OracleError: LocalizedError {
    case invalidInvocation
    case unsafeFixturePath
    case fixtureTooLarge
    case networkOrCredentialsEnabled

    var errorDescription: String? {
        switch self {
        case .invalidInvocation:
            "usage: CodexBarOracle <snapshot-serialization|qwencloud-flat-subscription|moonshot-balance|moonshot-settings|fireworks-summary|fireworks-settings|fireworks-request|groq-scalar|groq-settings|groq-request|groq-snapshot>"
        case .unsafeFixturePath:
            "oracle fixture path is unsafe"
        case .fixtureTooLarge:
            "oracle fixture exceeds the 1 MiB limit"
        case .networkOrCredentialsEnabled:
            "offline oracle requires network and credentials to be disabled"
        }
    }
}

private let maximumFixtureBytes = 1_024 * 1_024

private struct MoonshotSettingsFixture: Decodable {
    struct Case: Decodable {
        let id: String
        let environment: [String: String]
        let requestedRegion: String
    }

    let cases: [Case]
}

private struct MoonshotSettingsResult: Encodable {
    let id: String
    let detectedRegion: String
    let resolvedMarker: String?
}

private struct MoonshotSettingsResults: Encodable {
    let cases: [MoonshotSettingsResult]
}

private struct FireworksSummaryFixture: Decodable {
    struct Case: Decodable {
        let id: String
        let payload: JSONValue
    }

    let cases: [Case]
}

private struct FireworksSummaryResult: Encodable {
    let id: String
    let snapshot: UsageSnapshot?
    let error: String?
}

private struct FireworksSummaryResults: Encodable {
    let cases: [FireworksSummaryResult]
}

private struct FireworksSettingsFixture: Decodable {
    struct Case: Decodable {
        let id: String
        let environment: [String: String]
    }

    let cases: [Case]
}

private struct FireworksSettingsResult: Encodable {
    let id: String
    let resolvedMarker: String?
    let accountSlug: String?
}

private struct FireworksSettingsResults: Encodable {
    let cases: [FireworksSettingsResult]
}

private struct FireworksRequestFixture: Decodable {
    struct Case: Decodable {
        let id: String
        let accountSlug: String
        let startTimeMillis: Double?
        let endTimeMillis: Double?
    }

    let cases: [Case]
}

private struct FireworksRequestResult: Encodable {
    let id: String
    let url: String?
    let error: String?
}

private struct FireworksRequestResults: Encodable {
    let cases: [FireworksRequestResult]
}

private struct GroqScalarFixture: Decodable {
    struct Case: Decodable {
        let id: String
        let payload: JSONValue
    }

    let cases: [Case]
}

private struct GroqScalarResult: Encodable {
    let id: String
    let value: Double?
    let error: String?
}

private struct GroqScalarResults: Encodable {
    let cases: [GroqScalarResult]
}

private struct GroqSettingsFixture: Decodable {
    struct Case: Decodable {
        let id: String
        let environment: [String: String]
    }

    let cases: [Case]
}

private struct GroqSettingsResult: Encodable {
    let id: String
    let resolvedMarker: String?
    let apiURL: String?
    let error: String?
}

private struct GroqSettingsResults: Encodable {
    let cases: [GroqSettingsResult]
}

private struct GroqRequestFixture: Decodable {
    struct Case: Decodable {
        let id: String
        let query: String
        let environment: [String: String]
    }

    let cases: [Case]
}

private struct GroqRequestResult: Encodable {
    let id: String
    let url: String?
    let error: String?
}

private struct GroqRequestResults: Encodable {
    let cases: [GroqRequestResult]
}

private struct GroqSnapshotFixture: Decodable {
    struct Case: Decodable {
        let id: String
        let requestRatePerSecond: Double
        let inputTokenRatePerSecond: Double
        let outputTokenRatePerSecond: Double
        let promptCacheHitRatePerSecond: Double
    }

    let cases: [Case]
}

private struct GroqSnapshotResult: Encodable {
    let id: String
    let snapshot: UsageSnapshot
}

private struct GroqSnapshotResults: Encodable {
    let cases: [GroqSnapshotResult]
}

private enum JSONValue: Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case let .bool(value):
            try container.encode(value)
        case let .number(value):
            try container.encode(value)
        case let .string(value):
            try container.encode(value)
        case let .array(value):
            try container.encode(value)
        case let .object(value):
            try container.encode(value)
        }
    }
}

private func isSymlink(_ url: URL) throws -> Bool {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    return attributes[.type] as? FileAttributeType == .typeSymbolicLink
}

/// Resolves only a compile-time fixture allowlist. Every component is checked for
/// symlinks so a modified checkout cannot redirect the oracle outside its root.
private func fixtureURL(root: URL, relativePath: String) throws -> URL {
    let components = relativePath.split(separator: "/").map(String.init)
    guard !components.isEmpty,
          !relativePath.hasPrefix("/"),
          !components.contains(".."),
          !components.contains("."),
          !components.contains(where: { $0.isEmpty || $0.contains("\\") })
    else {
        throw OracleError.unsafeFixturePath
    }

    var current = root.standardizedFileURL
    guard !(try isSymlink(current)) else { throw OracleError.unsafeFixturePath }
    for component in components {
        current.appendPathComponent(component, isDirectory: false)
        guard !(try isSymlink(current)) else { throw OracleError.unsafeFixturePath }
    }
    guard current.standardizedFileURL.path.hasPrefix(root.standardizedFileURL.path + "/") else {
        throw OracleError.unsafeFixturePath
    }
    return current
}

private func readFixture(root: URL, relativePath: String) throws -> Data {
    let url = try fixtureURL(root: root, relativePath: relativePath)
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    guard let size = attributes[.size] as? NSNumber, size.int64Value <= Int64(maximumFixtureBytes) else {
        throw OracleError.fixtureTooLarge
    }
    return try Data(contentsOf: url, options: [.mappedIfSafe])
}

private func encodeJSON<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    return try encoder.encode(value)
}

private func run(case oracleCase: OracleCase, root: URL) throws -> Data {
    switch oracleCase {
    case .snapshotSerialization:
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let snapshot = try decoder.decode(
            UsageSnapshot.self,
            from: readFixture(root: root, relativePath: oracleCase.fixture))
        return try encodeJSON(snapshot)
    case .qwenCloudFlatSubscription:
        let parsed = try QwenCloudUsageFetcher.parseUsageSnapshot(
            from: readFixture(root: root, relativePath: oracleCase.fixture),
            now: Date(timeIntervalSince1970: 1_700_000_000))
        return try encodeJSON(parsed.toUsageSnapshot())
    case .moonshotBalance:
        let parsed = try MoonshotUsageFetcher._parseSummaryForTesting(
            readFixture(root: root, relativePath: oracleCase.fixture))
        let deterministic = MoonshotUsageSummary(
            availableBalance: parsed.availableBalance,
            voucherBalance: parsed.voucherBalance,
            cashBalance: parsed.cashBalance,
            updatedAt: Date(timeIntervalSince1970: 1_700_000_000))
        return try encodeJSON(deterministic.toUsageSnapshot())
    case .moonshotSettings:
        let fixture = try JSONDecoder().decode(
            MoonshotSettingsFixture.self,
            from: readFixture(root: root, relativePath: oracleCase.fixture))
        let results = try fixture.cases.map { entry in
            guard let requestedRegion = MoonshotRegion(rawValue: entry.requestedRegion) else {
                throw OracleError.invalidInvocation
            }
            return MoonshotSettingsResult(
                id: entry.id,
                detectedRegion: MoonshotSettingsReader.region(environment: entry.environment).rawValue,
                resolvedMarker: MoonshotSettingsReader.apiKey(
                    for: requestedRegion,
                    environment: entry.environment))
        }
        return try encodeJSON(MoonshotSettingsResults(cases: results))
    case .fireworksSummary:
        let fixture = try JSONDecoder().decode(
            FireworksSummaryFixture.self,
            from: readFixture(root: root, relativePath: oracleCase.fixture))
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let results = fixture.cases.map { entry in
            do {
                let payload = try encodeJSON(entry.payload)
                let summary = try FireworksUsageFetcher._parseSummaryForTesting(payload, now: now)
                return FireworksSummaryResult(
                    id: entry.id,
                    snapshot: summary.toUsageSnapshot(),
                    error: nil)
            } catch FireworksUsageError.parseFailed {
                return FireworksSummaryResult(id: entry.id, snapshot: nil, error: "parse-failure")
            } catch {
                return FireworksSummaryResult(id: entry.id, snapshot: nil, error: "unexpected-error")
            }
        }
        return try encodeJSON(FireworksSummaryResults(cases: results))
    case .fireworksSettings:
        let fixture = try JSONDecoder().decode(
            FireworksSettingsFixture.self,
            from: readFixture(root: root, relativePath: oracleCase.fixture))
        return try encodeJSON(FireworksSettingsResults(cases: fixture.cases.map { entry in
            FireworksSettingsResult(
                id: entry.id,
                resolvedMarker: FireworksSettingsReader.apiKey(environment: entry.environment),
                accountSlug: FireworksSettingsReader.accountSlug(environment: entry.environment))
        }))
    case .fireworksRequest:
        let fixture = try JSONDecoder().decode(
            FireworksRequestFixture.self,
            from: readFixture(root: root, relativePath: oracleCase.fixture))
        let results = fixture.cases.map { entry in
            do {
                let url = try FireworksUsageFetcher.resolveSummaryURL(
                    accountSlug: entry.accountSlug,
                    startTime: entry.startTimeMillis.map { Date(timeIntervalSince1970: $0 / 1000) },
                    endTime: entry.endTimeMillis.map { Date(timeIntervalSince1970: $0 / 1000) })
                return FireworksRequestResult(id: entry.id, url: url.absoluteString, error: nil)
            } catch FireworksUsageError.invalidAccountSlug {
                return FireworksRequestResult(id: entry.id, url: nil, error: "invalid-account-slug")
            } catch {
                return FireworksRequestResult(id: entry.id, url: nil, error: "unexpected-error")
            }
        }
        return try encodeJSON(FireworksRequestResults(cases: results))
    case .groqScalar:
        let fixture = try JSONDecoder().decode(
            GroqScalarFixture.self,
            from: readFixture(root: root, relativePath: oracleCase.fixture))
        let results = fixture.cases.map { entry in
            do {
                let value = try GroqUsageFetcher._parseScalarForTesting(encodeJSON(entry.payload))
                return GroqScalarResult(id: entry.id, value: value, error: nil)
            } catch GroqUsageError.apiError {
                return GroqScalarResult(id: entry.id, value: nil, error: "api-error")
            } catch GroqUsageError.parseFailed {
                return GroqScalarResult(id: entry.id, value: nil, error: "parse-failure")
            } catch {
                return GroqScalarResult(id: entry.id, value: nil, error: "unexpected-error")
            }
        }
        return try encodeJSON(GroqScalarResults(cases: results))
    case .groqSettings:
        let fixture = try JSONDecoder().decode(
            GroqSettingsFixture.self,
            from: readFixture(root: root, relativePath: oracleCase.fixture))
        let results = fixture.cases.map { entry in
            do {
                try GroqSettingsReader.validateEndpointOverrides(environment: entry.environment)
                return GroqSettingsResult(
                    id: entry.id,
                    resolvedMarker: GroqSettingsReader.apiKey(environment: entry.environment),
                    apiURL: GroqSettingsReader.apiURL(environment: entry.environment).absoluteString,
                    error: nil)
            } catch GroqSettingsError.invalidEndpointOverride {
                return GroqSettingsResult(
                    id: entry.id,
                    resolvedMarker: nil,
                    apiURL: nil,
                    error: "invalid-endpoint")
            } catch {
                return GroqSettingsResult(
                    id: entry.id,
                    resolvedMarker: nil,
                    apiURL: nil,
                    error: "unexpected-error")
            }
        }
        return try encodeJSON(GroqSettingsResults(cases: results))
    case .groqRequest:
        let fixture = try JSONDecoder().decode(
            GroqRequestFixture.self,
            from: readFixture(root: root, relativePath: oracleCase.fixture))
        let results = fixture.cases.map { entry in
            do {
                let url = try GroqUsageFetcher._resolveQueryURLForTesting(
                    query: entry.query,
                    environment: entry.environment)
                return GroqRequestResult(id: entry.id, url: url.absoluteString, error: nil)
            } catch GroqSettingsError.invalidEndpointOverride {
                return GroqRequestResult(id: entry.id, url: nil, error: "invalid-endpoint")
            } catch {
                return GroqRequestResult(id: entry.id, url: nil, error: "unexpected-error")
            }
        }
        return try encodeJSON(GroqRequestResults(cases: results))
    case .groqSnapshot:
        let fixture = try JSONDecoder().decode(
            GroqSnapshotFixture.self,
            from: readFixture(root: root, relativePath: oracleCase.fixture))
        let updatedAt = Date(timeIntervalSince1970: 1_700_000_000)
        return try encodeJSON(GroqSnapshotResults(cases: fixture.cases.map { entry in
            GroqSnapshotResult(
                id: entry.id,
                snapshot: GroqUsageSnapshot(
                    requestRatePerSecond: entry.requestRatePerSecond,
                    inputTokenRatePerSecond: entry.inputTokenRatePerSecond,
                    outputTokenRatePerSecond: entry.outputTokenRatePerSecond,
                    promptCacheHitRatePerSecond: entry.promptCacheHitRatePerSecond,
                    updatedAt: updatedAt).toUsageSnapshot())
        }))
    }
}

private func main() throws {
    let environment = ProcessInfo.processInfo.environment
    guard environment["CODEXBAR_ORACLE_NETWORK"] == "0",
          environment["CODEXBAR_ORACLE_CREDENTIALS"] == "0"
    else {
        throw OracleError.networkOrCredentialsEnabled
    }
    guard CommandLine.arguments.count == 2,
          let oracleCase = OracleCase(rawValue: CommandLine.arguments[1])
    else {
        throw OracleError.invalidInvocation
    }

    let rootPath = environment["CODEXBAR_ORACLE_ROOT"] ?? FileManager.default.currentDirectoryPath
    let root = URL(fileURLWithPath: rootPath, isDirectory: true).standardizedFileURL
    guard !root.path.isEmpty, !(try isSymlink(root)) else { throw OracleError.unsafeFixturePath }

    let output = try run(case: oracleCase, root: root)
    guard output.count <= maximumFixtureBytes else { throw OracleError.fixtureTooLarge }
    FileHandle.standardOutput.write(output)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

do {
    try main()
} catch {
    let message = "CodexBarOracle: \(error.localizedDescription)\n"
    FileHandle.standardError.write(Data(message.utf8))
    exit(64)
}
