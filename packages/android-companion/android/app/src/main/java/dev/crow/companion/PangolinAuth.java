package dev.crow.companion;

import okhttp3.Request;
import okhttp3.HttpUrl;
import org.json.JSONObject;

/** Native-only resource credentials. Never place this object in a public profile. */
final class PangolinAuth {
    /** Marker distinguishes denial source only; it never authenticates a request. */
    static boolean rejected(int status, String crowMarker) { return status == 401 || (status == 403 && !"1".equals(crowMarker)); }
    static boolean required(JSONObject endpoint) throws Exception {
        EndpointPolicy.origin(endpoint);
        return Boolean.TRUE.equals(endpoint.opt("proxyAuthRequired"));
    }
    private static void header(String value, int max) {
        if (value == null || value.isEmpty() || value.length() > max) throw new IllegalArgumentException("ID/token del recurso inválido.");
        for (int i = 0; i < value.length(); i++) if (value.charAt(i) < 33 || value.charAt(i) > 126) throw new IllegalArgumentException("ID/token debe ser ASCII sin espacios ni saltos de línea.");
    }
    static JSONObject credentials(JSONObject endpoint, String id, String token) throws Exception {
        if (!required(endpoint)) throw new IllegalArgumentException("El endpoint no admite claves Pangolin.");
        header(id, 128); header(token, 1024);
        return new JSONObject().put("origin", EndpointPolicy.origin(endpoint)).put("tokenId", id).put("token", token);
    }
    static void validate(JSONObject endpoint, JSONObject auth) throws Exception {
        boolean required = required(endpoint);
        if (!required && auth == null) return; // Old LAN/Tailscale profiles retain their original transport.
        if (!required || auth == null || !EndpointPolicy.origin(endpoint).equals(auth.optString("origin"))) throw new IllegalStateException("La autenticación Pangolin no coincide con el endpoint. Volvé a vincular.");
        header(auth.getString("tokenId"), 128); header(auth.getString("token"), 1024);
    }
    static void headers(Request.Builder request, JSONObject endpoint, JSONObject auth) throws Exception {
        validate(endpoint, auth);
        if (auth != null) {
            HttpUrl target = request.build().url(), allowed = HttpUrl.get(EndpointPolicy.origin(endpoint));
            if (!target.isHttps() || !target.host().equals(allowed.host()) || target.port() != allowed.port()) throw new IllegalStateException("No se envían claves Pangolin a otro origen.");
            request.header("P-Access-Token-Id", auth.getString("tokenId")).header("P-Access-Token", auth.getString("token"));
        }
    }
}
