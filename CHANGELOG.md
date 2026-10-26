# Changelog

## Unreleased

- Fix: if the snapshot download broke off (a chunk failing 6 times in a row), Snapchain restarted, skipped the snapshot and synced the missing shards from block 0, which takes weeks. The snapshot guard now detects the restart and starts the download over (up to 5 times). `townhall-status` flags a shard that missed its snapshot, and `townhall-resync` starts the first sync over.
- Guide: button names match the client (Connect), key activation "about ten seconds", connect to post once the node is in sync, ports listed for your own server, step 0 states the 2 TB / 1 TB volume. Step 1 warns below 900 GB free instead of 1500.
- A 59-second vertical video on the guide, in English and Chinese (`site/video/`), linked from the README.
- Fix: casts over 320 bytes failed with "text > 320 bytes". They now go out as long casts (up to 1024 bytes), as the protocol requires.
- Images and video: attach up to two to a cast. They upload to your own server (`/api/upload`, stored in `/opt/townhall/media`, served at `/media/`), and the cast carries the URL as an embed. Uploads need a signature from an app key your node lists as active; the server checks the file's real type from its bytes. `UPLOAD_FIDS` and `MEDIA_QUOTA_GB` (default 20) on step 2. Videos in casts play in the client, and the Farcaster app's own streams play where the browser supports HLS.
- Channels: post to a channel, read a channel from your node (`#/ch/<name>`, a `/channel` tag on each channel cast, or search `/dev`). Members-only channels show a warning before you post.
- `test/e2e-media.mjs` covers uploads, video, channels and the upload checks.
- Step 1 pulls the latest Snapchain image before starting, so re-running it updates the node. Nodes left on 0.14.3 stopped following blocks after the 23 October mainnet upgrade.
- The client's "in sync" check includes shard 0, where key messages are validated; a node behind on shard 0 now shows as catching up.
- A third person ran it on their own server: @drakhonen.eth, listed in the guide and the README.
- Guide and README list the people who ran it on their own servers, linking to their posts on Farcaster.
- Upstream: sent [docs#473](https://github.com/farcasterxyz/docs/pull/473), moving the docs.farcaster.xyz Hello World to gasless account keys. Linked from the guide and the README.
- Upstream: sent [snapchain#1080](https://github.com/farcasterxyz/snapchain/pull/1080), documenting the unified signer endpoints. Linked from the guide and the README.
- Upstream: sent [hub-monorepo#2748](https://github.com/farcasterxyz/hub-monorepo/pull/2748), moving the official hello-world example to gasless app keys. Linked from the guide and the README.
- Step 0 copes with Hetzner's volume limit on new accounts: if no volume can be made, it uses a big local disk when the server has one, or lists the server types that do. `VOLUME_GB=0` skips the volume.
- Navigation people know from Farcaster apps: bottom tabs on phones (Home, Search, Live, Replies, you), a left rail on wide screens. Settings moved to your profile.
- Connect with a recovery phrase is one button with plain steps (finding your account, giving this client its key, done) instead of Check / Add app key and raw addresses.
- An empty feed suggests a few accounts to follow, one tap each.
- Feed: a link already in the text is not repeated under it; the guest Sign in button stays on one line.
- Guide: try it first. Type a username and open that feed read-only on the demo node (`#/read/<username>`); a live card shows the demo node's block, messages and accounts.
- The gargoyle shows your node's state: awake and blinking when in sync, squinting and looking around while it catches up, asleep while it downloads the network or can't be reached.
- Fix: leaving Live (or any page) while it was still loading could paint "Cannot set properties of null" over the next page.
- Follower and following counts: distinct accounts, shown within a second and growing as the node pages through large accounts. Fixes a blank or inflated count when the node kept returning the last page.
- Faster first load: the client starts with a 60 KB script (was 3.6 MB). Signing, posting and the Base lookup load on first use; the "voted" badge appears once Base answers instead of holding the cast back. The web server also offers zstd.
- Self-hosted sign-in page: your own keys, with a pointer to delegated sign-in (one more command); the guide explains it.
- The node status line has its own row, so long statuses no longer push the header around.
- Link previews for shared casts on every install: `client.sh` starts the preview service; `signin.sh` adds sign-in to it.
- Share: "Link copied" confirmation, and a fallback where the clipboard API is blocked.
- Windows: PowerShell versions of step 0 and cleanup (`provision.ps1`, `destroy.ps1`); the guide shows Mac/Linux and Windows commands.
- Install scripts name the exact command to install a missing tool (brew, apt or dnf).
- Live view: the network's event log as your node receives it.
- Inspect a cast's protocol message.
- Search by username or FID; follower and following counts; Farcaster-style relative times.
- Share a cast: a link on your own client that opens for anyone (share sheet on phones).
- Quote casts, and quoted casts shown inside the cast that quotes them.
- Hosted sign-in: a choice between the Farcaster app and your own keys; `signin.sh IMPORT=1` uses an existing spare account as the app account.
- Shared cast links `/c/<fid>/<hash>` with link previews (Open Graph), served by the optional service; without it they still open the client.
- Fix: deleted casts (CAST_REMOVE) no longer break the feed.

## 0.1.0 · 2026-10-20

First public version.

- Three commands: `provision.sh` (Hetzner server and volume), `node.sh` (Snapchain read node), `client.sh` (client built from source, HTTPS with Caddy).
- `destroy.sh` deletes the server and volume.
- Snapshot guard: first sync fits on a 1 TB volume (measured peak about 800 GB).
- Client: feed, profiles, threads, replies and mentions read from your node; casts, replies, likes, recasts, follows, deletes; filter casts by the app that signed them; voters only; replies from mutuals; light and dark theme.
- App keys added as gasless `KEY_ADD` from a recovery phrase, revocable from Settings with a self-signed `KEY_REMOVE`.
- Optional hosted mode (`signin.sh`): signed-out feed and Sign in with Farcaster, no recovery phrase.
- Tutorial with measured sync time, disk and cost, and a section on what broke while building it.
