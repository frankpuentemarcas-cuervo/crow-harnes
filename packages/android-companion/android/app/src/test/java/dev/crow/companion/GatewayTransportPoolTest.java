package dev.crow.companion;

import org.junit.Test;
import static org.junit.Assert.*;
import okhttp3.OkHttpClient;

public class GatewayTransportPoolTest {
    @Test public void reusesOnlyTheSameProfileAndTrustBinding() throws Exception {
        GatewayTransportPool pool = new GatewayTransportPool();
        OkHttpClient first = pool.get("a", "origin|pin|route", OkHttpClient::new);
        assertSame(first, pool.get("a", "origin|pin|route", () -> { throw new AssertionError("unnecessary TLS client"); }));
        OkHttpClient other = pool.get("b", "origin|pin|route", OkHttpClient::new);
        assertNotSame(first, other);
        OkHttpClient changed = pool.get("a", "origin|different-pin|route", OkHttpClient::new);
        assertNotSame(first, changed);
        assertTrue(first.dispatcher().executorService().isShutdown());
        assertFalse(other.dispatcher().executorService().isShutdown());
        pool.remove("a");
        assertTrue(changed.dispatcher().executorService().isShutdown());
        assertFalse(other.dispatcher().executorService().isShutdown());
        pool.clear();
        assertTrue(other.dispatcher().executorService().isShutdown());
    }
}
