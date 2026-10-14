package dev.crow.companion;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketAddress;
import java.net.SocketException;
import java.net.URI;
import java.nio.ByteBuffer;
import java.util.ArrayDeque;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import javax.net.SocketFactory;

import okhttp3.HttpUrl;
import okhttp3.ConnectionPool;
import okhttp3.Dispatcher;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * A byte-stream Socket backed by one binary WebSocket relay stream.
 *
 * The supplied OkHttpClient is intentionally the default-CA client for the outer WSS
 * connection. Callers layer their separately configured SSLSocketFactory over this
 * Socket for the end-to-end TLS connection to the gateway.
 */
public final class CrowRelayTunnelSocket extends Socket {
    static final int MAX_QUEUED_BYTES = 1024 * 1024;
    private static final long CONNECT_TIMEOUT_MILLIS = 12_000L;
    // The relay wraps device bytes in a 40-byte CHT1 + UUID envelope before
    // forwarding to the gateway, whose WebSocket frame limit is 64 KiB.
    private static final int MAX_FRAME_BYTES = (64 * 1024) - 40;
    private static final String ROUTE_PATTERN = "^[A-Za-z0-9_-]{43}$";

    private final OkHttpClient client;
    private final HttpUrl relayUrl;
    private final String route;
    private final String streamId = UUID.randomUUID().toString();
    private final Object lock = new Object();
    private final ArrayDeque<ByteBuffer> inbound = new ArrayDeque<>();
    private final CountDownLatch readyLatch = new CountDownLatch(1);
    private final InputStream input = new TunnelInputStream();
    private final OutputStream output = new TunnelOutputStream();

    private WebSocket webSocket;
    private IOException failure;
    private boolean connected;
    private boolean ready;
    private boolean closed;
    private boolean peerClosed;
    private boolean relayClosed;
    private int inboundBytes;
    private int soTimeoutMillis;

    public CrowRelayTunnelSocket(OkHttpClient defaultCaClient, String relayUrl, String route) {
        if (defaultCaClient == null) throw new IllegalArgumentException("OkHttp client is required");
        if (route == null || !route.matches(ROUTE_PATTERN)) throw new IllegalArgumentException("Invalid relay route");
        URI uri;
        try { uri = URI.create(relayUrl); }
        catch (IllegalArgumentException invalid) { throw new IllegalArgumentException("Invalid relay URL", invalid); }
        if (!"wss".equals(uri.getScheme()) || uri.getHost() == null || !"/v1/tunnel".equals(uri.getRawPath())
                || uri.getRawQuery() != null || uri.getRawFragment() != null || uri.getRawUserInfo() != null) {
            throw new IllegalArgumentException("Relay URL must be a private wss:// origin ending in /v1/tunnel");
        }
        HttpUrl parsed = HttpUrl.parse(relayUrl.replaceFirst("^wss:", "https:"));
        if (parsed == null) throw new IllegalArgumentException("Invalid relay URL");
        this.client = defaultCaClient.newBuilder()
                .dispatcher(new Dispatcher())
                .connectionPool(new ConnectionPool())
                .retryOnConnectionFailure(false)
                .followRedirects(false)
                .followSslRedirects(false)
                .build();
        this.relayUrl = parsed;
        this.route = route;
    }

    @Override
    public void connect(SocketAddress endpoint) throws IOException {
        connect(endpoint, (int) CONNECT_TIMEOUT_MILLIS);
    }

    @Override
    public void connect(SocketAddress endpoint, int timeout) throws IOException {
        synchronized (lock) {
            if (closed) throw new SocketException("Socket is closed");
            if (connected) throw new SocketException("Socket is already connected");
            connected = true;
        }

        Request request = new Request.Builder().url(relayUrl)
                .header("X-Crow-Route", route)
                .header("X-Crow-Role", "device")
                .header("X-Crow-Stream", streamId)
                .build();
        WebSocket created = client.newWebSocket(request, new RelayListener());
        synchronized (lock) {
            webSocket = created;
            if (closed) created.cancel();
        }

        long waitMillis = timeout > 0 ? Math.min(timeout, CONNECT_TIMEOUT_MILLIS) : CONNECT_TIMEOUT_MILLIS;
        try {
            if (!readyLatch.await(waitMillis, TimeUnit.MILLISECONDS)) {
                IOException timeoutError = new IOException("Timed out waiting for relay ready frame");
                fail(timeoutError);
                disposeTransport(created);
                throw timeoutError;
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            IOException interruptedError = new IOException("Interrupted while opening relay tunnel", interrupted);
            fail(interruptedError);
            disposeTransport(created);
            throw interruptedError;
        }
        synchronized (lock) {
            if (failure != null) { disposeTransport(created); throw failure; }
            if (!ready) { disposeTransport(created); throw new IOException("Relay closed before ready frame"); }
            if (closed) throw new SocketException("Socket is closed");
        }
    }

    @Override public boolean isConnected() { synchronized (lock) { return connected; } }
    @Override public boolean isClosed() { synchronized (lock) { return closed; } }
    @Override public boolean isBound() { synchronized (lock) { return connected; } }
    @Override public boolean isInputShutdown() { synchronized (lock) { return closed || peerClosed || relayClosed; } }
    @Override public boolean isOutputShutdown() { synchronized (lock) { return closed; } }
    @Override public InputStream getInputStream() throws IOException { ensureConnected(); return input; }
    @Override public OutputStream getOutputStream() throws IOException { ensureConnected(); return output; }
    @Override public InetAddress getInetAddress() { return null; }
    @Override public InetAddress getLocalAddress() { return InetAddress.getLoopbackAddress(); }
    @Override public int getPort() { return 0; }
    @Override public int getLocalPort() { return 0; }
    @Override public SocketAddress getRemoteSocketAddress() { return null; }
    @Override public SocketAddress getLocalSocketAddress() { return null; }
    @Override public void bind(SocketAddress bindpoint) throws IOException { if (isClosed()) throw new SocketException("Socket is closed"); }
    @Override public void setSoTimeout(int timeout) throws SocketException {
        if (timeout < 0) throw new IllegalArgumentException("timeout < 0");
        synchronized (lock) { soTimeoutMillis = timeout; }
    }
    @Override public int getSoTimeout() { synchronized (lock) { return soTimeoutMillis; } }
    @Override public void setTcpNoDelay(boolean on) { }
    @Override public boolean getTcpNoDelay() { return true; }
    @Override public void setKeepAlive(boolean on) { }
    @Override public boolean getKeepAlive() { return false; }
    @Override public void setReuseAddress(boolean on) { }
    @Override public boolean getReuseAddress() { return false; }
    @Override public void setSendBufferSize(int size) throws SocketException { if (size <= 0) throw new IllegalArgumentException("size <= 0"); }
    @Override public int getSendBufferSize() { return MAX_QUEUED_BYTES; }
    @Override public void setReceiveBufferSize(int size) throws SocketException { if (size <= 0) throw new IllegalArgumentException("size <= 0"); }
    @Override public int getReceiveBufferSize() { return MAX_QUEUED_BYTES; }

    @Override
    public void shutdownInput() {
        synchronized (lock) {
            peerClosed = true;
            inbound.clear();
            inboundBytes = 0;
            lock.notifyAll();
        }
    }

    @Override
    public void shutdownOutput() throws IOException {
        close();
    }

    @Override
    public void close() {
        WebSocket socket;
        synchronized (lock) {
            if (closed) return;
            closed = true;
            peerClosed = true;
            inbound.clear();
            inboundBytes = 0;
            socket = webSocket;
            lock.notifyAll();
        }
        readyLatch.countDown();
        if (socket != null) {
            socket.close(1000, "closed");
            socket.cancel();
        }
        client.connectionPool().evictAll();
        client.dispatcher().executorService().shutdown();
    }

    private void ensureConnected() throws IOException {
        synchronized (lock) {
            if (closed) throw new SocketException("Socket is closed");
            if (!connected || !ready) throw new SocketException("Socket is not connected");
            if (failure != null) throw failure;
            if (relayClosed) throw new SocketException("Relay tunnel is closed");
        }
    }

    private void disposeTransport(WebSocket socket) {
        socket.cancel();
        client.connectionPool().evictAll();
        client.dispatcher().executorService().shutdown();
    }

    private void fail(IOException error) {
        synchronized (lock) {
            if (failure == null) failure = error;
            peerClosed = true;
            relayClosed = true;
            inbound.clear();
            inboundBytes = 0;
            lock.notifyAll();
        }
        readyLatch.countDown();
    }

    private final class RelayListener extends WebSocketListener {
        @Override public void onMessage(WebSocket socket, String text) {
            if (readyLatch.getCount() != 0 && isReadyFrame(text)) {
                synchronized (lock) { ready = true; }
                readyLatch.countDown();
                return;
            }
            fail(new IOException("Unexpected text frame on binary relay tunnel"));
            socket.cancel();
        }

        @Override public void onMessage(WebSocket socket, ByteString bytes) {
            byte[] copy = bytes.toByteArray();
            if (copy.length > MAX_FRAME_BYTES) {
                fail(new IOException("Relay binary frame exceeds 64 KiB"));
                socket.cancel();
                return;
            }
            synchronized (lock) {
                if (readyLatch.getCount() != 0 || closed || peerClosed) {
                    fail(new IOException("Binary relay data arrived before ready"));
                    socket.cancel();
                    return;
                }
                if (copy.length > MAX_QUEUED_BYTES - inboundBytes) {
                    fail(new IOException("Relay inbound queue exceeds 1 MiB"));
                    socket.cancel();
                    return;
                }
                if (copy.length > 0) {
                    inbound.addLast(ByteBuffer.wrap(copy));
                    inboundBytes += copy.length;
                }
                lock.notifyAll();
            }
        }

        @Override public void onFailure(WebSocket socket, Throwable error, Response response) {
            fail(error instanceof IOException ? (IOException) error : new IOException("Relay WebSocket failed", error));
        }

        @Override public void onClosed(WebSocket socket, int code, String reason) {
            synchronized (lock) { peerClosed = true; relayClosed = true; lock.notifyAll(); }
            readyLatch.countDown();
        }
    }

    private boolean isReadyFrame(String value) {
        try {
            org.json.JSONObject json = new org.json.JSONObject(value);
            return "ready".equals(json.optString("type")) && streamId.equals(json.optString("streamId"));
        } catch (org.json.JSONException ignored) {
            return false;
        }
    }

    private final class TunnelInputStream extends InputStream {
        @Override public int read() throws IOException {
            byte[] one = new byte[1];
            return read(one, 0, 1) == -1 ? -1 : one[0] & 0xff;
        }

        @Override public int read(byte[] bytes, int offset, int length) throws IOException {
            if (bytes == null) throw new NullPointerException("bytes");
            if (offset < 0 || length < 0 || length > bytes.length - offset) throw new IndexOutOfBoundsException();
            if (length == 0) return 0;
            synchronized (lock) {
                long deadline = soTimeoutMillis > 0 ? System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(soTimeoutMillis) : 0;
                while (inbound.isEmpty() && !closed && !peerClosed && failure == null) {
                    try {
                        if (deadline == 0) lock.wait();
                        else {
                            long remaining = deadline - System.nanoTime();
                            if (remaining <= 0) throw new java.net.SocketTimeoutException("Relay tunnel read timed out");
                            TimeUnit.NANOSECONDS.timedWait(lock, remaining);
                        }
                    }
                    catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw new IOException("Interrupted while reading relay tunnel", interrupted);
                    }
                }
                if (failure != null) throw failure;
                if (inbound.isEmpty()) return -1;
                ByteBuffer head = inbound.peekFirst();
                int count = Math.min(length, head.remaining());
                head.get(bytes, offset, count);
                inboundBytes -= count;
                if (!head.hasRemaining()) inbound.removeFirst();
                return count;
            }
        }

        @Override public int available() { synchronized (lock) { return inboundBytes; } }
        @Override public void close() { CrowRelayTunnelSocket.this.close(); }
    }

    private final class TunnelOutputStream extends OutputStream {
        @Override public void write(int value) throws IOException { write(new byte[]{(byte) value}); }

        @Override public void write(byte[] bytes, int offset, int length) throws IOException {
            if (bytes == null) throw new NullPointerException("bytes");
            if (offset < 0 || length < 0 || length > bytes.length - offset) throw new IndexOutOfBoundsException();
            if (length == 0) return;
            ensureConnected();
            synchronized (lock) {
                WebSocket socket = webSocket;
                if (socket == null) throw new IOException("Relay WebSocket is unavailable");
                int end = offset + length;
                for (int start = offset; start < end;) {
                    int count = Math.min(MAX_FRAME_BYTES, end - start);
                    if (socket.queueSize() > MAX_QUEUED_BYTES - count) {
                        IOException overflow = new IOException("Relay outbound queue exceeds 1 MiB");
                        fail(overflow);
                        socket.cancel();
                        throw overflow;
                    }
                    byte[] copy = new byte[count];
                    System.arraycopy(bytes, start, copy, 0, count);
                    if (!socket.send(ByteString.of(copy))) {
                        IOException rejected = new IOException("Relay WebSocket rejected binary frame");
                        fail(rejected);
                        socket.cancel();
                        throw rejected;
                    }
                    start += count;
                }
            }
        }

        @Override public void close() { CrowRelayTunnelSocket.this.close(); }
        @Override public void flush() throws IOException { ensureConnected(); }
    }

    /** Creates a fresh, isolated tunnel Socket for each inner TLS connection. */
    public static final class Factory extends SocketFactory {
        private final OkHttpClient defaultCaClient;
        private final String relayUrl;
        private final String route;

        public Factory(OkHttpClient defaultCaClient, String relayUrl, String route) {
            this.defaultCaClient = defaultCaClient;
            this.relayUrl = relayUrl;
            this.route = route;
        }

        private CrowRelayTunnelSocket open() { return new CrowRelayTunnelSocket(defaultCaClient, relayUrl, route); }
        @Override public Socket createSocket() { return open(); }
        @Override public Socket createSocket(String host, int port) throws IOException { return connect(open(), InetSocketAddress.createUnresolved(host, port)); }
        @Override public Socket createSocket(String host, int port, InetAddress localHost, int localPort) throws IOException { return createSocket(host, port); }
        @Override public Socket createSocket(InetAddress host, int port) throws IOException { return connect(open(), new InetSocketAddress(host, port)); }
        @Override public Socket createSocket(InetAddress address, int port, InetAddress localAddress, int localPort) throws IOException { return createSocket(address, port); }

        private Socket connect(CrowRelayTunnelSocket socket, SocketAddress address) throws IOException {
            socket.connect(address);
            return socket;
        }
    }
}
