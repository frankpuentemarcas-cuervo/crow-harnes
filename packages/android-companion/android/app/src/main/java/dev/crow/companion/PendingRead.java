package dev.crow.companion;

import okhttp3.Call;

/** Cancels only this read, including its sequential challenge/renewal HTTP calls. */
final class PendingRead {
    final String profileId;
    private boolean cancelled;
    private Call active;
    PendingRead(String profileId) { this.profileId = profileId; }
    synchronized void check() { if (cancelled) throw new IllegalStateException("Lectura cancelada."); }
    synchronized void attach(Call call) { if (cancelled) { call.cancel(); check(); } active = call; }
    synchronized void detach(Call call) { if (active == call) active = null; }
    synchronized void cancel() { cancelled = true; if (active != null) active.cancel(); }
}
