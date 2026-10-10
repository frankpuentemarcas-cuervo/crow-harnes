package dev.crow.companion;

import java.net.URI;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import javax.net.ssl.X509TrustManager;
import org.json.JSONObject;

/** Pure endpoint/pin policy; never installs a process-wide trust manager. */
final class EndpointPolicy {
    static String origin(JSONObject endpoint) throws Exception {
        String raw = endpoint.getString("url");
        URI uri = new URI(raw);
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null || !(uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath())) || (uri.getPort() != -1 && (uri.getPort() < 1 || uri.getPort() > 65535))) throw new IllegalArgumentException("Exact HTTPS origin required");
        String kind = endpoint.getString("kind");
        if (!kind.equals("remote-public") && !kind.equals("lan-pinned")) throw new IllegalArgumentException("Invalid endpoint kind");
        if (kind.equals("lan-pinned") && !endpoint.optString("certSHA256").matches("(?i)([0-9a-f]{2}:){31}[0-9a-f]{2}")) throw new IllegalArgumentException("Missing SHA256 pin");
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
        if ("GET".equals(method) && (path.equals("/api/v1/bootstrap") || path.equals("/api/v1/notices") || path.equals("/api/v1/quotas") || path.matches("/api/v1/sessions(?:\\?(?:hostId|projectId)=[A-Za-z0-9._~-]+(?:&(?:hostId|projectId)=[A-Za-z0-9._~-]+)?)?"))) return;
        if ("POST".equals(method) && (path.equals("/api/v1/sessions") || path.equals("/api/v1/wake") || path.equals("/api/v1/close"))) return;
        throw new IllegalArgumentException("API path not allowed");
    }
}
