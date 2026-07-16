# Ambient sharing - design + how it plugs into the apps

The AirDrop-style layer for OGAS: a capture (screenshot / photo / file) is noticed, run through a
user-controlled policy, and pushed to paired devices - no taps in the common case. Built in
`@easyshare/shared` as pure logic + one owning service, layered ON TOP of each app's EXISTING
device-to-device transfer. The sharing layer decides WHAT / WHO / WHEN; the app's proven transport
(which already streams and HTTP-accelerates large files) moves the bytes.

## The two axes (kept independent on purpose)

- **WHEN to share - the policy.** Per capture source x per destination device, one of `off` / `ask` /
  `auto`. The user is in control: no rule means `off`. A device-specific rule overrides the `*`
  default. Offline behaviour is `skip` or `queue`. This is `sharing/policy.ts` (pure) +
  `sharing/service.ts` (the owning service).
- **HOW the devices reach each other - the transport.** Today: same-LAN mDNS + TCP (with HTTP
  acceleration for files >5MB), already shipping in both apps. The sharing layer is transport-agnostic:
  it hands a file + destination to a `FileSender` and never touches sockets. Future rungs (proximity,
  off-network relay) slot in behind the same `FileSender` without changing the policy layer.

## Why the policy layer sits on the existing transport (not a new one)

An earlier cut of this built a parallel transport in `@easyshare/shared` (a `TransferSession` +
encrypted `SecureChannel` + socket/fs ports). It was removed because it did not integrate:
- it buffered whole files in memory (`reassembleChunks`), a regression vs. the apps' streaming +
  HTTP path for large files (the stated scope is "any file", including big ones);
- its wire framing was incompatible with the apps' single multiplexed message plane, and it assumed
  exclusive ownership of the socket - it could not coexist with pairing / ping / text on the same
  connection.

So the transport stays in the apps, and the new, genuinely-additive part is the policy/queue/watcher
plus a thin `FileSender` adapter over the existing `sendFile`.

## What's built + verified (in `packages/shared/src`)

| Piece | File | Role |
|---|---|---|
| Capture/policy types | `sharing/types.ts` | `CaptureSource`, `ShareMode`, `SharePolicy`, `ShareRule`, `ShareDecision` |
| Decision engine (pure) | `sharing/policy.ts` | `decideShares`, `resolveMode`, `setRule`, `emptyPolicy` |
| Capture guard (pure) | `sharing/watcher.ts` | `CaptureWatcher` port + `shouldEmit` (dedup + anti-loop) |
| Pending queue (pure) | `sharing/queue.ts` | offline `queue`, drained on reconnect |
| Owning service + port | `sharing/service.ts` | `AmbientShareService` + the `FileSender` port |

Verified by `test/ambient-share.test.mts`: the real `AmbientShareService` + policy + queue over a
behavior-faithful fake transport (the `FileSender` boundary). Covers auto / off / ask, per-device
override, offline queue-then-drain, offline skip, and the watcher dedup + anti-loop guards. Falsified
(break the policy -> the policy tests go red).

The bundle also fixes an ESM packaging bug: the CJS crypto deps (`tweetnacl`, `tweetnacl-util`,
`js-sha512`) are now bundled + a `createRequire` shim injected, so every ESM consumer of
`@easyshare/shared` works (previously the ESM entry threw on import). See `tsup.config.ts`.

## Desktop integration (built + verified)

- **`ConnectionFileSender`** (`desktop/src/main/sharing/connection-file-sender.ts`) - implements
  `FileSender` over the existing `ConnectionManager.sendFile`. Tracks the connected device from the
  app's connection-state callback (fed via `updateConnection`, so it does not clobber the app's own
  handler) and fires `onReconnect` to drain the queue.
- **Storage seam** - `ConnectionManager` now depends on a small `ConnectionStorage` interface
  (`getSettings` + `addPairedDevice`) instead of the electron-coupled `StorageService` concrete
  (behavior-neutral; `StorageService` satisfies it). This is what lets it run headless in a real test.
- Verified by `desktop/test/sharing.test.mts`: **two real `ConnectionManager`s pair over a real TCP
  loopback, then the real `AmbientShareService` -> `ConnectionFileSender` -> the real transfer lands
  a captured screenshot on the receiver's real save directory, byte-identical.** Only the persistence
  boundary is faked. Falsified (break the sender routing -> the auto test goes red).

## What is still greenfield (needs a running app / device)

1. **Wire it into the live app.** Construct `ConnectionFileSender` + `AmbientShareService` in
   `desktop/src/main/index.ts`, feed connection state via `updateConnection`, load the policy from
   settings, and forward received-file toasts. Mobile: the same, over `useConnection`'s `sendFile`.
2. **Native `CaptureWatcher`** - macOS `NSMetadataQuery` on `kMDItemIsScreenCapture` + FSEvents;
   Android `MediaStore` `ContentObserver`. Each raw event goes through `shouldEmit` (dedup + ignore
   the app's save dir, the anti-loop path) before `handleCapture`. iOS is manual-push only.
3. **Settings UI** - a "Device Sharing" section (pair devices + the source x mode matrix + offline
   toggle) binding to `setRule`; default everything `off`, visible active indicator. Desktop:
   `SettingsView.tsx` after Preferences + IPC (`sharing:setPolicy` / `getPolicy` /
   `listConnectedDevices`). Mobile: `SettingsScreen.tsx` after Preferences.
4. **Multi-device mesh** - the existing transport is single-connection; sharing to several devices at
   once needs the transport extended to concurrent connections. `FileSender.connectedDeviceIds()`
   already models a set, so the policy layer is ready for it.
5. **Transport ladder** - proximity + off-network relay rungs, behind the same `FileSender`.

## Build order for the app step
(a) Wire the desktop `ConnectionFileSender` + `AmbientShareService` into `index.ts` and verify by
running the app. (b) Settings share-mode matrix + IPC. (c) Native `CaptureWatcher`. (d) Receive toast
+ Undo. (e) Mobile mirror. (f) Multi-device transport, then the proximity / off-network rungs.
