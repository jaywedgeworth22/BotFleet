import Foundation

/// Identifies gateway-offline responses from the currently paired computer.
public enum CompanionGatewayFailurePolicy {
    private static let expectedOfflineStatusCodes: Set<Int> = [502, 503, 530]

    public static func shouldSuppress(
        statusCode: Int,
        requestURL: String?,
        pairedConnection: Connection?
    ) -> Bool {
        guard expectedOfflineStatusCodes.contains(statusCode),
              let requestURL,
              let requestOrigin = origin(for: requestURL),
              let pairedConnection
        else { return false }

        return pairedConnection.orderedEndpoints.contains { endpoint in
            guard let endpointURL = endpoint.baseURL else { return false }
            return origin(for: endpointURL.absoluteString) == requestOrigin
        }
    }

    private static func origin(for value: String) -> Origin? {
        guard let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host?.lowercased(),
              !host.isEmpty
        else { return nil }

        let defaultPort = scheme == "https" ? 443 : 80
        return Origin(scheme: scheme, host: host, port: components.port ?? defaultPort)
    }

    private struct Origin: Equatable {
        let scheme: String
        let host: String
        let port: Int
    }
}
