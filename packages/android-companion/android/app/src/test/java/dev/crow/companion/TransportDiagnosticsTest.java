package dev.crow.companion;

import org.junit.Test;
import java.io.IOException;
import java.net.SocketTimeoutException;
import javax.net.ssl.SSLHandshakeException;
import static org.junit.Assert.*;

public class TransportDiagnosticsTest {
    @Test public void classifiesFailuresWithoutExposingThrowableMessages() {
        TransportDiagnostics.Failure tls = TransportDiagnostics.classify("renew", new SSLHandshakeException("secret host and cert details"));
        assertEquals("tls", tls.code);
        assertEquals("renew", tls.stage);
        assertFalse(tls.retryable);
        assertFalse(tls.message().contains("secret"));

        TransportDiagnostics.Failure timeout = TransportDiagnostics.classify("response", new SocketTimeoutException("Authorization: secret"));
        assertEquals("timeout", timeout.code);
        assertTrue(timeout.retryable);
        assertFalse(timeout.message().contains("secret"));
        assertFalse(TransportDiagnostics.classify("send", new SocketTimeoutException("ambiguous write")).retryable);
        assertFalse(TransportDiagnostics.classify("renew", new SocketTimeoutException("ambiguous renewal")).retryable);

        TransportDiagnostics.Failure io = TransportDiagnostics.classify("send", new IOException("request body secret"));
        assertEquals("network_io", io.code);
        assertEquals("send", io.stage);
        assertFalse(io.retryable);

        TransportDiagnostics.Failure peer = TransportDiagnostics.classify("send", new TransportDiagnostics.RelayPeerClosedException());
        assertEquals("relay_peer_closed", peer.code);
        assertFalse(peer.retryable);
    }

    @Test public void preservesChatSubmitIdButGeneratesFreshIdsForOtherMutations() {
        String requestId = "123e4567-e89b-42d3-a456-426614174000";
        assertEquals(requestId, TransportDiagnostics.mutationRequestId("/api/v2/chat-submit", requestId));
        String inputOne = TransportDiagnostics.mutationRequestId("/api/v1/input", null);
        String inputTwo = TransportDiagnostics.mutationRequestId("/api/v1/input", null);
        assertNotEquals(inputOne, inputTwo);
        try { TransportDiagnostics.mutationRequestId("/api/v2/chat-submit", "not-a-uuid"); fail("invalid UUID accepted"); }
        catch (IllegalArgumentException expected) { }
    }
}
