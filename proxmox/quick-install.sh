#!/usr/bin/env bash
# Run on a Proxmox VE node. No community-script library is downloaded or sourced.
set -Eeuo pipefail

fail() { echo "Error: $*" >&2; exit 1; }
usage() {
    cat <<'EOF'
Spotweb3: create a NEW unprivileged Debian 13 LXC and install the application.
Run as root in the Proxmox node Shell. Requires DHCP and internet access.
Usage: bash quick-install.sh [--yes] [--id 120] [--storage local-lvm]
  [--template-storage local] [--bridge vmbr0] [--hostname spotweb]
  [--cores 2] [--memory 2048] [--disk 16] [--ssh-key /root/.ssh/id_ed25519.pub]
  [--dry-run]
--yes: use the displayed defaults without questions, including storage selection.
--dry-run: inspect settings without downloads or container creation.
No root password is needed: administer the guest with pct enter <ID> on the host.
EOF
}

check_bridge() {
    ip link show dev "$1" >/dev/null 2>&1 || fail "Bridge $1 does not exist. Pass --bridge YOUR_BRIDGE."
    [[ -d "/sys/class/net/$1/bridge" ]] || fail "$1 is not a Linux bridge. Pass --bridge YOUR_BRIDGE."
}

check_host() {
    [[ $EUID == 0 && -d /etc/pve ]] || fail 'Run as root in the Proxmox node Shell, not inside a container.'
}

# Prefer conventional Proxmox storage names, otherwise the first active entry.
choose_storage() {
    local content=$1 preferred=$2 selected=$3 line choice candidate
    local -a entries=()
    while read -r line; do [[ -z "$line" ]] || entries+=("$line"); done < <(
        pvesm status --content "$content" | awk 'NR > 1 && $3 == "active" {print $1}'
    )
    ((${#entries[@]})) || fail "No active storage supports $content. Configure it in Datacenter > Storage."
    if [[ -n "$selected" ]]; then
        for candidate in "${entries[@]}"; do
            if [[ "$candidate" == "$selected" ]]; then printf '%s\n' "$selected"; return; fi
        done
        fail "Storage $selected is unavailable or does not support $content."
    fi
    selected=${entries[0]}
    for candidate in "${entries[@]}"; do
        if [[ " $preferred " == *" $candidate "* ]]; then selected=$candidate; break; fi
    done
    if ((${#entries[@]} > 1 && !YES)); then
        printf '\nAvailable %s storage:\n' "$content" >&2
        printf '  %s\n' "${entries[@]}" >&2
        read -r -p "Storage [$selected]: " choice </dev/tty
        selected=${choice:-$selected}
        for candidate in "${entries[@]}"; do
            if [[ "$candidate" == "$selected" ]]; then printf '%s\n' "$selected"; return; fi
        done
        fail "Select one of the listed storage names."
    fi
    printf '%s\n' "$selected"
}

main() {
    local CTID='' STORAGE='' TEMPLATE_STORAGE='' BRIDGE=vmbr0 HOSTNAME=spotweb
    local MEMORY=2048 CORES=2 DISK=16 SSH_KEY='' YES=0 DRY_RUN=0
    local value answer arch sha template workdir addresses address
    while (($#)); do
        case "$1" in
            --yes) YES=1; shift ;; --dry-run) DRY_RUN=1; shift ;;
            --id) CTID=${2:?}; shift 2 ;; --storage) STORAGE=${2:?}; shift 2 ;;
            --template-storage) TEMPLATE_STORAGE=${2:?}; shift 2 ;;
            --bridge) BRIDGE=${2:?}; shift 2 ;; --hostname) HOSTNAME=${2:?}; shift 2 ;;
            --cores) CORES=${2:?}; shift 2 ;; --memory) MEMORY=${2:?}; shift 2 ;;
            --disk) DISK=${2:?}; shift 2 ;; --ssh-key) SSH_KEY=${2:?}; shift 2 ;;
            -h|--help) usage; return ;; *) usage; fail "Unknown option: $1" ;;
        esac
    done
    check_host
    for value in pct pvesh pvesm pveam curl python3 tar ip; do
        command -v "$value" >/dev/null || fail "Required host command is missing: $value"
    done
    arch=$(dpkg --print-architecture)
    [[ "$arch" == amd64 ]] || fail 'This installer currently supports amd64 Proxmox nodes.'
    for value in "$MEMORY" "$CORES" "$DISK"; do
        [[ "$value" =~ ^[1-9][0-9]*$ ]] || fail 'CPU, RAM and disk values must be positive integers.'
    done
    [[ "$BRIDGE" =~ ^[a-zA-Z0-9_.-]+$ && "$HOSTNAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail 'Invalid bridge or hostname.'
    check_bridge "$BRIDGE"
    [[ -z "$SSH_KEY" || -f "$SSH_KEY" ]] || fail 'SSH public key file not found.'
    if ((!YES && !DRY_RUN)); then
        [[ -r /dev/tty ]] || fail 'No terminal available. Use --yes for unattended installation.'
    fi
    # /cluster/nextid checks both VM and container IDs across the cluster.
    [[ -n "$CTID" ]] || CTID=$(pvesh get /cluster/nextid)
    [[ "$CTID" =~ ^[1-9][0-9]{2,}$ ]] || fail 'Invalid guest ID (minimum 100).'
    pvesh get /cluster/nextid --vmid "$CTID" >/dev/null || fail "Guest ID $CTID is already in use."
    # A preview never asks interactive questions.
    (( !DRY_RUN )) || YES=1
    STORAGE=$(choose_storage rootdir 'local-lvm local-zfs' "$STORAGE")
    TEMPLATE_STORAGE=$(choose_storage vztmpl local "$TEMPLATE_STORAGE")
    printf '\nSpotweb3 installation\n  CT: %s (%s), Debian 13, unprivileged\n' "$CTID" "$HOSTNAME"
    printf '  CPU: %s cores; RAM: %s MiB; disk: %s GiB on %s\n' "$CORES" "$MEMORY" "$DISK" "$STORAGE"
    printf '  Template storage: %s; network: %s / DHCP; start on boot: yes\n' "$TEMPLATE_STORAGE" "$BRIDGE"
    if ((DRY_RUN)); then echo 'Preview only. Nothing downloaded or created.'; return; fi
    if ((!YES)); then
        read -r -p 'Create and install? [Y/n]: ' answer </dev/tty
        case "$answer" in ''|y|Y|yes|YES) ;; *) echo 'Cancelled. Nothing created.'; return ;; esac
    fi
    workdir=$(mktemp -d -t spotweb3-install.XXXXXXXX)
    # Only remove this script's own mktemp directory; retain any created guest.
    trap 'rm -rf -- "${workdir:?}"' EXIT
    trap 'echo "Installation failed. Any created CT is retained. Inspect it with: pct enter $CTID" >&2' ERR
    echo '[1/4] Downloading Spotweb3 (one immutable source revision)...'
    sha=$(curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 \
        https://api.github.com/repos/Cyclone47/spotweb3/commits/main | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])')
    [[ "$sha" =~ ^[a-f0-9]{40}$ ]] || fail 'GitHub did not return a valid source revision.'
    echo "Source revision: $sha"
    curl --fail --show-error --location --retry 3 --connect-timeout 15 --max-time 600 \
        "https://codeload.github.com/Cyclone47/spotweb3/tar.gz/$sha" -o "$workdir/source.tar.gz"
    mkdir "$workdir/source"
    tar -xzf "$workdir/source.tar.gz" --strip-components=1 -C "$workdir/source"
    [[ -f "$workdir/source/proxmox/install-lxc.sh" && -f "$workdir/source/proxmox/create-lxc.sh" ]] || fail 'Incomplete source archive.'
    tar -czf "$workdir/install.tar.gz" -C "$workdir/source" .
    echo '[2/4] Finding and downloading the current Debian 13 template...'
    pveam update
    template=$(pveam available --section system | awk '$2 ~ /^debian-13-standard_.*_amd64\.tar\.(zst|xz|gz)$/ {print $2}' | sort -V | tail -n 1)
    [[ -n "$template" ]] || fail 'No Debian 13 amd64 standard template is available. Check pveam update output.'
    pveam download "$TEMPLATE_STORAGE" "$template"
    echo '[3/4] Creating container and installing Apache, PHP and Spotweb3...'
    local -a args=(--id "$CTID" --template "$TEMPLATE_STORAGE:vztmpl/$template" \
        --storage "$STORAGE" --archive "$workdir/install.tar.gz" --bridge "$BRIDGE" \
        --hostname "$HOSTNAME" --memory "$MEMORY" --cores "$CORES" --disk "$DISK")
    [[ -z "$SSH_KEY" ]] || args+=(--ssh-key "$SSH_KEY")
    bash "$workdir/source/proxmox/create-lxc.sh" "${args[@]}"
    echo '[4/4] Ready. Open Spotweb3 and complete the setup wizard:'
    addresses=$(pct exec "$CTID" -- hostname -I)
    for address in $addresses; do
        if [[ "$address" == *:* ]]; then
            printf '  https://[%s]/?page=setup\n' "$address"
        else
            printf '  https://%s/?page=setup\n' "$address"
        fi
    done
    printf '\nSet your Spotweb admin password and Usenet details in the wizard.\n'
    printf 'Guest administration: pct enter %s (no Linux root password required).\n' "$CTID"
    printf 'Automatic retrieval: Admin Center > Overview > Automatic spot retrieval.\n'
    printf 'Browser downloads from another computer require trusted HTTPS; see:\n'
    printf 'https://github.com/Cyclone47/spotweb3/blob/main/docs/proxmox-nl.md\n'
    rm -rf -- "${workdir:?}"
    trap - EXIT ERR
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
