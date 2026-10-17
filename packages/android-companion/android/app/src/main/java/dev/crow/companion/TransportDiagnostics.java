package dev.crow.companion;

import java.io.IOException;
import java.io.InterruptedIOException;
import java.net.SocketTimeoutException;
import java.util.concurrent.CancellationException;
import javax.net.ssl.SSLException;

/** Bounded, credential-safe transport error metadata for native-to-UI diagnostics. */
final class TransportDiagnostics {
    static final class RelayPeerClosedException extends IOException {
        RelayPeerClosedException() { super("Relay peer closed"); }
    }
    static final class Failure {
        final String stage, code;
        final boolean retryable;
        Failure(String stage, String code, boolean retryable) { this.stage = stage; this.code = code; this.retryable = retryable; }
        String message() { return "Crow transport failed (" + stage + "/" + code + ")."; }
    }
    private TransportDiagnostics() {}

    static String mutationRequestId(String path, String supplied) {
        if ("/api/v2/chat-submit".equals(path)) {
            if (supplied == null || !supplied.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) throw new IllegalArgumentException("Identificador de envío inválido.");
            return supplied;
        }
        return java.util.UUID.randomUUID().toString();
    }

    static Failure classify(String rawStage, Throwable error) {
        String stage = rawStage != null && rawStage.matches("renew|request|connect|send|stream|response") ? rawStage : "request";
        String code = "network_io";
        boolean retryable = false;
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof SSLException || cause instanceof java.security.cert.CertificateException) { code = "tls"; break; }
            if (cause instanceof SocketTimeoutException) { code = "timeout"; retryable = true; break; }
            if (cause instanceof RelayPeerClosedException) { code = "relay_peer_closed"; retryable = true; break; }
            if (cause instanceof CancellationException || cause instanceof InterruptedException || cause instanceof InterruptedIOException) { code = "canceled"; break; }
        }
        // A timeout or peer close after a mutating write is ambiguous, never safe to replay.
        if ("send".equals(stage) || "renew".equals(stage)) retryable = false;
        return new Failure(stage, code, retryable);
    }
}
