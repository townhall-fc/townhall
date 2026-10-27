<p align="center"><img src="site/img/og.png" alt="townhall" width="720"></p>

# townhall

Your own Farcaster client and Snapchain read node, in three commands. No API keys from anyone.

- **Tutorial:** https://townhallfc.xyz ([中文](https://townhallfc.xyz/zh/))
- **Demo video:** https://townhallfc.xyz/#video (59 seconds: the three commands, the sync, the client on your own node)
- **License:** MIT

## Quickstart

```bash
# 0. On your computer: create a Hetzner Cloud server and volume
curl -fsSL https://raw.githubusercontent.com/townhall-fc/townhall/main/install/provision.sh | HCLOUD_TOKEN=your_token bash

# 1. On the server: run a Snapchain read node (official compose file)
ssh root@YOUR_IP 'curl -fsSL https://raw.githubusercontent.com/townhall-fc/townhall/main/install/node.sh | bash'

# 2. On the server: build the client from source and serve it over HTTPS
ssh root@YOUR_IP 'curl -fsSL https://raw.githubusercontent.com/townhall-fc/townhall/main/install/client.sh | bash'
```

On Windows, open PowerShell (not cmd). Step 0 and cleanup have PowerShell versions; steps 1 and 2 work as they are:

```powershell
$env:HCLOUD_TOKEN="your_token"; irm https://raw.githubusercontent.com/townhall-fc/townhall/main/install/provision.ps1 | iex
```

Already have a server (Ubuntu 22.04 or 24.04, 4 vCPU, 16 GB RAM, 1 TB disk or more)? Skip step 0.

Hetzner says the volume limit is reached (common on new accounts)? Step 0 lists the server types with a big local disk and removes the small server it just made; run step 0 again with `SERVER_TYPE=<one of them> VOLUME_GB=0` before `bash`. Cloud servers are billed by the hour, so a few days on a bigger type is a small part of its monthly price.

To update the node (for example after a network upgrade), re-run step 1: it pulls the latest Snapchain release and restarts the node.

Done testing? Delete the server and volume so billing stops:

```bash
curl -fsSL https://raw.githubusercontent.com/townhall-fc/townhall/main/install/destroy.sh | HCLOUD_TOKEN=your_token bash
```

Windows: `$env:HCLOUD_TOKEN="your_token"; irm https://raw.githubusercontent.com/townhall-fc/townhall/main/install/destroy.ps1 | iex`

Video: [the whole thing in 59 seconds](https://townhallfc.xyz/#video) (vertical, with sound; [中文版](https://townhallfc.xyz/zh/#video)).

## What to expect

Measured on the demo node (Hetzner `cx43`, 1 TB volume, Snapchain 0.14.3, October 2026):

| | |
|---|---|
| Hands-on time | about 10 minutes |
| Snapshot download and unpack | about 11 hours (about 445 GB compressed) |
| Catching up to the chain | about 10 hours |
| Disk | peak about 800 GB, about 560 GB once synced |
| App key | one gasless `KEY_ADD`, active in about 10 seconds |

## What the client does

- Reads everything from your node: the feed of people you follow, profiles, threads, replies and mentions.
- Posts with its own app key: casts, replies, quotes, likes, recasts, follows, deletes.
- **Images and video on your own server:** attach up to two per cast. They are stored on your server and served from your domain under `/media/`; the cast carries the URL. Only someone with a key your node lists as active can upload (`UPLOAD_FIDS` limits it to you, `MEDIA_QUOTA_GB` caps the space).
- **Channels:** post to a channel (the cast's `parentUrl` is the channel URL) and read any channel from your node. Channel names are looked up once in the Farcaster channel list, no key.
- Share: every cast has a link on your own client that opens for anyone, signed in or not (the share sheet on phones).
- Adds that key from your recovery phrase as a gasless `KEY_ADD` (custody-signed EIP-712, no transaction, no ETH). The phrase is used only in the browser and cleared right after. The key can revoke itself from Settings.
- Shows which app signed each cast and lets you include or exclude casts by app.
- **Voters only:** filters the feed to people who hold the Farcaster VOTE NFT on Base.
- **Live:** the whole network as your node receives it, from the node's event log: casts, likes, follows, profile changes, messages pruned by storage limits, with block heights per shard.
- **Inspect:** every cast can show its protocol message (hash, signer, signing app, signature).
- Search by username or FID; follower and following counts read from your node.
- **Replies from mutuals:** replies and mentions from people you follow who follow you back, with a switch for everyone.
- Writes go to your read node, which validates them and relays them to the validators.

## Let other people use it (optional)

```bash
ssh root@YOUR_IP 'curl -fsSL https://raw.githubusercontent.com/townhall-fc/townhall/main/install/signin.sh | bash'
```

Visitors see a feed with no login and choose how to sign in: approve townhall in the Farcaster app (a signed key request, no recovery phrase), or use their own keys. Either way the key is made in the visitor's browser and stays there. The server holds only the key of a separate app account that signs the requests: a new FID it registers for you, or a spare account you already have (`IMPORT=1`, run with `ssh -t`).

Shared casts get a link preview either way: `client.sh` starts the same small service without an app account, so `/c/<fid>/<hash>` shows the author and text in Farcaster, Telegram and other apps that read Open Graph tags.

## Repository

```
install/   provision.sh (0), node.sh (1), client.sh (2), destroy.sh, signin.sh, snapshot-guard.sh;
           provision.ps1 and destroy.ps1 for Windows PowerShell
client/    the web client (TypeScript, Vite, @farcaster/core, viem)
server/    optional sign-in service for hosted use
site/      the tutorial
test/      mock Snapchain node, local chainId 10 chain, end-to-end browser tests
```

Development and tests: see [CONTRIBUTING.md](CONTRIBUTING.md). Security notes and reporting: see [SECURITY.md](SECURITY.md).

## People who ran it

Ran the three commands on their own servers, cast through their own node, and vouched for it on Farcaster:

- [@runn3rr](https://farcaster.xyz/runn3rr/0x2d001899)
- [@eat](https://farcaster.xyz/eat/0x0bc3b39c)
- [@drakhonen.eth](https://farcaster.xyz/drakhonen.eth/0xea32a4f0)

## Upstream fixes

Things we found outdated in the official repos while building this, sent back as pull requests:

- [hub-monorepo#2748](https://github.com/farcasterxyz/hub-monorepo/pull/2748): the `hello-world` example adds its signer with a gasless `KEY_ADD` instead of a KeyGateway transaction.
- [snapchain#1080](https://github.com/farcasterxyz/snapchain/pull/1080): documents `/v1/signersByFid` and `/v1/signer` (and their gRPC methods), which return onchain and gasless keys together and give the nonce a `KEY_ADD` needs.
- [docs#473](https://github.com/farcasterxyz/docs/pull/473): the Hello World guide on docs.farcaster.xyz adds its account key with a gasless `KEY_ADD`, matching Snapchain's guide, and fixes a key request signed over the wrong key.

## License

MIT, see [LICENSE](LICENSE). Snapchain itself runs from its official image under its own license.
