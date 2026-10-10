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
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private static final int MAX_JSON_BYTES = 2 * 1024 * 1024;
    private static final class Stream {
        final String id, profileId; final long generation, epoch; volatile WebSocket socket; volatile String serverId; volatile boolean writable;
        Stream(String id, String profileId, long generation, long epoch, boolean writable) { this.id = id; this.profileId = profileId; this.generation = generation; this.epoch = epoch; this.writable = writable; }
    }
    interface Work { void run() throws Exception; }
    @Override public void load() { store = new CredentialStore(getContext()); }
    private void execute(PluginCall call, Work work) { worker.execute(() -> { try { work.run(); } catch (Exception error) { call.reject(safeError(error)); } }); }
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
            while (keys.hasNext()) { String key = keys.next(); if (key.matches("(?i)credential|token|password|secret|privateKey|apiKey|sshKey")) throw new IllegalStateException("Crow devolvió datos privados inesperados; la respuesta se bloqueó."); publicResponse(object.get(key)); }
        } else if (value instanceof JSONArray) { JSONArray values = (JSONArray) value; for (int i = 0; i < values.length(); i++) publicResponse(values.get(i)); }
    }
    private JSONObject record(String id) throws Exception {
        JSONObject record = store.read(id);
        if (!Instant.parse(record.getJSONObject("profile").getJSONObject("device").getString("expiresAt")).isAfter(Instant.now())) { forget(id); throw new IllegalStateException("Vínculo vencido. Volvé a vincular desde Windows."); }
        return record;
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
        return builder.build();
    }
    private Object http(JSONObject endpoint, String path, String method, JSONObject body, String credential, String profileId) throws Exception {
        String origin = EndpointPolicy.origin(endpoint);
        Request.Builder request = new Request.Builder().url(origin + path).header("Origin", origin).header("Accept", "application/json");
        if (credential != null) request.header("Authorization", "Bearer " + credential);
        if (method.equals("POST")) request.post(RequestBody.create(body == null ? "{}" : body.toString(), JSON)); else request.get();
        OkHttpClient client = client(endpoint);
        try (Response response = client.newCall(request.build()).execute()) {
            if (response.code() == 401) { if (profileId != null) forget(profileId); throw new IllegalStateException("Vínculo revocado o vencido. Volvé a vincular desde Windows."); }
            if (response.isRedirect()) throw new IllegalStateException("Se rechazó una redirección: el endpoint tiene que coincidir exactamente.");
            if (!response.isSuccessful()) throw new IllegalStateException("Crow rechazó la acción (HTTP " + response.code() + "). Verificá el estado antes de repetirla.");
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
        store.delete(id);
        for (Stream stream : streams.values()) if (stream.profileId.equals(id)) stop(stream);
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
            if (invitation == null || invitation.getInt("version") != 1 || !Instant.parse(invitation.getString("expiresAt")).isAfter(Instant.now()) || invitation.getString("gatewayId").isEmpty()) throw new IllegalArgumentException("Invitación inválida o vencida.");
            JSONArray endpoints = invitation.getJSONArray("endpoints"); int index = call.getInt("endpointIndex", -1);
            if (endpoints.length() > 8 || index < 0 || index >= endpoints.length()) throw new IllegalArgumentException("Seleccioná un endpoint de la invitación.");
            JSONObject endpoint = endpoints.getJSONObject(index); EndpointPolicy.origin(endpoint);
            if (endpoint.getString("kind").equals("lan-pinned") && !call.getBoolean("fingerprintConfirmed", false)) throw new IllegalArgumentException("Confirmá la huella desde Windows antes de vincular.");
            String label = call.getString("deviceName", "Android").trim(); if (label.isEmpty() || label.length() > 80) throw new IllegalArgumentException("Nombre de dispositivo inválido.");
            JSONObject body = new JSONObject().put("invitationCode", invitation.getString("invitationCode")).put("deviceName", label);
            JSONObject result = (JSONObject) http(endpoint, "/api/v1/pair", "POST", body, null, null);
            if (result.getInt("version") != 1 || result.getString("credential").isEmpty()) throw new IllegalStateException("Protocolo de vinculación incompatible.");
            JSONObject remoteDevice = result.getJSONObject("device"), remoteCaps = remoteDevice.getJSONObject("capabilities"), caps = new JSONObject();
            for (String grant : new String[]{"input", "create", "close", "quotas"}) caps.put(grant, remoteCaps.optBoolean(grant, false));
            JSONArray projects = remoteDevice.getJSONArray("projectIds"); for (int i = 0; i < projects.length(); i++) projects.getString(i);
            JSONObject device = new JSONObject().put("id", remoteDevice.getString("id")).put("label", remoteDevice.getString("label")).put("pairedAt", remoteDevice.getString("pairedAt")).put("expiresAt", remoteDevice.getString("expiresAt")).put("projectIds", projects).put("capabilities", caps);
            if (!Instant.parse(device.getString("expiresAt")).isAfter(Instant.now())) throw new IllegalStateException("El vínculo ya venció.");
            JSONObject approvedEndpoint = new JSONObject().put("kind", endpoint.getString("kind")).put("url", endpoint.getString("url"));
            if (endpoint.getString("kind").equals("lan-pinned")) approvedEndpoint.put("certSHA256", endpoint.getString("certSHA256"));
            String id = UUID.randomUUID().toString();
            JSONObject profile = new JSONObject().put("id", id).put("gatewayId", invitation.getString("gatewayId")).put("endpoint", approvedEndpoint).put("device", device);
            publicResponse(profile);
            assertCurrent(id, 0, e);
            store.save(id, new JSONObject().put("profile", profile).put("credential", result.getString("credential")));
            try { assertCurrent(id, 0, e); } catch (Exception cancelled) { store.delete(id); throw cancelled; }
            call.resolve(new JSObject().put("profile", profile));
        });
    }
    @PluginMethod public void listProfiles(PluginCall call) { execute(call, () -> {
        JSArray profiles = new JSArray(); for (String id : store.ids()) { try { profiles.put(record(id).getJSONObject("profile")); } catch (Exception invalid) { forget(id); } }
        call.resolve(new JSObject().put("profiles", profiles));
    }); }
    @PluginMethod public void deleteProfile(PluginCall call) {
        String id = call.getString("profileId", ""); forget(id); call.resolve();
    }
    @PluginMethod public void request(PluginCall call) {
        String id = call.getString("profileId", ""); long g = generation(id), e = epoch.get();
        execute(call, () -> {
            assertCurrent(id, g, e); JSONObject record = record(id); JSONObject profile = record.getJSONObject("profile");
            String path = call.getString("path", ""), method = call.getString("method", "GET"); EndpointPolicy.path(path, method);
            JSONObject caps = profile.getJSONObject("device").getJSONObject("capabilities");
            if ((path.equals("/api/v1/quotas") && !caps.optBoolean("quotas")) || (method.equals("POST") && path.equals("/api/v1/sessions") && !caps.optBoolean("create")) || (path.equals("/api/v1/close") && !caps.optBoolean("close"))) throw new IllegalStateException("El dispositivo no tiene permiso para esta acción.");
            Object result = http(profile.getJSONObject("endpoint"), path, method, call.getObject("body"), record.getString("credential"), id);
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
            JSONObject record = record(id), profile = record.getJSONObject("profile"), endpoint = profile.getJSONObject("endpoint");
            Object raw = http(endpoint, "/api/v1/sessions?hostId=" + host, "GET", null, record.getString("credential"), id);
            JSONArray sessions = raw instanceof JSONArray ? (JSONArray) raw : ((JSONObject) raw).getJSONArray("sessions");
            JSONObject session = null; for (int i = 0; i < sessions.length(); i++) if (sessions.getJSONObject(i).getString("id").equals(sessionId)) session = sessions.getJSONObject(i);
            if (session == null) throw new IllegalStateException("La sesión ya no está autorizada.");
            assertCurrent(id, g, e);
            if (streamGenerations.get(connectionId).get() != connectionGeneration) throw new IllegalStateException("Conexión cancelada antes de abrirse.");
            Stream stream = new Stream(connectionId, id, g, e, profile.getJSONObject("device").getJSONObject("capabilities").optBoolean("input") && session.optBoolean("canOperate") && !session.optBoolean("readOnly")); streams.put(connectionId, stream);
            String origin = EndpointPolicy.origin(endpoint);
            HttpUrl url = HttpUrl.get(origin + "/api/v1/stream").newBuilder().addQueryParameter("hostId", host).addQueryParameter("sessionId", sessionId).addQueryParameter("from", String.valueOf(from)).build();
            Request request = new Request.Builder().url(url).header("Origin", origin).header("Authorization", "Bearer " + record.getString("credential")).build();
            OkHttpClient client = client(endpoint).newBuilder().callTimeout(0, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).pingInterval(20, TimeUnit.SECONDS).build();
            stream.socket = client.newWebSocket(request, new WebSocketListener() {
                @Override public void onOpen(WebSocket socket, Response response) { if (!current(stream)) { socket.cancel(); return; } emit(stream, "connected", null); }
                @Override public void onMessage(WebSocket socket, String text) {
                    if (!current(stream)) return;
                    try { JSONObject frame = new JSONObject(text); publicResponse(frame); if (frame.optString("type").equals("ready")) stream.serverId = frame.getString("streamId"); if (frame.optString("type").equals("state") && frame.optJSONObject("info") != null && (!frame.getJSONObject("info").optBoolean("canOperate") || frame.getJSONObject("info").optBoolean("readOnly"))) stream.writable = false; emit(stream, null, text); } catch (Exception invalid) { emit(stream, "disconnected", null); stop(stream); }
                }
                @Override public void onClosed(WebSocket socket, int code, String reason) { emit(stream, "disconnected", null); stop(stream); client.connectionPool().evictAll(); client.dispatcher().executorService().shutdown(); }
                @Override public void onFailure(WebSocket socket, Throwable error, Response response) { if (response != null && response.code() == 401) { emit(stream, "revoked", null); forget(id); } else { emit(stream, "disconnected", null); stop(stream); } client.connectionPool().evictAll(); client.dispatcher().executorService().shutdown(); }
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
            try { http(record.getJSONObject("profile").getJSONObject("endpoint"), "/api/v1/" + type, "POST", body, record.getString("credential"), stream.profileId); }
            catch (Exception ambiguous) { emit(stream, "disconnected", null); stop(stream); throw ambiguous; }
            assertCurrent(stream.profileId, stream.generation, stream.epoch); if (!current(stream)) throw new IllegalStateException("La conexión cambió durante la acción. Verificá el resultado antes de repetirla."); call.resolve();
        });
    }
    @PluginMethod public void closeStream(PluginCall call) { String id = call.getString("connectionId", ""); streamGenerations.computeIfAbsent(id, ignored -> new AtomicLong()).incrementAndGet(); Stream stream = streams.get(id); if (stream != null) stop(stream); call.resolve(); }
    @Override protected void handleOnPause() { for (Stream stream : streams.values()) emit(stream, "disconnected", null); epoch.incrementAndGet(); for (Stream stream : streams.values()) stop(stream); }
    @Override protected void handleOnDestroy() { epoch.incrementAndGet(); for (Stream stream : streams.values()) stop(stream); worker.shutdownNow(); }
}
