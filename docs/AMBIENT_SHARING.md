# Ambient sharing - design + how it plugs into the apps

The AirDrop-style layer for OGAS: a capture (screenshot / photo / file) is noticed, run through a
user-controlled policy, and pushed to paired devices - no taps in the common case. Built in
`@easyshare/shared` as pure logic + one owning service over two injected ports, so mobile and
desktop share one implementation and only supply the native socket + filesystem.

## The two axes (kept independent on purpose)

- **WHEN to share - the policy.** Per capture source × per destination device, one of `off` / `ask` /
  `auto`. The user is in control: no rule means `off`. A device-specific rule overrides the `*`
  default. Offline behaviour is `skip` or `queue`. This is `sharing/policy.ts` (pure) +
  `sharing/service.ts` (the orchestrator).
- **HOW the devices reach each other - the transport ladder.** Proximity (no shared network) → same
  LAN (what OGAS does today) → off-network blind relay. The sharing layer is transport-agnostic: it
  hands a file + destination to a `FileSender`; the transport underneath is free to pick the best
  path. The ladder itself is not built yet (see "Not built").

## What's built (in `packages/shared/src`)

| Piece | File | Role |
|---|---|---|
| Capture/policy types | `sharing/types.ts` | `CaptureSource`, `ShareMode`, `SharePolicy`, `ShareRule`, `ShareDecision` |
| Decision engine (pure) | `sharing/policy.ts` | `decideShares`, `resolveMode`, `setRule`, `emptyPolicy` |
| Capture guard (pure) | `sharing/watcher.ts` | `CaptureWatcher` port + `shouldEmit` (dedup + anti-loop) |
| Pending queue (pure) | `sharing/queue.ts` | offline `queue`, drained on reconnect |
| Owning service | `sharing/service.ts` | `AmbientShareService` + the `FileSender` port |
| Transfer session | `session/index.ts` | `TransferSession` - the encrypted request→chunk→verify→write state machine over `ByteChannel` + `FileStore` |
| Boundary ports | `session/ports.ts` | `ByteChannel` (socket), `FileStore` (disk) |

All of it is verified by `test/ambient-share.test.mts` - two real sessions over an in-memory channel
pair + in-memory fs, asserting the file that lands on the receiver, byte-identical. The only fakes
are the socket and the disk. Falsified both ways (break the policy → policy tests red; break the
write-guard → integrity test red).

Note: the new `TransferSession` encrypts every frame end-to-end (NaCl secretbox, length-prefixed).
The legacy app transfer path (`connection.ts` / `useConnection.ts`) still frames messages in the
clear; migrating it onto `TransferSession` / `SecureChannel` (the app step below) is what encrypts
the wire everywhere.

## How it plugs into mobile and desktop (the next step - NOT done here)

Verified against the real app code on 2026-07-15. Both apps are structurally symmetric: same
`@easyshare/shared` primitives, same handshake, currently-plaintext wire, a Settings screen with a
card/toggle pattern, and a paired-device store that already persists the shared secret. The apps
implement thin adapters and wire them; no sharing logic moves into the apps.

### Attach points (exact)

| Adapter | Mobile (`packages/mobile`) | Desktop (`packages/desktop`) |
|---|---|---|
| `ByteChannel.send` | `src/hooks/useConnection.ts:682` (`socket.write`) | `src/main/connection.ts:1473` (`sendMessage` → `socket.write`) |
| `ByteChannel.onData` | `useConnection.ts:784` (`socket.on('data')`) | `connection.ts:553` (`socket.on('data')`) |
| `FileStore` write | `useConnection.ts:479/637` (RNFS append/write) | `connection.ts:968/1080` (stream/`fs.writeFile`) |
| `FileStore` read | `useConnection.ts:1021/1179` (RNFS read) | `connection.ts:441` (`fs.readFile`) |
| `FileStore.inboundPath` | RNFS DownloadDir | `connection.ts:1004` (`settings.saveDirectory`) |
| Paired-device store | `src/hooks/useStorage.ts` - AsyncStorage `@easyshare/paired_devices` (has `sharedSecret`) | `src/main/storage.ts:56-76` - electron-store (has `sharedSecret`) |
| Settings insertion | `src/screens/SettingsScreen.tsx` after Preferences (~line 324) | `src/renderer/views/SettingsView.tsx` after Preferences (~line 220) |

### Built since (shared + desktop adapters)

- **`SessionRegistry`** (`shared/src/session/registry.ts`) - the mesh piece: `Map<deviceId,
  TransferSession>` implementing `FileSender`. Platform-agnostic (takes a `ByteChannel`), so both
  apps reuse it. Verified by the desktop integration test over a real TCP socket pair + real fs.
- **Desktop adapters** - `SocketChannel` (`net.Socket` → `ByteChannel`) and `FsFileStore`
  (`node:fs` → `FileStore`) in `desktop/src/main/sharing/`.

### What each side still needs (greenfield)

1. **Wire the registry into the live connection lifecycle** - BOTH apps still track ONE connected
   device (mobile `connectionState.device`; desktop `connection.ts:59 connectedDevice`). On pair/
   connect call `registry.connect(id, channel, secret)`, on disconnect `registry.disconnect(id)`,
   and start an `AmbientShareService`. Needs a running app to verify.
2. **`CaptureWatcher` (native, per platform)** - greenfield everywhere. macOS: `NSMetadataQuery`
   on `kMDItemIsScreenCapture` (screenshots) + FSEvents; Android: `MediaStore` `ContentObserver`.
   Each raw event goes through `shouldEmit` (dedup + ignore `inboundPath` dir) before
   `AmbientShareService.handleCapture`. iOS is manual-push only.
3. **Settings UI - the share-mode matrix** - greenfield. Binds source × destination × mode to
   `setRule` + the offline toggle; extend `AppSettings` (`shared/src/types/index.ts:255`) and each
   app's settings persistence. Default everything `off`; visible "sharing active" indicator.
4. **Desktop IPC** - add `sharing:setPolicy` / `sharing:getPolicy` / `sharing:listConnectedDevices`
   handlers (`src/main/index.ts` after line 251) + preload wrappers + an `ambient:capture` emit,
   mirroring the existing `transfer:*` IPC pattern.
5. **Receive affordance** - a toast/notification on auto-receive with Undo (uses `addedIds`).
   Greenfield both (desktop has a `notificationsEnabled` setting but no Notification calls).
6. **Design alignment** - neither app uses `@offgrid/design`. Mobile hardcodes colors + emoji
   icons; desktop uses Tailwind neutrals + `@tabler/icons` (brand calls for `@phosphor-icons/react`
   on desktop, Feather via `react-native-vector-icons` on mobile). Aligning is its own pass.

### Recommended build order for the app step
LAN transport is already solved, so: (a) migrate the existing transfer path onto `TransferSession`
behind `ByteChannel`/`FileStore` (behavior-neutral; also encrypts the wire via `SecureChannel`),
(b) add the `Map<deviceId, TransferSession>` registry + `FileSender` + `AmbientShareService` wiring
(desktop also gets the IPC), (c) the Settings share-mode matrix, (d) the native `CaptureWatcher`
per platform, (e) receive toast + Undo, (f) then the proximity + off-network rungs of the transport
ladder.
