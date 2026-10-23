#!/usr/bin/env bash
# Run on the Proxmox node. Requires a source bundle from this checkout.
set -Eeuo pipefail
CTID=''; TEMPLATE=''; STORAGE=''; ARCHIVE=''; BRIDGE=vmbr0
HOSTNAME=spotweb; MEMORY=2048; CORES=2; DISK=16; SSH_KEY=''; DRY_RUN=0
usage() {
    cat <<'EOF'
Usage: bash create-lxc.sh --id 120 --template local:vztmpl/debian-13-standard_....tar.zst \
  --storage local-lvm --archive /root/spotweb-install.tar.gz [options]
Options: --bridge vmbr0 --hostname spotweb --memory 2048 --cores 2 --disk 16
         --ssh-key /root/.ssh/id_ed25519.pub --dry-run
Creates a NEW unprivileged Debian LXC using DHCP and installs Spotweb natively.
No existing container is modified or removed. Networking needs DHCP and internet.
EOF
}
while (($#)); do
    case "$1" in
        --id) CTID="${2:?}"; shift 2 ;; --template) TEMPLATE="${2:?}"; shift 2 ;;
        --storage) STORAGE="${2:?}"; shift 2 ;; --archive) ARCHIVE="${2:?}"; shift 2 ;;
        --bridge) BRIDGE="${2:?}"; shift 2 ;; --hostname) HOSTNAME="${2:?}"; shift 2 ;;
        --memory) MEMORY="${2:?}"; shift 2 ;; --cores) CORES="${2:?}"; shift 2 ;;
        --disk) DISK="${2:?}"; shift 2 ;; --ssh-key) SSH_KEY="${2:?}"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;; -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
    esac
done
[[ "$CTID" =~ ^[1-9][0-9]{2,}$ && -n "$TEMPLATE" && -n "$STORAGE" && -f "$ARCHIVE" ]] || { usage; exit 1; }
[[ "$TEMPLATE" == *debian-12-* || "$TEMPLATE" == *debian-13-* ]] || { echo 'Use a Debian 12 or 13 template.' >&2; exit 1; }
for number in "$MEMORY" "$CORES" "$DISK"; do
    [[ "$number" =~ ^[1-9][0-9]*$ ]] || { echo 'Resource values must be positive integers.' >&2; exit 1; }
done
[[ "$STORAGE" =~ ^[a-zA-Z0-9_-]+$ && "$BRIDGE" =~ ^[a-zA-Z0-9_.-]+$ && "$HOSTNAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || {
    echo 'Invalid storage, bridge or hostname.' >&2; exit 1;
}
[[ -z "$SSH_KEY" || -f "$SSH_KEY" ]] || { echo 'SSH public key file not found.' >&2; exit 1; }
args=(pct create "$CTID" "$TEMPLATE" --hostname "$HOSTNAME" --unprivileged 1 \
    --cores "$CORES" --memory "$MEMORY" --swap 512 --rootfs "$STORAGE:$DISK" \
    --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp,type=veth" --onboot 1)
[[ -z "$SSH_KEY" ]] || args+=(--ssh-public-keys "$SSH_KEY")
if ((DRY_RUN)); then
    printf 'Create: '; printf '%q ' "${args[@]}"; printf '\n'
    printf 'Push source bundle: %s\nInstall inside CT %s with proxmox/install-lxc.sh\n' "$ARCHIVE" "$CTID"
    exit 0
fi
[[ $EUID == 0 && -d /etc/pve ]] || { echo 'Run as root on a Proxmox VE node.' >&2; exit 1; }
command -v pct >/dev/null
if pct status "$CTID" >/dev/null 2>&1 || [[ -f "/etc/pve/qemu-server/$CTID.conf" ]]; then
    echo "Guest ID $CTID already exists. Choose an unused ID." >&2; exit 1
fi
# A trusted source bundle is required: never download or execute an unrelated upstream branch.
tar -tzf "$ARCHIVE" | grep '^\./proxmox/install-lxc.sh$' >/dev/null || {
    echo 'The source bundle does not contain the LXC installer.' >&2; exit 1;
}
trap 'echo "Installation stopped. CT $CTID is retained for inspection; nothing was deleted." >&2' ERR
"${args[@]}"
pct start "$CTID"
ready=0
for _ in $(seq 1 60); do
    if pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1; then ready=1; break; fi
    sleep 2
done
((ready)) || { echo 'Container DNS/internet is not ready.' >&2; exit 1; }
pct push "$CTID" "$ARCHIVE" /root/spotweb-install.tar.gz
pct exec "$CTID" -- mkdir -p /root/spotweb-source
pct exec "$CTID" -- tar -xzf /root/spotweb-install.tar.gz -C /root/spotweb-source
pct exec "$CTID" -- bash /root/spotweb-source/proxmox/install-lxc.sh
printf '\nInstalled in CT %s. Container addresses:\n' "$CTID"
pct exec "$CTID" -- hostname -I
