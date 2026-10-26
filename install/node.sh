#!/usr/bin/env bash
# townhall · step 1 · run a Snapchain read node.
#
# Runs ON THE SERVER (as root or a sudo user). Uses the official Farcaster
# docker-compose file from the latest Snapchain release, unchanged, with its
# data on the biggest disk. The node downloads a snapshot of the network, then keeps
# itself in sync. No API keys, no accounts.
#
#   curl -fsSL https://raw.githubusercontent.com/townhall-fc/townhall/main/install/node.sh | bash
#
# Re-running it is safe and updates the node to the latest Snapchain release.
#
# Options: DATA_DIR (default: mount point with the most free space)
set -euo pipefail

say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | $SUDO sh >/dev/null
fi
command -v jq >/dev/null 2>&1 || { $SUDO apt-get update -qq && $SUDO apt-get install -y -qq jq >/dev/null; }

# 2. Where the data goes: the mount with the most free space (the volume)
DATA_DIR="${DATA_DIR:-$(df -B1G --output=avail,target -x tmpfs -x devtmpfs -x overlay | tail -n +2 | sort -rn | head -1 | awk '{print $2}')}"
FREE_GB=$(df -B1G --output=avail "$DATA_DIR" | tail -1 | tr -d ' ')
say "Data directory: $DATA_DIR ($FREE_GB GB free)"
[ "$FREE_GB" -ge 900 ] || echo "  ! The sync peaks at about 800 GB while it unpacks the snapshot (about 560 GB once synced). You have $FREE_GB GB free here; it may run out of space."

NODE_DIR="$DATA_DIR/snapchain"
$SUDO mkdir -p "$NODE_DIR"
cd "$NODE_DIR"

# 3. Official compose file + validator set from the latest Snapchain release
TAG=$(curl -fsSL https://api.github.com/repos/farcasterxyz/snapchain/releases/latest | jq -r '.tag_name // empty' || true)
TAG="${TAG:-main}"
RAW="https://raw.githubusercontent.com/farcasterxyz/snapchain/$TAG"
say "Fetching Snapchain $TAG config"
$SUDO curl -fsSL "$RAW/docker-compose.mainnet.yml" -o docker-compose.yml
$SUDO curl -fsSL "$RAW/validators.toml" -o validators.toml
grep -q 'read_node = true' docker-compose.yml || die "Unexpected compose file: it is not configured as a read node."

# 4. Start the node and the small metrics sink it reports to. The official config
#    points the node at statsd:8125 and the node exits if that name doesn't resolve.
#    (Grafana stays off; the firewall keeps the statsd ports private.)
say "Starting the node (pulling the latest Snapchain image first)"
# The image tag is :latest, and `up` alone keeps whatever image is already on disk.
# Pulling first means re-running this step updates the node, e.g. after a network upgrade.
$SUDO docker compose pull -q snapchain statsd
$SUDO docker compose up -d snapchain statsd

# 5. Wait until the HTTP API answers
for _ in $(seq 1 60); do
  curl -fsS localhost:3381/v1/info >/dev/null 2>&1 && break
  sleep 5
done

# 6. First sync on a disk smaller than 2 TB: the node keeps every downloaded
#    snapshot file until the very end. The guard frees what it has finished with.
if [ ! -d "$NODE_DIR/.rocks/shard-1" ] || [ -d "$NODE_DIR/.rocks.snapshot" ]; then
  $SUDO curl -fsSL "https://raw.githubusercontent.com/townhall-fc/townhall/main/install/snapshot-guard.sh" -o /usr/local/bin/townhall-snapshot-guard
  $SUDO chmod +x /usr/local/bin/townhall-snapshot-guard
  $SUDO systemctl stop townhall-snapshot-guard >/dev/null 2>&1 || true
  $SUDO systemd-run --unit=townhall-snapshot-guard /usr/local/bin/townhall-snapshot-guard "$NODE_DIR" >/dev/null
  say "Snapshot guard running (frees snapshot files as soon as the node is done with them)"
fi

# A small status helper you can run any time: `townhall-status`
$SUDO tee /usr/local/bin/townhall-status >/dev/null <<'EOS'
#!/usr/bin/env bash
if ! curl -fsS localhost:3381/v1/info >/dev/null 2>&1; then
  echo "Node API not up yet. Still downloading/unpacking the snapshot? Logs: docker compose -f NODE_DIR/docker-compose.yml logs --tail 20 snapchain"
  exit 1
fi
I=$(curl -fsS localhost:3381/v1/info)
echo "$I" | jq -r '"node version: \(.version // "?")", (.shardInfos[] | "shard \(.shardId): height \(.maxHeight)  blocks behind: \(.blockDelay)")'
echo "In sync when every 'blocks behind' is in the single digits."
# A shard far below the others never got its snapshot (the download broke off) and is
# syncing from block 0, which takes weeks.
LOW=$(echo "$I" | jq -r '[.shardInfos[].maxHeight] as $h | ($h | max) as $m | if $m > 1000000 then (.shardInfos[] | select(.maxHeight < $m / 100) | .shardId) else empty end' | tr '\n' ' ')
if [ -n "$LOW" ]; then
  echo
  echo "! Shard(s) $LOW did not get the snapshot and are syncing from block 0 (weeks)."
  echo "  Usually the download broke off. Start it over (about a day): townhall-resync"
fi
EOS
$SUDO sed -i "s#NODE_DIR#$NODE_DIR#" /usr/local/bin/townhall-status
$SUDO chmod +x /usr/local/bin/townhall-status

# Start the first sync over: wipes the node's database and downloads the snapshot again.
$SUDO tee /usr/local/bin/townhall-resync >/dev/null <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
D=NODE_DIR
read -r -p "This deletes the node's data in $D and downloads the network again (about a day). Type yes: " OK </dev/tty
[ "$OK" = yes ] || { echo "Nothing changed."; exit 0; }
systemctl stop townhall-snapshot-guard >/dev/null 2>&1 || true
docker compose -f "$D/docker-compose.yml" stop snapchain
rm -rf "$D/.rocks" "$D/.rocks.snapshot"
curl -fsSL https://raw.githubusercontent.com/townhall-fc/townhall/main/install/node.sh | DATA_DIR="${D%/snapchain}" bash
EOS
$SUDO sed -i "s#NODE_DIR#$NODE_DIR#" /usr/local/bin/townhall-resync
$SUDO chmod +x /usr/local/bin/townhall-resync

cat <<EOF

✓ Snapchain read node is running in $NODE_DIR

It is now downloading a snapshot of the network and will then catch up with the network.
That takes a few hours. You can run step 2 right away; the client shows sync progress.

Check any time:   townhall-status
Node logs:        docker compose -f $NODE_DIR/docker-compose.yml logs -f snapchain

EOF
