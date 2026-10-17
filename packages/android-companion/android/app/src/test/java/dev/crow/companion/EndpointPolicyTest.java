package dev.crow.companion;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;
/** JVM tests are source-only until an SDK/JDK is available; do not call Gradle under no-build instructions. */
public class EndpointPolicyTest {
    private JSONObject endpoint(String url) throws Exception { return new JSONObject().put("kind", "remote-public").put("url", url); }
    @Test public void acceptsExactHttpsOrigin() throws Exception { assertEquals("https://crow.test:9841", EndpointPolicy.origin(endpoint("https://crow.test:9841/"))); }
    @Test public void rejectsOriginConfusion() throws Exception { for (String value : new String[]{"http://crow.test", "https://user@crow.test", "https://crow.test/path", "https://crow.test/?token=x", "https://crow.test/#x", "https://crow.test:0", "https://crow.test:65536"}) { try { EndpointPolicy.origin(endpoint(value)); fail(value); } catch (IllegalArgumentException expected) {} } }
    @Test public void rejectsMalformedLanPin() throws Exception { try { EndpointPolicy.origin(endpoint("https://crow.test").put("kind", "lan-pinned").put("certSHA256", "bad")); fail(); } catch (IllegalArgumentException expected) {} }
    @Test public void strictlyWhitelistsPathsAndMethods() {
        EndpointPolicy.path("/api/v1/bootstrap", "GET");
        EndpointPolicy.path("/api/v1/sessions?hostId=host-1&projectId=project-1", "GET");
        EndpointPolicy.path("/api/v1/chat?hostId=host-1&sessionId=0123456789abcdef0123456789abcdef&limit=100", "GET");
        EndpointPolicy.path("/api/v1/chat?hostId=host-1&sessionId=0123456789abcdef0123456789abcdef&limit=100&after=42", "GET");
        EndpointPolicy.path("/api/v1/chat?hostId=host-1&sessionId=0123456789abcdef0123456789abcdef&limit=100&before=42", "GET");
        EndpointPolicy.path("/api/v1/sessions", "POST");
        EndpointPolicy.path("/api/v2/chat-submit", "POST");
        EndpointPolicy.path("/api/v2/chat-submit?hostId=host-1&sessionId=0123456789abcdef0123456789abcdef&requestId=123e4567-e89b-42d3-a456-426614174000", "GET");
        try { EndpointPolicy.path("/api/v2/chat-submit", "GET"); fail("chat-submit GET"); } catch (IllegalArgumentException expected) {}
        try { EndpointPolicy.path("/api/v2/chat-submit/extra", "POST"); fail("chat-submit suffix"); } catch (IllegalArgumentException expected) {}
        for (String value : new String[]{"/api/v2/chat-submit?hostId=host-1&sessionId=0123456789abcdef0123456789abcdef&requestId=bad", "/api/v2/chat-submit?hostId=host-1&sessionId=0123456789abcdef0123456789abcdef&requestId=123e4567-e89b-02d3-a456-426614174000", "/api/v2/chat-submit?requestId=123e4567-e89b-42d3-a456-426614174000&hostId=host-1&sessionId=0123456789abcdef0123456789abcdef", "/api/v2/chat-submit?hostId=host-1&sessionId=0123456789abcdef0123456789abcdef&requestId=123e4567-e89b-42d3-a456-426614174000&execute=true"}) {
            try { EndpointPolicy.path(value, "GET"); fail(value); } catch (IllegalArgumentException expected) {}
        }
        for (String value : new String[]{"/api/v1/pair", "https://evil.test", "/api/v1/../pair", "/api/v1/%2e%2e/pair", "/api/v1/input", "/api/v1/sessions?token=secret", "/api/v1/chat?hostId=host-1&sessionId=0123456789abcdef0123456789abcdef&limit=100&token=secret", "/api/v1/chat?hostId=host-1&sessionId=0123456789abcdef0123456789abcdef&limit=100&after=1&before=2", "/api/v1/chat?hostId=host-1&sessionId=0123456789abcdef0123456789abcdef&limit=101"}) {
            try { EndpointPolicy.path(value, "GET"); fail(value); } catch (IllegalArgumentException expected) {}
        }
        try { EndpointPolicy.path("/api/v1/chat?hostId=host-1&sessionId=0123456789abcdef0123456789abcdef&limit=100", "POST"); fail("POST chat history"); } catch (IllegalArgumentException expected) {}
    }
    @Test public void refusesMissingCertificate() throws Exception { try { EndpointPolicy.pinnedTrust("00").checkServerTrusted(new java.security.cert.X509Certificate[0], "RSA"); fail(); } catch (java.security.cert.CertificateException expected) {} }
}
