package dev.crow.companion;

import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import org.junit.Test;
import static org.junit.Assert.*;

public class PendingReadTest {
    private Call call() { return new OkHttpClient().newCall(new Request.Builder().url("http://127.0.0.1/").build()); }
    @Test public void queuedCancellationPreventsAnyHttpCall() {
        PendingRead pending = new PendingRead("factory"); pending.cancel();
        Call call = call();
        try { pending.attach(call); fail("cancelled read attached"); } catch (IllegalStateException expected) { }
        assertTrue(call.isCanceled());
    }
    @Test public void cancellingOneReadPreservesSiblingCallsAndStreams() {
        PendingRead first = new PendingRead("factory"), second = new PendingRead("factory");
        Call a = call(), b = call(); first.attach(a); second.attach(b); first.cancel();
        assertTrue(a.isCanceled()); assertFalse(b.isCanceled()); second.check();
    }
    @Test public void deadlineAlsoCancelsTheNextRenewalStep() {
        PendingRead pending = new PendingRead("factory"); Call challenge = call(), renewal = call();
        pending.attach(challenge); pending.detach(challenge); pending.cancel();
        assertFalse(challenge.isCanceled());
        try { pending.attach(renewal); fail("cancelled renewal attached"); } catch (IllegalStateException expected) { }
        assertTrue(renewal.isCanceled());
    }
}
