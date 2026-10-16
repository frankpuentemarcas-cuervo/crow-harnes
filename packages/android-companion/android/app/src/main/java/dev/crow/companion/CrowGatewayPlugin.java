package dev.crow.companion;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import javax.net.ssl.SSLContext;
import javax.net.ssl.X509TrustManager;
import okhttp3.Call;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONArray;
import org.json.JSONObject;

/** Only this native plugin sees credentials. HTTP POST is NEVER automatically retried. */
@CapacitorPlugin(name = "CrowGateway")
public class CrowGatewayPlugin extends Plugin {
    private CredentialStore store;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicLong epoch = new AtomicLong();
    private final ConcurrentHashMap<String, AtomicLong> generations = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Stream> streams = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, AtomicLong> streamGenerations = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, AccessCredential> accessCredentials = new ConcurrentHashMap<>();
    private static final class AccessCredential {
        final String value; final Instant expires;
        AccessCredential(String value, Instant expires) { this.value = value; this.expires = expires; }
    }
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static final int MAX_JSON_BYTES = 2 * 1024 * 1024;
    private static final class Stream {
        final String id, profileId; final long generation, epoch; volatile WebSocket socket; volatile String serverId; volatile boolean writable;
        Stream(String id, String profileId, long generation, long epoch, boolean writable) { this.id = id; this.profileId = profileId; this.generation = generation; this.epoch = epoch; this.writable = writable; }
    }
    interface Work { void run() throws Exception; }
    @Override public void load() { store = new CredentialStore(getContext()); }
    private void execute(PluginCall call, Work work) { try { worker.execute(() -> { try { work.run(); } catch (Exception error) { call.reject(safeError(error)); } }); } catch (java.util.concurrent.RejectedExecutionException cancelled) { call.reject("Conexión cancelada; volvé a vincular."); } }
    private String safeError(Exception error) {
        if (error instanceof javax.net.ssl.SSLException || error instanceof java.security.cert.CertificateException) return "TLS: verificá la huella, el nombre del endpoint y la vigencia del certificado.";
        if (error instanceof java.io.IOException) return "Sin conexión con Crow en Windows. Si enviaste una acción, verificá su estado antes de volver a intentarla.";
        if (error instanceof IllegalStateException || error instanceof IllegalArgumentException) return error.getMessage();
        return "Respuesta inválida o almacenamiento seguro no disponible. No se envió ninguna credencial a otro endpoint.";
    }
    private long generation(String id) { return generations.computeIfAbsent(id, ignored -> new AtomicLong()).get(); }
    private boolean current(Stream stream) { return streams.get(stream.id) == stream && generation(stream.profileId) == stream.generation && epoch.get() == stream.epoch; }
    private void assertCurrent(String id, long value, long e) { if (generation(id) != value || epoch.get() != e) throw new IllegalStateException("Operación cancelada; el perfil o la conexión cambió."); }
    private void publicResponse(Object value) throws Exception {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value; java.util.Iterator<String> keys = object.keys();
            while (keys.hasNext()) { String key = keys.next(); if (key.matches("(?i)credential|token|tokenId|proxyAuth|password|secret|privateKey|apiKey|sshKey|signingAlias")) throw new IllegalStateException("Crow devolvió datos privados inesperados; la respuesta se bloqueó."); publicResponse(object.get(key)); }
        } else if (value instanceof JSONArray) { JSONArray values = (JSONArray) value; for (int i = 0; i < values.length(); i++) publicResponse(values.get(i)); }
    }
    private JSONObject record(String id) throws Exception {
        JSONObject record = store.read(id);
        if (record.optInt("authVersion", 1) == 2) {
            if (!signingAlias(id).equals(record.getString("signingAlias")) || !DeviceSigningKey.exists(record.getString("signingAlias"))) throw new IllegalStateException("La clave del dispositivo no está disponible. Vinculá nuevamente desde Windows.");
        } else if (!Instant.parse(record.getJSONObject("profile").getJSONObject("device").getString("expiresAt")).isAfter(Instant.now())) { forget(id); throw new IllegalStateException("Vínculo vencido. Volvé a vincular desde Windows."); }
        try { PangolinAuth.validate(record.getJSONObject("profile").getJSONObject("endpoint"), record.optJSONObject("proxyAuth")); }
        catch (Exception invalid) { throw new IllegalStateException("El vínculo Pangolin cambió. Revisá su configuración antes de volver a vincular."); }
        return record;
    }
    private static String signingAlias(String id) { return "crow-device-sign-v2-" + id; }
    private AccessCredential rememberAccess(String id, JSONObject result) throws Exception {
        String value = result.getString("credential"); Instant now = Instant.now(), expires = Instant.parse(result.getString("credentialExpiresAt"));
        if (result.getInt("version") != 2 || !value.matches("[0-9a-f]{64}") || !expires.isAfter(now) || expires.isAfter(now.plusSeconds(901))) throw new IllegalStateException("Credencial temporal incompatible.");
        AccessCredential access = new AccessCredential(value, expires); accessCredentials.put(id, access); return access;
    }
    /** Each explicit mutation gets a new ID; the call's shared JSON and credentials are never persisted here. */
    private JSONObject mutationBody(JSONObject record, JSONObject body) throws Exception {
        JSONObject copy = body == null ? new JSONObject() : new JSONObject(body.toString());
        if (record.optInt("authVersion", 1) == 2) copy.put("requestId", UUID.randomUUID().toString());
        return copy;
    }
    private String accessCredential(String id, JSONObject record, long g, long e) throws Exception {
        assertCurrent(id, g, e);
        if (record.optInt("authVersion", 1) != 2) return record.getString("credential");
        AccessCredential existing = accessCredentials.get(id);
        if (existing != null && existing.expires.isAfter(Instant.now().plusSeconds(30))) return existing.value;
        JSONObject profile = record.getJSONObject("profile"), endpoint = profile.getJSONObject("endpoint"); String deviceId = profile.getJSONObject("device").getString("id");
        JSONObject challenge = (JSONObject) http(endpoint, "/api/v2/device-challenge", "POST", new JSONObject().put("deviceId", deviceId), null, id, record.optJSONObject("proxyAuth"));
        assertCurrent(id, g, e);
        String signature = DeviceSigningKey.signChallenge(record.getString("signingAlias"), challenge, profile.getString("gatewayId"), deviceId);
        JSONObject proof = new JSONObject().put("deviceId", deviceId).put("challengeId", challenge.getString("challengeId")).put("signature", signature);
        JSONObject result = (JSONObject) http(endpoint, "/api/v2/device-renew", "POST", proof, null, id, record.optJSONObject("proxyAuth"));
        assertCurrent(id, g, e); AccessCredential renewed = rememberAccess(id, result);
        try { assertCurrent(id, g, e); } catch (Exception cancelled) { accessCredentials.remove(id, renewed); throw cancelled; }
        return renewed.value;
    }
    private OkHttpClient client(JSONObject endpoint) throws Exception {
        EndpointPolicy.origin(endpoint);
        OkHttpClient.Builder builder = new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).connectTimeout(12, TimeUnit.SECONDS).readTimeout(25, TimeUnit.SECONDS).writeTimeout(15, TimeUnit.SECONDS).callTimeout(35, TimeUnit.SECONDS);
        if (endpoint.getString("kind").equals("lan-pinned")) {
            X509TrustManager trust = EndpointPolicy.pinnedTrust(endpoint.getString("certSHA256"));
            SSLContext tls = SSLContext.getInstance("TLS"); tls.init(null, new X509TrustManager[]{trust}, null);
            builder.sslSocketFactory(tls.getSocketFactory(), trust);
            // OkHttp's default hostname verifier remains mandatory, including IP SAN verification.
        }
        if (endpoint.getString("kind").equals("relay")) {
            X509TrustManager trust = EndpointPolicy.pinnedTrust(endpoint.getString("certSHA256"));
            SSLContext tls = SSLContext.getInstance("TLS"); tls.init(null, new X509TrustManager[]{trust}, null);
            builder.sslSocketFactory(tls.getSocketFactory(), trust);
            builder.socketFactory(new CrowRelayTunnelSocket.Factory(new OkHttpClient(), endpoint.getString("relayUrl"), endpoint.getString("relayRoute")));
            // The inner TLS hostname remains 127.0.0.1 and is checked against the pinned leaf SAN.
        }
        return builder.build();
    }
    private Object http(JSONObject endpoint, String path, String method, JSONObject body, String credential, String profileId, JSONObject proxyAuth) throws Exception {
        String origin = EndpointPolicy.origin(endpoint);
        Request.Builder request = new Request.Builder().url(origin + path).header("Origin", origin).header("Accept", "application/json");
        if (credential != null) request.header("Authorization", "Bearer " + credential);
        PangolinAuth.headers(request, endpoint, proxyAuth);
        if (method.equals("POST")) request.post(RequestBody.create(body == null ? "{}" : body.toString(), JSON)); else request.get();
        OkHttpClient client = path.equals("/api/v2/device-revoke") ? client(endpoint).newBuilder().callTimeout(5, TimeUnit.SECONDS).build() : client(endpoint);
        try (Response response = client.newCall(request.build()).execute()) {
            if (response.code() == 401 || (proxyAuth != null && PangolinAuth.rejected(response.code(), response.header("X-Crow-Mobile-API")))) {
                if (profileId != null) accessCredentials.remove(profileId);
                if (response.code() == 401 && "1".equals(response.header("X-Crow-Mobile-API"))) throw new IllegalStateException(MobileErrorMessages.fromResponse(response.code(), response.body(), response.header("X-Crow-Mobile-API")));
                throw new IllegalStateException("Sin conexión autorizada: autenticación rechazada. Revisá la conexión y los permisos en Windows. La acción no se repite automáticamente.");
            }
            if (response.isRedirect()) throw new IllegalStateException("Se rechazó una redirección: el endpoint tiene que coincidir exactamente.");
            if (!response.isSuccessful()) throw new IllegalStateException(MobileErrorMessages.fromResponse(response.code(), response.body(), response.header("X-Crow-Mobile-API")));
            if (response.body() == null) throw new IllegalStateException("Respuesta vacía de Crow.");
            if (response.body().contentType() == null || !response.body().contentType().subtype().equals("json")) throw new IllegalStateException("Crow no respondió con JSON.");
            okio.BufferedSource source = response.body().source(); source.request(MAX_JSON_BYTES + 1L);
            if (source.getBuffer().size() > MAX_JSON_BYTES) throw new IllegalStateException("Respuesta de Crow demasiado grande.");
            String raw = source.readUtf8();
            return new org.json.JSONTokener(raw).nextValue();
        } finally { client.connectionPool().evictAll(); client.dispatcher().executorService().shutdown(); }
    }
    private void forget(String id) {
        for (Stream stream : streams.values()) if (stream.profileId.equals(id)) emit(stream, "revoked", null);
        generations.computeIfAbsent(id, ignored -> new AtomicLong()).incrementAndGet();
        accessCredentials.remove(id);
        for (Stream stream : streams.values()) if (stream.profileId.equals(id)) stop(stream);
        try { String alias = signingAlias(id); if (DeviceSigningKey.exists(alias)) DeviceSigningKey.delete(alias); }
        catch (Exception unavailable) { throw new IllegalStateException("No se pudo eliminar la clave del dispositivo del almacenamiento seguro."); }
        store.delete(id);
    }
    private void stop(Stream stream) { streams.remove(stream.id, stream); if (stream.socket != null) stream.socket.cancel(); }
    private void emit(Stream stream, String status, String data) {
        if (!current(stream)) return;
        JSObject event = new JSObject(); event.put("profileId", stream.profileId); event.put("connectionId", stream.id);
        if (status != null) event.put("status", status); if (data != null) event.put("data", data);
        notifyListeners("stream", event);
    }
    @PluginMethod public void pair(PluginCall call) {
        final long e = epoch.get();
        execute(call, () -> {
            JSONObject invitation = call.getObject("enrollment");
            if (invitation != null && invitation.getInt("version") == 1) throw new IllegalArgumentException("Actualizá Crow en Windows y generá un nuevo QR. Este vínculo requiere el protocolo nuevo.");
            if (invitation == null || invitation.getInt("version") != 2 || !Instant.parse(invitation.getString("expiresAt")).isAfter(Instant.now()) || invitation.getString("gatewayId").isEmpty()) throw new IllegalArgumentException("Invitación inválida o vencida.");
            java.util.Iterator<String> fields = invitation.keys(); while (fields.hasNext()) if (!fields.next().matches("version|gatewayId|invitationCode|expiresAt|endpoints")) throw new IllegalArgumentException("La invitación contiene campos desconocidos.");
            JSONArray endpoints = invitation.getJSONArray("endpoints"); int index = call.getInt("endpointIndex", -1);
            if (endpoints.length() > 8 || index < 0 || index >= endpoints.length()) throw new IllegalArgumentException("Seleccioná un endpoint de la invitación.");
            JSONObject endpoint = endpoints.getJSONObject(index); EndpointPolicy.origin(endpoint);
            boolean pangolin = PangolinAuth.required(endpoint);
            if ((endpoint.getString("kind").equals("lan-pinned") || endpoint.getString("kind").equals("relay") || pangolin) && !call.getBoolean("destinationConfirmed", false)) throw new IllegalArgumentException("Confirmá el dominio o la huella desde Windows antes de vincular.");
            String label = call.getString("deviceName", "Android").trim(); if (label.isEmpty() || label.length() > 80) throw new IllegalArgumentException("Nombre de dispositivo inválido.");
            JSONObject proxyAuth = endpoint.optJSONObject("proxyAuth");
            if (pangolin) { if (proxyAuth == null) throw new IllegalArgumentException("El QR no incluye las credenciales Pangolin del recurso."); PangolinAuth.validate(endpoint, proxyAuth); }
            else if (endpoint.has("proxyAuth")) throw new IllegalArgumentException("Las credenciales del recurso solo se admiten para Pangolin.");
            try { completePair(call, invitation, endpoint, label, e, proxyAuth); }
            finally { if (proxyAuth != null) { proxyAuth.remove("token"); proxyAuth.remove("tokenId"); proxyAuth.remove("origin"); } }
        });
    }
    private void completePair(PluginCall call, JSONObject invitation, JSONObject endpoint, String label, long e, JSONObject proxyAuth) throws Exception {
        String id = UUID.randomUUID().toString(), alias = signingAlias(id); boolean savedProfile = false;
        try {
            if (epoch.get() != e || !Instant.parse(invitation.getString("expiresAt")).isAfter(Instant.now())) throw new IllegalStateException("La invitación venció o la conexión cambió. Volvé a vincular.");
            JSONObject body = new JSONObject().put("invitationCode", invitation.getString("invitationCode")).put("deviceName", label);
            DeviceSigningKey.generate(alias); body.put("publicKey", DeviceSigningKey.publicKey(alias));
            JSONObject result = (JSONObject) http(endpoint, "/api/v2/pair", "POST", body, null, null, proxyAuth);
            if (result.getInt("version") != 2 || result.getString("credential").isEmpty()) throw new IllegalStateException("Protocolo de vinculación incompatible.");
            JSONObject remoteDevice = result.getJSONObject("device"), remoteCaps = remoteDevice.getJSONObject("capabilities"), caps = new JSONObject();
            for (String grant : new String[]{"input", "create", "close", "quotas"}) caps.put(grant, remoteCaps.optBoolean(grant, false));
            JSONArray projects = remoteDevice.getJSONArray("projectIds"); for (int i = 0; i < projects.length(); i++) projects.getString(i);
            JSONObject device = new JSONObject().put("id", remoteDevice.getString("id")).put("label", remoteDevice.getString("label")).put("pairedAt", remoteDevice.getString("pairedAt")).put("expiresAt", JSONObject.NULL).put("projectIds", projects).put("capabilities", caps);
            if (!remoteDevice.has("expiresAt") || !remoteDevice.isNull("expiresAt")) throw new IllegalStateException("Vigencia de vínculo incompatible.");
            JSONObject approvedEndpoint = new JSONObject().put("kind", endpoint.getString("kind")).put("url", endpoint.getString("url"));
            if (endpoint.getString("kind").equals("lan-pinned") || endpoint.getString("kind").equals("relay")) approvedEndpoint.put("certSHA256", endpoint.getString("certSHA256"));
            if (endpoint.getString("kind").equals("relay")) approvedEndpoint.put("relayUrl", endpoint.getString("relayUrl")).put("relayRoute", endpoint.getString("relayRoute"));
            if (PangolinAuth.required(endpoint)) approvedEndpoint.put("provider", "pangolin").put("proxyAuthRequired", true);
            JSONObject profile = new JSONObject().put("id", id).put("gatewayId", invitation.getString("gatewayId")).put("endpoint", approvedEndpoint).put("device", device);
            profile.put("version", 2);
            publicResponse(profile);
            assertCurrent(id, 0, e);
            JSONObject saved = new JSONObject().put("profile", profile);
            saved.put("authVersion", 2); saved.put("signingAlias", alias); rememberAccess(id, result);
            if (proxyAuth != null) saved.put("proxyAuth", proxyAuth);
            store.save(id, saved);
            try { assertCurrent(id, 0, e); } catch (Exception cancelled) { store.delete(id); throw cancelled; }
            savedProfile = true;
            call.resolve(new JSObject().put("profile", profile));
        } finally { if (!savedProfile) { accessCredentials.remove(id); if (DeviceSigningKey.exists(alias)) DeviceSigningKey.delete(alias); } }
    }
    @PluginMethod public void listProfiles(PluginCall call) { execute(call, () -> {
        JSArray profiles = new JSArray(); for (String id : store.ids()) { JSONObject saved = store.read(id); if (saved.optInt("authVersion", 1) == 1 && !Instant.parse(saved.getJSONObject("profile").getJSONObject("device").getString("expiresAt")).isAfter(Instant.now())) continue; JSONObject profile = record(id).getJSONObject("profile"); publicResponse(profile); profiles.put(profile); }
        call.resolve(new JSObject().put("profiles", profiles));
    }); }
    @PluginMethod public void deleteProfile(PluginCall call) {
        String id = call.getString("profileId", "");
        execute(call, () -> {
            // Revoke at the gateway when reachable. When it is offline, deleting the
            // non-exportable signing key still makes this profile unable to renew.
            try {
                JSONObject saved = record(id), profile = saved.getJSONObject("profile");
                AccessCredential current = accessCredentials.get(id);
                if (saved.optInt("authVersion", 1) == 2 && current != null && current.expires.isAfter(Instant.now())) {
                    // Do not block unlink on a fresh network challenge. Destroying
                    // the Keystore key locally is sufficient if the host is offline.
                    http(profile.getJSONObject("endpoint"), "/api/v2/device-revoke", "POST", new JSONObject(), current.value, id, saved.optJSONObject("proxyAuth"));
                }
            } catch (Exception offline) { /* Local unlink must work while Windows or a host is off. */ }
            forget(id); call.resolve();
        });
    }
    @PluginMethod public void request(PluginCall call) {
        String id = call.getString("profileId", ""); long g = generation(id), e = epoch.get();
        execute(call, () -> {
            assertCurrent(id, g, e); JSONObject record = record(id); JSONObject profile = record.getJSONObject("profile");
            String path = call.getString("path", ""), method = call.getString("method", "GET"); EndpointPolicy.path(path, method);
            JSONObject caps = profile.getJSONObject("device").getJSONObject("capabilities");
            if ((path.equals("/api/v1/quotas") && !caps.optBoolean("quotas")) || (method.equals("POST") && path.equals("/api/v1/sessions") && !caps.optBoolean("create")) || (path.equals("/api/v1/close") && !caps.optBoolean("close"))) throw new IllegalStateException("El dispositivo no tiene permiso para esta acción.");
            JSONObject body = method.equals("POST") ? mutationBody(record, call.getObject("body")) : null;
            Object result = http(profile.getJSONObject("endpoint"), path, method, body, accessCredential(id, record, g, e), id, record.optJSONObject("proxyAuth"));
            assertCurrent(id, g, e); publicResponse(result); call.resolve(new JSObject().put("data", result));
        });
    }
    @PluginMethod public void openStream(PluginCall call) {
        String id = call.getString("profileId", ""), connectionId = call.getString("connectionId", ""); long g = generation(id), e = epoch.get();
        long connectionGeneration = streamGenerations.computeIfAbsent(connectionId, ignored -> new AtomicLong()).get();
        execute(call, () -> {
            assertCurrent(id, g, e);
            if (!connectionId.matches("[A-Za-z0-9-]{1,80}") || streams.containsKey(connectionId)) throw new IllegalArgumentException("Invalid connection identity");
            String host = call.getString("hostId", ""), sessionId = call.getString("sessionId", "");
            if (!host.matches("[A-Za-z0-9._~-]{1,200}") || !sessionId.matches("[A-Za-z0-9._~-]{1,200}")) throw new IllegalArgumentException("Invalid session identity");
            long from = call.getLong("from", 0L); if (from < 0) throw new IllegalArgumentException("Invalid cursor");
            String mode = call.getString("mode", "terminal");
            if (!"terminal".equals(mode) && !"chat".equals(mode)) throw new IllegalArgumentException("Invalid stream mode");
            JSONObject record = record(id), profile = record.getJSONObject("profile"), endpoint = profile.getJSONObject("endpoint");
            String credential = accessCredential(id, record, g, e);
            Object raw = http(endpoint, "/api/v1/sessions?hostId=" + host, "GET", null, credential, id, record.optJSONObject("proxyAuth"));
            JSONArray sessions = raw instanceof JSONArray ? (JSONArray) raw : ((JSONObject) raw).getJSONArray("sessions");
            JSONObject session = null; for (int i = 0; i < sessions.length(); i++) if (sessions.getJSONObject(i).getString("id").equals(sessionId)) session = sessions.getJSONObject(i);
            if (session == null) throw new IllegalStateException("La sesión ya no está autorizada.");
            assertCurrent(id, g, e);
            if (streamGenerations.get(connectionId).get() != connectionGeneration) throw new IllegalStateException("Conexión cancelada antes de abrirse.");
            Stream stream = new Stream(connectionId, id, g, e, profile.getJSONObject("device").getJSONObject("capabilities").optBoolean("input") && session.optBoolean("canOperate") && !session.optBoolean("readOnly")); streams.put(connectionId, stream);
            String origin = EndpointPolicy.origin(endpoint);
            HttpUrl url = HttpUrl.get(origin + "/api/v1/stream").newBuilder().addQueryParameter("hostId", host).addQueryParameter("sessionId", sessionId).addQueryParameter("from", String.valueOf(from)).addQueryParameter("mode", mode).build();
            Request.Builder requestBuilder = new Request.Builder().url(url).header("Origin", origin).header("Authorization", "Bearer " + credential);
            PangolinAuth.headers(requestBuilder, endpoint, record.optJSONObject("proxyAuth"));
            Request request = requestBuilder.build();
            OkHttpClient client = client(endpoint).newBuilder().callTimeout(0, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).pingInterval(20, TimeUnit.SECONDS).build();
            stream.socket = client.newWebSocket(request, new WebSocketListener() {
                @Override public void onOpen(WebSocket socket, Response response) { if (!current(stream)) { socket.cancel(); return; } emit(stream, "connected", null); }
                @Override public void onMessage(WebSocket socket, String text) {
                    if (!current(stream)) return;
                    try { JSONObject frame = new JSONObject(text); publicResponse(frame); if (frame.optString("type").equals("ready")) stream.serverId = frame.getString("streamId"); if (frame.optString("type").equals("state") && frame.optJSONObject("info") != null && (!frame.getJSONObject("info").optBoolean("canOperate") || frame.getJSONObject("info").optBoolean("readOnly"))) stream.writable = false; emit(stream, null, text); } catch (Exception invalid) { emit(stream, "disconnected", null); stop(stream); }
                }
                @Override public void onClosed(WebSocket socket, int code, String reason) { emit(stream, "disconnected", null); stop(stream); client.connectionPool().evictAll(); client.dispatcher().executorService().shutdown(); }
                @Override public void onFailure(WebSocket socket, Throwable error, Response response) { if (response != null && (response.code() == 401 || (record.optJSONObject("proxyAuth") != null && PangolinAuth.rejected(response.code(), response.header("X-Crow-Mobile-API"))))) accessCredentials.remove(id); emit(stream, "disconnected", null); stop(stream); client.connectionPool().evictAll(); client.dispatcher().executorService().shutdown(); }
            });
            call.resolve();
        });
    }
    @PluginMethod public void send(PluginCall call) {
        Stream stream = streams.get(call.getString("connectionId", ""));
        execute(call, () -> {
            if (stream == null || !current(stream) || stream.serverId == null || !stream.writable) throw new IllegalStateException("Terminal desconectada o de solo lectura. No se envió el texto.");
            JSONObject record = record(stream.profileId), body = new JSONObject().put("streamId", stream.serverId); String type = call.getString("type", "");
            if (type.equals("input")) { String data = call.getString("data", ""); if (data.isEmpty() || data.length() > 4096 || !data.matches("[A-Za-z0-9+/]*={0,2}")) throw new IllegalArgumentException("Input inválido."); if (android.util.Base64.decode(data, android.util.Base64.NO_WRAP).length > 2048) throw new IllegalArgumentException("El envío supera 2048 bytes UTF-8. Acortá el texto: no se divide ni se envía automáticamente."); body.put("data", data); }
            else if (type.equals("resize")) { int cols = call.getInt("cols", 0), rows = call.getInt("rows", 0); if (cols < 2 || cols > 500 || rows < 2 || rows > 500) throw new IllegalArgumentException("Tamaño inválido."); body.put("cols", cols).put("rows", rows); }
            else throw new IllegalArgumentException("Acción de terminal inválida.");
            try { http(record.getJSONObject("profile").getJSONObject("endpoint"), "/api/v1/" + type, "POST", mutationBody(record, body), accessCredential(stream.profileId, record, stream.generation, stream.epoch), stream.profileId, record.optJSONObject("proxyAuth")); }
            catch (Exception ambiguous) { emit(stream, "disconnected", null); stop(stream); throw ambiguous; }
            assertCurrent(stream.profileId, stream.generation, stream.epoch); if (!current(stream)) throw new IllegalStateException("La conexión cambió durante la acción. Verificá el resultado antes de repetirla."); call.resolve();
        });
    }
    @PluginMethod public void closeStream(PluginCall call) { String id = call.getString("connectionId", ""); streamGenerations.computeIfAbsent(id, ignored -> new AtomicLong()).incrementAndGet(); Stream stream = streams.get(id); if (stream != null) stop(stream); call.resolve(); }
    @Override protected void handleOnPause() { for (Stream stream : streams.values()) emit(stream, "disconnected", null); epoch.incrementAndGet(); accessCredentials.clear(); for (Stream stream : streams.values()) stop(stream); }
    @Override protected void handleOnDestroy() { epoch.incrementAndGet(); accessCredentials.clear(); for (Stream stream : streams.values()) stop(stream); worker.shutdownNow(); }
}
