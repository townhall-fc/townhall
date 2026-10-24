#!/usr/bin/env bash
# townhall · step 0 · provision a server for a Snapchain read node.
#
# Runs on YOUR computer. Creates a Hetzner Cloud server plus a 2 TB volume,
# installs your SSH key, and prints the two commands for steps 1 and 2.
#
#   HCLOUD_TOKEN=xxxx bash provision.sh
#
# Options (env vars):
#   HCLOUD_TOKEN        required. Hetzner Cloud → your project → Security → API tokens (Read & Write)
#   SERVER_TYPE         default: cheapest type with >= 4 vCPU and >= 16 GB RAM
#   LOCATION            default: fsn1 (Falkenstein). Others: nbg1, hel1, ash, hil
#   VOLUME_GB           default: 2000 (Snapchain needs ~2 TB free); falls back to 1000, then 500.
#                       0 = no volume, use the server's local disk (pick a SERVER_TYPE with >= 500 GB disk)
#   SSH_PUBKEY_FILE     default: ~/.ssh/id_ed25519.pub (created if missing)
#   NAME                default: townhall
#
# Already have a server (any provider, Ubuntu 22.04/24.04, 4 vCPU, 16 GB RAM, 1 TB disk,
# ports 22/80/443 TCP and 3382 UDP open)? Skip this step and go to step 1.
set -euo pipefail

API="${HCLOUD_API:-https://api.hetzner.cloud/v1}"
NAME="${NAME:-townhall}"
LOCATION="${LOCATION:-fsn1}"
VOLUME_GB="${VOLUME_GB:-2000}"
SSH_PUBKEY_FILE="${SSH_PUBKEY_FILE:-$HOME/.ssh/id_ed25519.pub}"
REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/townhall-fc/townhall/main}"

say() { printf '\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
# Missing a tool? Say exactly how to install it on this system.
need() {
  command -v "$1" >/dev/null 2>&1 && return
  local apt="$1" dnf="$1"
  case "$1" in ssh|ssh-keygen) apt=openssh-client; dnf=openssh-clients ;; esac
  if command -v brew >/dev/null 2>&1; then die "Please install '$1' first:  brew install $1"
  elif command -v apt-get >/dev/null 2>&1; then die "Please install '$1' first:  sudo apt update && sudo apt install -y $apt"
  elif command -v dnf >/dev/null 2>&1; then die "Please install '$1' first:  sudo dnf install -y $dnf"
  else die "Please install '$1' first."; fi
}

need curl; need jq; need ssh; need ssh-keygen
[ -n "${HCLOUD_TOKEN:-}" ] || die "Set HCLOUD_TOKEN (Hetzner Cloud → project → Security → API tokens, Read & Write)."

hc() { # method path [json]
  local out code
  out=$(curl -sS -X "$1" "$API$2" -H "Authorization: Bearer $HCLOUD_TOKEN" -H 'Content-Type: application/json' ${3:+--data "$3"} -w '\n%{http_code}')
  code=$(tail -n1 <<<"$out"); out=$(sed '$d' <<<"$out")
  if [ "$code" -ge 400 ]; then die "Hetzner API $1 $2 → $code: $(jq -r '.error.message // .' <<<"$out")"; fi
  printf '%s' "$out"
}

# 1. SSH key
if [ ! -f "$SSH_PUBKEY_FILE" ]; then
  say "No SSH key at $SSH_PUBKEY_FILE, creating one"
  ssh-keygen -t ed25519 -N '' -f "${SSH_PUBKEY_FILE%.pub}" >/dev/null
fi
PUB=$(cat "$SSH_PUBKEY_FILE")
FP=$(ssh-keygen -E md5 -lf "$SSH_PUBKEY_FILE" | awk '{print $2}' | sed 's/^MD5://')
KEY_ID=$(hc GET "/ssh_keys?fingerprint=$FP" | jq -r '.ssh_keys[0].id // empty')
if [ -z "$KEY_ID" ]; then
  say "Uploading your SSH key to Hetzner"
  KEY_ID=$(hc POST /ssh_keys "$(jq -n --arg n "$NAME-$(date +%s)" --arg k "$PUB" '{name:$n, public_key:$k}')" | jq -r .ssh_key.id)
fi

# 2. Server type: cheapest x86 type available here with >= 4 cores and >= 16 GB RAM
if [ -z "${SERVER_TYPE:-}" ]; then
  SERVER_TYPE=$(hc GET "/server_types?per_page=50" | jq -r --arg loc "$LOCATION" '
    [.server_types[]
      | select((.deprecation == null) and (.deprecated != true) and .architecture == "x86" and .cores >= 4 and .memory >= 16)
      | . as $t | ($t.prices[] | select(.location == $loc)) as $p
      | {name: $t.name, price: ($p.price_monthly.gross | tonumber)}]
    | sort_by(.price) | .[0].name // empty')
  [ -n "$SERVER_TYPE" ] || die "No server type with 4 vCPU / 16 GB found in $LOCATION. Try LOCATION=nbg1 or hel1."
fi

# 3. Firewall: SSH, HTTP(S) for the client, UDP 3382 for Snapchain gossip
FW_ID=$(hc GET "/firewalls?name=$NAME" | jq -r '.firewalls[0].id // empty')
if [ -z "$FW_ID" ]; then
  FW_ID=$(hc POST /firewalls "$(jq -n --arg n "$NAME" '{name:$n, rules:[
    {direction:"in",protocol:"tcp",port:"22",source_ips:["0.0.0.0/0","::/0"],description:"ssh"},
    {direction:"in",protocol:"tcp",port:"80",source_ips:["0.0.0.0/0","::/0"],description:"http (certificate)"},
    {direction:"in",protocol:"tcp",port:"443",source_ips:["0.0.0.0/0","::/0"],description:"https (client)"},
    {direction:"in",protocol:"udp",port:"3382",source_ips:["0.0.0.0/0","::/0"],description:"snapchain gossip"}]}')" | jq -r .firewall.id)
fi

echo "  This is billed by Hetzner while it exists. Delete it in the Hetzner console when you are done."

# Re-running is safe: an existing server with this name is reused.
CREATED=""
SERVER=$(hc GET "/servers?name=$NAME" | jq -c '{server: .servers[0]} | select(.server != null)')
if [ -n "$SERVER" ]; then
  LOCATION=$(jq -r '.server.datacenter.location.name // .server.location.name // "unknown"' <<<"$SERVER")
  say "Using your existing server '$NAME' ($LOCATION)"
else
  # A location can be temporarily out of a server type ("error during placement").
  # Try the chosen one first, then the other EU locations.
  for LOC in $LOCATION $(printf '%s\n' fsn1 nbg1 hel1 | grep -vx "$LOCATION"); do
    say "Creating server '$NAME' ($SERVER_TYPE, $LOC, Ubuntu 24.04)"
    BODY=$(jq -n --arg n "$NAME" --arg t "$SERVER_TYPE" --arg l "$LOC" --argjson k "$KEY_ID" --argjson f "$FW_ID" \
      '{name:$n, server_type:$t, location:$l, image:"ubuntu-24.04", ssh_keys:[$k], firewalls:[{firewall:$f}], start_after_create:true}')
    OUT=$(curl -sS -X POST "$API/servers" -H "Authorization: Bearer $HCLOUD_TOKEN" -H 'Content-Type: application/json' --data "$BODY" -w '\n%{http_code}')
    CODE=$(tail -n1 <<<"$OUT"); OUT=$(sed '$d' <<<"$OUT")
    if [ "$CODE" -lt 400 ]; then SERVER="$OUT"; LOCATION="$LOC"; CREATED=1; break; fi
    echo "  $LOC: $(jq -r '.error.message // .' <<<"$OUT")"
  done
  [ -n "$SERVER" ] || die "No capacity for $SERVER_TYPE right now. Try again in a while, or set SERVER_TYPE (e.g. SERVER_TYPE=cpx42)."
fi
SERVER_ID=$(jq -r .server.id <<<"$SERVER")
IP=$(jq -r .server.public_net.ipv4.ip <<<"$SERVER")

# Volume. New Hetzner accounts have a limit on total volume size; if 2 TB is over it,
# fall back to smaller sizes and say so. Ask Hetzner to raise the limit to run long-term.
LOCAL_GB=$(jq -r '.server.server_type.disk // 0' <<<"$SERVER")
big_disk_types() {
  hc GET "/server_types?per_page=50" | jq -r --arg loc "$LOCATION" '
    [.server_types[]
      | select((.deprecation == null) and (.deprecated != true) and .architecture == "x86" and .cores >= 4 and .memory >= 16 and .disk >= 500)
      | . as $t | ($t.prices[] | select(.location == $loc)) as $p
      | {name: $t.name, disk: $t.disk, price: ($p.price_monthly.gross | tonumber)}]
    | sort_by(.price) | .[] | "    \(.name)  \(.disk) GB local disk  ~\(.price | floor) €/mo"'
}
if [ "$VOLUME_GB" = 0 ]; then
  say "No volume (VOLUME_GB=0): the node uses the server's ${LOCAL_GB} GB local disk"
  [ "$LOCAL_GB" -ge 500 ] || echo "  ! ${LOCAL_GB} GB is too small for Snapchain. Pick a SERVER_TYPE with >= 500 GB local disk."
elif hc GET "/volumes?name=$NAME-data" | jq -e '.volumes[0]' >/dev/null; then
  say "Using your existing volume '$NAME-data'"
else
  MADE=""
  for SIZE in $VOLUME_GB 1000 500; do
    [ "$SIZE" -le "$VOLUME_GB" ] || continue
    OUT=$(curl -sS -X POST "$API/volumes" -H "Authorization: Bearer $HCLOUD_TOKEN" -H 'Content-Type: application/json' \
      --data "$(jq -n --arg n "$NAME-data" --argjson s "$SIZE" --argjson id "$SERVER_ID" '{name:$n, size:$s, server:$id, automount:true, format:"ext4"}')" -w '\n%{http_code}')
    CODE=$(tail -n1 <<<"$OUT"); OUT=$(sed '$d' <<<"$OUT")
    if [ "$CODE" -lt 400 ]; then MADE=$SIZE; break; fi
    echo "  volume ${SIZE} GB: $(jq -r '.error.message // .' <<<"$OUT")"
  done
  if [ -z "$MADE" ] && [ "$LOCAL_GB" -ge 500 ]; then
    say "No volume (your account's volume limit is reached): the node uses the ${LOCAL_GB} GB local disk"
  elif [ -z "$MADE" ]; then
    echo
    echo "  Your Hetzner account's volume limit is reached, and this server's local disk (${LOCAL_GB} GB) is too small."
    echo "  Either ask Hetzner to raise the limit (console → Limits), or use a server with a big local disk:"
    big_disk_types || true
    if [ -n "$CREATED" ]; then
      hc DELETE "/servers/$SERVER_ID" >/dev/null && echo "  (The server this run just made is deleted again, so nothing keeps billing.)"
    else
      echo "  First delete the existing server '$NAME': run destroy.sh with the same token (see the guide)."
    fi
    echo "  Then run this again with SERVER_TYPE=<one above> VOLUME_GB=0 before bash."
    die "Could not create a volume."
  else
    say "Attached a ${MADE} GB volume"
  fi
  if [ -n "$MADE" ] && [ "$MADE" -lt 2000 ]; then
    echo "  ! Snapchain recommends 2 TB free. ${MADE} GB should be enough to start syncing;"
    echo "    to run long-term, ask Hetzner to raise your volume limit and resize the volume."
  fi
fi

say "Waiting for the server to boot"
for _ in $(seq 1 60); do
  ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o BatchMode=yes "root@$IP" true 2>/dev/null && break
  sleep 5
done

cat <<EOF

✓ Server ready: $IP

Next, two commands (each takes a few minutes; the node then syncs on its own for a few hours):

  ssh root@$IP 'curl -fsSL $REPO_RAW/install/node.sh | bash'
  ssh root@$IP 'curl -fsSL $REPO_RAW/install/client.sh | bash'

EOF
