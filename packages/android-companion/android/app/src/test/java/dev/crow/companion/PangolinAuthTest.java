package dev.crow.companion;

import org.json.JSONObject;
import org.junit.Test;
import okhttp3.Request;
import static org.junit.Assert.*;

/** Not executed under no-build rules; run with authorized native CI/tooling. */
public class PangolinAuthTest {
    private JSONObject endpoint() throws Exception { return new JSONObject().put("kind", "remote-public").put("url", "https://crow.example.com").put("provider", "pangolin").put("proxyAuthRequired", true); }
    @Test public void distinguishesCrowScopeDenialFromProxyRejectionWithoutReadingErrors() {
        assertFalse(PangolinAuth.rejected(403, "1"));
        assertTrue(PangolinAuth.rejected(403, null)); assertTrue(PangolinAuth.rejected(401, "1"));
        assertFalse(PangolinAuth.rejected(404, null)); assertFalse(PangolinAuth.rejected(429, null));
    }
    @Test public void combinesHeadersWithoutOverwritingCrowBearer() throws Exception {
        JSONObject endpoint = endpoint(), auth = PangolinAuth.credentials(endpoint, "fake-id", "fake-token");
        for (String path : new String[]{"/api/v1/pair", "/api/v1/bootstrap", "/api/v1/stream?from=0"}) {
            Request.Builder request = new Request.Builder().url("https://crow.example.com" + path).header("Authorization", "Bearer fake-crow");
            PangolinAuth.headers(request, endpoint, auth);
            assertEquals("fake-id", request.build().header("P-Access-Token-Id")); assertEquals("fake-token", request.build().header("P-Access-Token")); assertEquals("Bearer fake-crow", request.build().header("Authorization"));
        }
    }
    @Test public void rejectsHeaderInjectionAndMissingOrMigratedKeys() throws Exception {
        JSONObject endpoint = endpoint(), auth = PangolinAuth.credentials(endpoint, "fake-id", "fake-token");
        for (String bad : new String[]{"", "x\r\nInjected: x", "x y", "ñ", "x".repeat(1025)}) { try { PangolinAuth.credentials(endpoint, "fake-id", bad); fail(); } catch (IllegalArgumentException expected) {} }
        try { PangolinAuth.validate(endpoint, null); fail(); } catch (IllegalStateException expected) {}
        try { PangolinAuth.validate(endpoint().put("url", "https://other.example.com"), auth); fail(); } catch (IllegalStateException expected) {}
        for (String target : new String[]{"https://other.example.com/api/v1/pair", "http://crow.example.com/api/v1/pair", "https://crow.example.com:8443/api/v1/pair"}) { try { PangolinAuth.headers(new Request.Builder().url(target), endpoint, auth); fail(); } catch (IllegalStateException expected) {} }
    }
    @Test public void legacyHasNoHeadersAndLanNeverInheritsProxyAuth() throws Exception {
        JSONObject old = new JSONObject().put("kind", "remote-public").put("url", "https://host.ts.net"), auth = PangolinAuth.credentials(endpoint(), "fake-id", "fake-token");
        Request.Builder request = new Request.Builder().url("https://host.ts.net/api/v1/bootstrap"); PangolinAuth.headers(request, old, null); assertNull(request.build().header("P-Access-Token"));
        try { PangolinAuth.validate(old, auth); fail(); } catch (IllegalStateException expected) {}
        try { EndpointPolicy.origin(endpoint().put("kind", "lan-pinned").put("certSHA256", "AB:".repeat(31) + "AB")); fail(); } catch (IllegalArgumentException expected) {}
        try { EndpointPolicy.origin(endpoint().put("token", "fake")); fail(); } catch (IllegalArgumentException expected) {}
    }
}
