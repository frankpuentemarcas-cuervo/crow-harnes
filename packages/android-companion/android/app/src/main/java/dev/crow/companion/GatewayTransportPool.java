package dev.crow.companion;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import okhttp3.OkHttpClient;

/** Reuse pinned TLS/relay connections only within the same profile and trust binding.
 * Credentials remain per-request headers and are never retained in a client. */
final class GatewayTransportPool {
    // Conscrypt may write TLS close_notify while evicting an idle connection.
    // Lifecycle callbacks run on Android's UI thread, even when no request is active.
    private static final ExecutorService CLEANUP = Executors.newSingleThreadExecutor(task -> {
        Thread thread = new Thread(task, "crow-transport-cleanup"); thread.setDaemon(true); return thread;
    });
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
        CLEANUP.execute(() -> {
            try { client.dispatcher().cancelAll(); }
            finally {
                try { client.connectionPool().evictAll(); }
                finally { client.dispatcher().executorService().shutdown(); }
            }
        });
    }
}
