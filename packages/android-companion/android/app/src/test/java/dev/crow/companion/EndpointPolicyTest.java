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
    @Test public void strictlyWhitelistsPathsAndMethods() { EndpointPolicy.path("/api/v1/bootstrap", "GET"); EndpointPolicy.path("/api/v1/sessions?hostId=host-1&projectId=project-1", "GET"); EndpointPolicy.path("/api/v1/sessions", "POST"); for (String value : new String[]{"/api/v1/pair", "https://evil.test", "/api/v1/../pair", "/api/v1/%2e%2e/pair", "/api/v1/input", "/api/v1/sessions?token=secret"}) { try { EndpointPolicy.path(value, "GET"); fail(value); } catch (IllegalArgumentException expected) {} } }
    @Test public void refusesMissingCertificate() throws Exception { try { EndpointPolicy.pinnedTrust("00").checkServerTrusted(new java.security.cert.X509Certificate[0], "RSA"); fail(); } catch (java.security.cert.CertificateException expected) {} }
}
