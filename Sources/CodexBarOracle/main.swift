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

    var fixture: String {
        switch self {
        case .snapshotSerialization:
            "Tests/CodexBarTests/Fixtures/usage-snapshot-current.json"
        case .qwenCloudFlatSubscription:
            "Tests/CodexBarTests/Fixtures/QwenCloud/flat_subscription_summary.json"
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
            "usage: CodexBarOracle <snapshot-serialization|qwencloud-flat-subscription>"
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
