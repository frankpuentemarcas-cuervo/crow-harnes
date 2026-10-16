package dev.crow.companion;

import java.net.URI;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import android.util.Base64;
import javax.net.ssl.X509TrustManager;
import org.json.JSONObject;

/** Pure endpoint/pin policy; never installs a process-wide trust manager. */
final class EndpointPolicy {
    private static final String CHAT_HISTORY_PATH = "/api/v1/chat\\?hostId=[A-Za-z0-9._~-]{1,200}&sessionId=[a-f0-9]{32}&limit=(?:[1-9]|[1-9][0-9]|100)(?:&(?:after|before)=[0-9]{1,20})?";

    static String origin(JSONObject endpoint) throws Exception {
        java.util.Iterator<String> fields = endpoint.keys();
        while (fields.hasNext()) if (!fields.next().matches("kind|url|certSHA256|provider|proxyAuthRequired|relayUrl|relayRoute|proxyAuth")) throw new IllegalArgumentException("El endpoint de invitación contiene campos desconocidos.");
        String raw = endpoint.getString("url");
        URI uri = new URI(raw);
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null || !(uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath())) || (uri.getPort() != -1 && (uri.getPort() < 1 || uri.getPort() > 65535))) throw new IllegalArgumentException("Exact HTTPS origin required");
        String kind = endpoint.getString("kind");
        if (!kind.equals("remote-public") && !kind.equals("lan-pinned") && !kind.equals("relay")) throw new IllegalArgumentException("Invalid endpoint kind");
        if ((kind.equals("lan-pinned") || kind.equals("relay")) && !endpoint.optString("certSHA256").matches("(?i)([0-9a-f]{2}:){31}[0-9a-f]{2}")) throw new IllegalArgumentException("Missing SHA256 pin");
        if (kind.equals("relay")) {
            String route = endpoint.optString("relayRoute");
            boolean validRoute = false;
            if (route.matches("[A-Za-z0-9_-]{43}")) {
                try { byte[] decoded = Base64.decode(route, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP); validRoute = decoded.length == 32 && route.equals(Base64.encodeToString(decoded, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP)); }
                catch (IllegalArgumentException ignored) { validRoute = false; }
            }
            if (!"127.0.0.1".equals(uri.getHost()) || uri.getPort() < 1 || !validRoute) throw new IllegalArgumentException("Configuración de relay inválida.");
            URI relay = new URI(endpoint.optString("relayUrl"));
            if (!"wss".equals(relay.getScheme()) || relay.getHost() == null || relay.getUserInfo() != null || !"/v1/tunnel".equals(relay.getRawPath()) || relay.getRawQuery() != null || relay.getRawFragment() != null || relay.getPort() == 0 || relay.getPort() > 65535) throw new IllegalArgumentException("URL de relay inválida.");
        } else if (endpoint.has("relayUrl") || endpoint.has("relayRoute")) throw new IllegalArgumentException("Relay configuration is valid only for relay endpoints");
        if (endpoint.has("provider") || endpoint.has("proxyAuthRequired")) {
            if (!"pangolin".equals(endpoint.opt("provider")) || !Boolean.TRUE.equals(endpoint.opt("proxyAuthRequired")) || !kind.equals("remote-public") || !raw.matches("https://[a-z0-9.-]+/?") || uri.getHost().length() > 253 || !uri.getHost().contains(".") || !uri.getHost().matches(".*\\.[a-z]{2,63}") || uri.getHost().matches(".*\\.(localhost|local|internal)")) throw new IllegalArgumentException("Pangolin requiere un dominio HTTPS público exacto y autenticación nativa.");
            for (String part : uri.getHost().split("\\.", -1)) if (!part.matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")) throw new IllegalArgumentException("Dominio Pangolin inválido.");
        }
        return raw.endsWith("/") ? raw.substring(0, raw.length() - 1) : raw;
    }
    static X509TrustManager pinnedTrust(String expected) {
        return new X509TrustManager() {
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
            public void checkClientTrusted(X509Certificate[] chain, String auth) throws CertificateException { throw new CertificateException("Client certificate unsupported"); }
            public void checkServerTrusted(X509Certificate[] chain, String auth) throws CertificateException {
                if (chain == null || chain.length == 0) throw new CertificateException("Missing certificate");
                chain[0].checkValidity();
                try {
                    byte[] digest = MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded());
                    StringBuilder hex = new StringBuilder();
                    for (byte b : digest) { if (hex.length() > 0) hex.append(':'); hex.append(String.format("%02X", b & 0xff)); }
                    if (!MessageDigest.isEqual(hex.toString().getBytes(java.nio.charset.StandardCharsets.US_ASCII), expected.toUpperCase(java.util.Locale.ROOT).getBytes(java.nio.charset.StandardCharsets.US_ASCII))) throw new CertificateException("Certificate fingerprint mismatch");
                } catch (CertificateException error) { throw error; } catch (Exception error) { throw new CertificateException("Cannot verify fingerprint", error); }
            }
        };
    }
    static void path(String path, String method) {
        if (path == null || path.contains("%") || path.contains("..") || path.contains("#") || path.contains("\\") || path.length() > 2048) throw new IllegalArgumentException("Invalid API path");
        if ("GET".equals(method) && (path.equals("/api/v1/bootstrap") || path.equals("/api/v1/notices") || path.equals("/api/v1/quotas") || path.matches("/api/v1/sessions(?:\\?(?:hostId|projectId)=[A-Za-z0-9._~-]+(?:&(?:hostId|projectId)=[A-Za-z0-9._~-]+)?)?") || path.matches(CHAT_HISTORY_PATH))) return;
        if ("POST".equals(method) && (path.equals("/api/v1/sessions") || path.equals("/api/v1/wake") || path.equals("/api/v1/close"))) return;
        throw new IllegalArgumentException("API path not allowed");
    }
}
