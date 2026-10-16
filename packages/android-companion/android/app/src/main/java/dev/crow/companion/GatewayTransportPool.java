package dev.crow.companion;

import java.util.HashMap;
import java.util.Map;
import okhttp3.OkHttpClient;

/** Reuse pinned TLS/relay connections only within the same profile and trust binding.
 * Credentials remain per-request headers and are never retained in a client. */
final class GatewayTransportPool {
    interface Factory { OkHttpClient create() throws Exception; }
    private static final class Entry {
        final String binding; final OkHttpClient client;
        Entry(String binding, OkHttpClient client) { this.binding = binding; this.client = client; }
    }
    private final Map<String, Entry> clients = new HashMap<>();
    synchronized OkHttpClient get(String profile, String binding, Factory factory) throws Exception {
        Entry entry = clients.get(profile);
        if (entry != null && entry.binding.equals(binding)) return entry.client;
        OkHttpClient client = factory.create();
        if (entry != null) release(entry.client);
        clients.put(profile, new Entry(binding, client));
        return client;
    }
    synchronized void remove(String profile) {
        Entry entry = clients.remove(profile);
        if (entry != null) release(entry.client);
    }
    synchronized void clear() {
        for (Entry entry : clients.values()) release(entry.client);
        clients.clear();
    }
    static void release(OkHttpClient client) {
        client.dispatcher().cancelAll();
        client.connectionPool().evictAll();
        client.dispatcher().executorService().shutdown();
    }
}
