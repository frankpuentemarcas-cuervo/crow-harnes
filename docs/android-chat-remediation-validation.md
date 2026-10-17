# Android chat remediation: validation checkpoint

**Local integration checks pass, but this is not release-ready until a newly built APK passes real-device gates.** The reported relay/IO root cause remains unproven; transport errors are now classified safely and mutation failures are never automatically replayed.

## Verified locally

| Check | Result |
|---|---|
| `npm test` | Pass — 359/359 |
| `npm run typecheck` | Pass (`tsc --noEmit`) |
| `npm test --prefix packages/android-companion` | Pass — 101/101 |
| `npm run typecheck --prefix packages/android-companion` | Pass |
| `node tests/chat-fluidity-electron.mjs` | Pass — actual ChatView flow in simulated transport; no duplicate send |
| `node --test tests/mobile-gateway.test.mjs` | Pass — 46/46 |
| `go test ./...` (from `remote/`) | Pass |
| Focused Android Java JUnit + full plugin `javac` against cached Capacitor 8 classes | Pass in prior native validation; Java sources unchanged since |

## Proven behavior and limits

- A structured send is reserved durably and correlated with durable user-hook history; ambiguous outcomes remain observable and do not resend.
- Native diagnostics expose only allowlisted stage/code/retriability, not raw exception text, URL, credentials, or transcript. An affected stream can reconnect without signing out or canceling unrelated streams.
- Synthetic relay and simulated Electron tests do **not** prove behavior against a real provider or current APK. The exact cause of the earlier `IOException` remains unknown.
- Ledger records are pruned only after a session has been durably deleted and its deletion marker removed; active or recoverable sessions retain their operation history. The ledger still has a hard 4096-entry fail-closed cap, so capacity remains a release constraint for active/recoverable sessions.

## Required before release

- [ ] Build/install is separately authorized; validate the new APK using the existing real enrolled QA profile. Preserve its installation trust across the APK update; do not uninstall, reset, or require another QR scan for normal chat validation.
- [ ] Separately exercise the one-time QR flow with a dedicated test device/profile as an enrollment regression; this is not a prerequisite for updating the chat test device.
- [ ] Complete 20 real sends and verify each produces one matching durable user hook and one expected response; verify no duplicate on ambiguous acknowledgement.
- [ ] Run 10 foreground/background transitions and a 30-minute active session with real messages while backgrounded, including an idle interval, plus network loss/recovery and a separate off-PC/device scenario.
- [ ] Record sanitized diagnostics and confirm reconnect restores reading without repeating a mutation.
- [ ] Decide and document an operation-ledger retention/rotation policy before approaching the 4096-entry cap.
