# Threat model: PocketDesk daemon and Android app

In scope are the daemon in `daemon/src/server.js` and the modules it loads, the Android app in
`app/app/src/main/java/com/yasha/pocketdesk/`, and the two paths between them: the LAN WebSocket
over TLS and the iroh QUIC link. The trust boundaries are the loopback page (served only to
127.0.0.1 with a Host check in `requestHandler`), the master token (24 random bytes, the root
credential, also carried inside the pairing QR), the per-device token that `devices.issueToken`
hands out after pairing, the pairing QR payload built by `buildPair` and parsed by `Pairing.parse`,
the iroh endpoint key that names the PC, and the iroh relay that forwards ciphertext. The attacker
model assumes no write access to the PC's config directory and no code execution on the PC or the
phone; anything past that line is listed in "Not covered".

## 1. LAN attacker

**Capability today**

A host on the same network can complete TCP and TLS against the daemon port, read the self-signed
certificate (it is public), fetch `/health` without any credential, and fetch the hub HTML, which
for a non-loopback client is the plain page without token metas (`requestHandler`, `pageForPc`).
It can open `/ws` and send hello messages with guessed tokens all day: the only pre-auth message
accepted is `hello`, anything else is closed with 4003, and a bad token is closed with 4003 in
`authenticate`. It can hold sockets open and make the daemon parse JSON until `HELLO_TIMEOUT`, and
it can flood connections. It can ARP-spoof or answer mDNS, but the pairing URL is an IP address and
the app pins the certificate, so a spoofed server fails the pin rather than receiving the token. It
cannot read wss traffic, and it cannot fetch the pairing QR: `/pair?` and the page carrying
`pd-token` require loopback plus the token. With TLS disabled the daemon binds 127.0.0.1 and
destroys every non-loopback connection (`start`, the `!useTls` connection handler), so there is no
plaintext LAN mode to attack. It can also dial the iroh endpoint if it learns the endpoint id, but
still lands in the same `authenticate` gate.

**Control**

`authenticate` compares the master token with `crypto.timingSafeEqual` and looks up a device token
through `devices.byToken`, which hashes the presented token and compares it with `timingSafeEqual`.
Wrong tokens are charged to `pairing_budget`: `pairing_budget.allowed` refuses a client IP in a
backoff window, and `pairing_budget.fail` extends that window exponentially up to five minutes
after ten free failures. Only `hello` is answered before authentication, a hello over 16 KB is
closed with 1009, and the upgrade handler refuses a cross-origin browser socket in `onUpgrade`. The
QR carries the TLS fingerprint, and `Tls.PinnedTrustManager` in `app/.../Tls.kt` refuses any other
certificate, so the token never reaches a LAN impostor. Optional controls are
`access.verifyPassword` (scrypt, checked on every hello) and `totp.allowsPairing` for master-token
pairings.

**Residual risk**

The wrong-token budget does not cover password or TOTP failures: `authenticate` returns
`passwordRequired` or `totpRequired` before `server.js` calls `pairing_budget.fail`, so an attacker
who already holds a valid token can guess the password, and one who also has the password can guess
the six-digit code, without being throttled. The budget is keyed by client IP and held in memory, so
many source addresses or a rotating IPv6 prefix split the count, and it resets on restart. It also
refuses a correct token while a lock is active, so a shared NAT can be denied service. Guessing a
192-bit token is infeasible, but password and TOTP strength are the user's choice. A LAN attacker
who obtains the token by shoulder surfing or a QR photo becomes an authenticated device with the
full handler surface. Presence, port and certificate are always discoverable, and any pre-auth
parser bug would be reachable by this attacker.

## 2. Stolen phone

**Capability today**

An unlocked phone with the app installed is a working remote control. The phone stores the device
token and the iroh key sealed by `Vault` (AES-GCM under an Android Keystore key), and `WsClient`
replaces the master token with the `deviceToken` from `welcome`, so after pairing the phone usually
holds only the device token. The holder can run terminals, read and write files, drive agents,
change power state, view the screen, and inject input unless control is paused. The connection
password is held only in memory (`WsClient.connPassword`, set by `submitConnectionPassword`), so a
cold app start may ask for it, while a live process reconnects without asking. TOTP is not asked
for a device token at all. The holder cannot call `/access`, because that endpoint requires
loopback plus the master key, so the phone cannot change the password, TOTP, the remote switch, or
the device list.

**Control**

Each phone gets its own credential from `devices.issueToken`; only its SHA-256 hash is stored as
`tokenHash`, and `devices.byToken` refuses revoked records. `devices.claimEndpoint` binds the device
to the first iroh endpoint id it authenticated from, and `server.js` closes with 4003 on a mismatch,
so the same device token cannot be replayed from a second iroh key. The PC page can call
`/access/devices/revoke`, which runs `devices.revoke`, calls `disconnectDevice`, and rotates the
master token. `access.controlAllowed` forces view-only through `mayControl` in
`handlers/remote.js`, the pause regex in `handlers/sources.js`, and the checks in
`handlers/kvm.js`, while `access.remoteOn` refuses every new socket and closes live ones with 4100.

**Residual risk**

Until the owner revokes the device from the PC, a stolen unlocked phone retains full control, and
the revoke action needs the loopback page and the current master token. Pausing control still
permits screen viewing, file reads, transcripts and other read operations in `PAUSE_ALLOWED`; only
`remoteOn` off stops everything, and that also needs the PC. The Keystore key is not bound to user
authentication (no `setUserAuthenticationRequired` in `Vault.kt`), so an unlocked phone, or malware
running as the app, can use the sealed secrets. Android backups or a rooted device can expose the
sealed blob and the Keystore-wrapped key material beyond what this model covers.

## 3. Revoked-but-cached token

**Capability today**

An attacker can hold an old credential string: a device token cached before revocation, a master
token cached after rotation, a copied app data directory, or a QR photo. Before revocation the
token works. After `devices.revoke`, the record is marked revoked, `tokenHash` and `endpointId` are
deleted, `cred` is incremented, and `devices.byToken` no longer matches, so a reconnect is refused
with 4003. A live socket is closed on its next message by `stale`, which compares `credVersion` for
device tokens and `tokenVersion` for master tokens. A cached token cannot be exchanged for a fresh
one: pairing needs the master token plus the password and TOTP if enabled, and `devices.remove`
refuses to delete a live device so the hash cannot be dropped by mistake. `devices.allow` clears
the revoked flag but does not restore `tokenHash`, so an old device token stays dead and the phone
must pair again.

**Control**

`devices.revoke` deletes the credential hash and endpoint binding and bumps the generation;
`devices.credVersion` plus `stale` enforce the change on live sockets; `rotateToken` bumps
`tokenVersion` and rebuilds the QR; `devices.byToken` rejects revoked records and expires an idle
device token after `IDLE_EXPIRE_MS` (90 days). `/access/devices/revoke` also returns a rotated
pairing token, so a cached master token from the QR stops working at the same moment.

**Residual risk**

The 90-day idle expiry covers device tokens only. The master token has no expiry and changes only
when `rotateToken` runs, which today means revoking a device or a CONSOLE pairing, so a cached
master token stays valid indefinitely if the owner never revokes anything. A revoked record that is
left in `devices.json` can be re-allowed, but without a hash it grants nothing; restoring an older
`devices.json` backup could restore a hash and a lower generation, which is a local file-integrity
attack rather than a cached-token attack. If the owner loses the master token before revoking, the
loopback page cannot be opened to revoke at all.

## 4. Malicious QR

**Capability today**

The QR is unsigned base64url JSON `{u,t,f,i,n}` built by `buildPair` and parsed by `Pairing.parse`.
Anyone who can replace, print or overlay a QR can make the app create an entry for a daemon they
control: the `wss://` URL and the TLS fingerprint both come from the payload, so the pin verifies
the attacker's own certificate and the app then sends commands, files and agent prompts to that
server. The `n` label can be chosen to look like the real PC. A plain `ws://` payload without an
iroh ticket is rejected, and a `ws://` payload with a ticket becomes iroh-only, so a malicious QR
cannot downgrade an existing pinned entry to plaintext. A payload that points at the real PC but
contains the real token adds nothing the attacker did not already have.

**Control**

`Pairing.parse` accepts only the `pocketdesk://pair#` scheme, a `ws://` or `wss://` URL, a non-empty
token and a 64-hex fingerprint, and returns nothing otherwise (`Pairing.REJECTED`). The fingerprint
is enforced by `Tls.PinnedTrustManager` for the lifetime of the entry, so a server without the
matching key is refused. The real QR is only rendered by `pageForPc` for loopback clients, and
`/pair` is loopback plus key gated, so a remote attacker cannot pull a live QR out of the daemon.
The LAN hub page carries no token metas.

**Residual risk**

Nothing cryptographically binds the QR to a known PC. Pinning trusts the fingerprint that arrived in
the same unsigned payload, so a sticker over the screen, a printed poster or a swapped screenshot
produces a working phishing entry. The app has no out-of-band confirmation and the user has no
signal beyond the label. Pairing is silent on the PC (`devices.register` runs inside `welcome` with
no approval prompt), so a device paired through a malicious QR is visible only if the owner opens
the device list. A QR photo also leaks the master token, which is the paper threat below.

## 5. iroh relay

**Capability today**

The relay forwards QUIC packets between endpoint ids. It can see which endpoint ids talk, when, and
how much, and it can drop, delay, reorder or refuse traffic. It cannot read the payload: the QUIC
session is encrypted to the PC's endpoint key, and the phone checks the PC's signature against the
key in the ticket. It cannot forge a PC or a phone. By default `startIroh` uses `applyN0`, so n0's
public relays are a third party in the path; with a custom relay list it uses those URLs; with
`relays: "off"` it disables relay mode and tries direct paths only. The ticket is an address, not a
credential, so a relay that hands out a bogus ticket still cannot authenticate.

**Control**

`startIroh` loads or generates `iroh.key` with mode 0600 and binds an endpoint with the
`pocketdesk/1` ALPN. Every relayed connection is wrapped as an `IrohSocket` and goes through the
same `authenticate`, `stale`, `access.remoteOn` and handler checks as `/ws`, and
`devices.claimEndpoint` binds the first iroh endpoint id seen for a device. `docs/RELAY.md`
documents a self-hosted relay with an endpoint allowlist, and `docs/CONNECTIVITY-NOTES.md` records
that relays see ciphertext only. `access.remoteOn` closes relayed and LAN clients alike.

**Residual risk**

The relay is trusted for availability and metadata. It can always deny service or make the link
look broken, and the default n0 relays observe endpoint ids, timing and volume even though they
cannot read content. `claimEndpoint` binds only after the first successful authentication, so
whoever presents a stolen device token first over iroh claims the binding and locks out the real
phone with 4003, a denial the owner must resolve by revoking and re-pairing. A direct hole-punched
path reveals peer IP addresses to the other endpoint by design; a relayed path hides them from the
peer but not from the relay. The relay allowlist is optional, and without it the relay forwards for
any endpoint that presents a ticket, though the token check still gates commands.

## 6. Local unprivileged user

**Capability today**

Any local account can reach 127.0.0.1 on the daemon port, the local page port and the USB port. The
loopback test in `requestHandler` and the `ws._loopback` flag are address based, not user based, so
every local account shares that boundary. Without the token such a user gets the hub HTML,
`/health` with the session count, static assets, and the `/prove` HMAC oracle, which returns
HMAC-SHA256 of a supplied nonce under the token but not the token itself. With the token the user
gets an authenticated socket as the master identity and can also call `/access` to set a password,
enable or disable TOTP, pause control, switch remote access off, revoke devices or launch the
uninstaller. The USB port only marks `_usb` to withhold loopback-only handlers; it does not change
authentication, so adb reverse grants the same token-gated access. On POSIX the config directory is
0700 and `config.json`, `devices.json` and `totp.json` are written 0600; on Windows without
`RH_CONSOLE` the `mkdir` mode is ignored and no ACL is applied, so readability depends on the
profile and volume ACLs. `devices.json` stores unsalted SHA-256 hashes, so a reader can test
candidate tokens offline.

**Control**

`/access`, `/pair`, `/prove` and `pageForPc` require loopback and an exact `timingSafeEqual` key
check (`keyOk`). `/health` returns only liveness to non-loopback callers. `devices.list` strips
`tokenHash` and `cred` before sending the device list. `access.controlAllowed` limits what an
authenticated socket may do, and `access.remoteOn` cuts every client. `loadConfig` creates the
config directory 0700 on POSIX and applies an Administrators plus SYSTEM `icacls` restriction in
CONSOLE mode on Windows. The uninstaller path is only reachable through the token-gated `/access`
route and only when an installed copy exists.

**Residual risk**

Loopback is not a per-user boundary. Any local process that can read the config directory obtains
the master token and becomes the owner, including the ability to change every security setting
through `/access`. On Windows without CONSOLE mode those ACLs are inherited rather than set by the
daemon, so the protection is partial and depends on the profile. Same-account malware is a full
compromise by definition. The hub page and `/health` reveal that the daemon is running, and
recordings, transcripts and `console-audit.log` are protected only by the same directory
permissions as the token.

## 7. Paper

**Capability today**

Printed or stored copies of three things matter: the pairing QR, the master token, and TOTP
recovery material. A QR photo contains the LAN URL, the master token, the TLS fingerprint and the
iroh ticket, so the holder can pair a device from anywhere the PC is reachable over iroh, with no
interaction on the PC unless a connection password or TOTP is set. The same master token can be
typed into any client. The master token is also in `config.json`, and the TOTP secret is in
`totp.json` or in an authenticator export; `totp.setup` returns the `otpauth://` URI to the loopback
page, so a screenshot of that page is equivalent to the second factor. A paper holder who only has
the QR still cannot open `/access`, because that route is loopback only, but can run commands, read
files, watch the screen and pair a durable device token.

**Control**

`access.hasPassword` plus `access.verifyPassword` requires a scrypt-checked password on every hello,
including the master token, and `totp.allowsPairing` requires a current RFC 6238 code for a
master-token pairing when TOTP is enabled. `rotateToken` replaces the master token and rebuilds the
QR, and the revoke route calls it. `devices.revoke` kills a paired device token. `access.remoteOn`
stops every remote client, paper holder included. The QR and token are only displayed to loopback
clients by `pageForPc` and `/pair`, not to the LAN.

**Residual risk**

The master token never expires and is not rotated on a schedule or on restart: `config.js` only
generates one when none exists, and `rotateToken` runs only on a device revoke or a CONSOLE pairing.
A QR that was photographed but never used to pair leaves no device record to revoke, so nothing
prompts rotation and the paper remains a standing credential. The password and TOTP are optional and
off by default; `config.js` warns but does not enforce them. TOTP is partial: `totp.check` accepts
the current step plus or minus one, the replay map `used` is in memory only so a code can be
replayed after a daemon restart, and TOTP failures are not charged to `pairing_budget`, so six
digits can be brute forced by a holder who also has the master token and password. TOTP recovery
material defeats the second factor exactly as a password written on the same paper would.

## Not covered

Physical phone compromise with an unlocked keychain is out of scope: the threat model assumes the
Android Keystore and the device lock screen hold, and a phone whose keychain is unlocked and
extracted yields the device token and iroh key directly. A malicious OS or app update is out of
scope: both endpoints trust their platform and their own binaries, and a signed but hostile update
can read every secret the process can read. Full disk forensics is out of scope: an attacker with
the PC's disk can read `config.json`, `devices.json`, `totp.json`, `iroh.key` and the TLS key, and
no daemon control changes that. These are stated so that the controls above are not read as
covering them.
