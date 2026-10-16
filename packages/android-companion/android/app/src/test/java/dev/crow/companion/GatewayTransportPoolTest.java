package dev.crow.companion;

import org.junit.Test;
import static org.junit.Assert.*;
import okhttp3.OkHttpClient;
import okhttp3.Dispatcher;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public class GatewayTransportPoolTest {
    @Test public void tlsCleanupNeverRunsOnTheLifecycleCallerThread() throws Exception {
        Thread caller = Thread.currentThread();
        AtomicReference<Thread> cleanupThread = new AtomicReference<>();
        CountDownLatch closed = new CountDownLatch(1);
        ThreadPoolExecutor executor = new ThreadPoolExecutor(0, 1, 1, TimeUnit.SECONDS, new LinkedBlockingQueue<>()) {
            @Override public void shutdown() { cleanupThread.set(Thread.currentThread()); super.shutdown(); closed.countDown(); }
        };
        OkHttpClient client = new OkHttpClient.Builder().dispatcher(new Dispatcher(executor)).build();
        GatewayTransportPool.release(client);
        assertTrue("transport was not released", closed.await(5, TimeUnit.SECONDS));
        assertNotSame("TLS close must not write close_notify on the Android UI caller", caller, cleanupThread.get());
    }
    private void awaitReleased(OkHttpClient client) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (!client.dispatcher().executorService().isShutdown() && System.nanoTime() < deadline) Thread.sleep(10);
        assertTrue(client.dispatcher().executorService().isShutdown());
    }
    @Test public void reusesOnlyTheSameProfileAndTrustBinding() throws Exception {
        GatewayTransportPool pool = new GatewayTransportPool();
        OkHttpClient first = pool.get("a", "origin|pin|route", OkHttpClient::new);
        assertSame(first, pool.get("a", "origin|pin|route", () -> { throw new AssertionError("unnecessary TLS client"); }));
        OkHttpClient other = pool.get("b", "origin|pin|route", OkHttpClient::new);
        assertNotSame(first, other);
        OkHttpClient changed = pool.get("a", "origin|different-pin|route", OkHttpClient::new);
        assertNotSame(first, changed);
        awaitReleased(first);
        assertFalse(other.dispatcher().executorService().isShutdown());
        pool.remove("a");
        awaitReleased(changed);
        assertFalse(other.dispatcher().executorService().isShutdown());
        pool.clear();
        awaitReleased(other);
    }
}
