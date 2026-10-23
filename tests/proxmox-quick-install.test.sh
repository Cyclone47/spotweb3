#!/usr/bin/env bash
# No real Proxmox operations: exercise decisions up to the bundle installer.
set -Eeuo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [[ ${1:-} == --scenario ]]; then
    SCENARIO=$2
    # shellcheck source=proxmox/quick-install.sh
    source "$ROOT/proxmox/quick-install.sh"
    check_host() { :; }
    check_bridge() { [[ "$1" == vmbr0 ]]; }
    dpkg() { echo amd64; }
    # The helper checks command availability; check_bridge itself is mocked.
    # ShellCheck 0.9 calls this SC2317; newer versions call it SC2329.
    # shellcheck disable=SC2317,SC2329
    ip() { :; }
    pvesh() {
        printf 'pvesh %s\n' "$*" >>"$TEST_LOG"
        if [[ "$*" == *--vmid* ]]; then
            [[ "$SCENARIO" != collision ]] || return 1
        else
            echo 143
        fi
    }
    pvesm() {
        echo 'Name Type Status Total Used Available %'
        if [[ "$*" == *rootdir* ]]; then
            echo 'archive dir inactive 100000000 0 100000000 0%'
            echo 'custom zfspool active 100000000 0 100000000 0%'
            echo 'local-lvm lvmthin active 100000000 0 100000000 0%'
        else
            echo 'local dir active 100000000 0 100000000 0%'
        fi
    }
    curl() {
        printf 'curl %s\n' "$*" >>"$TEST_LOG"
        if [[ "$*" == *api.github.com* ]]; then
            if [[ "$SCENARIO" == badsha ]]; then echo '{"sha":"invalid"}'; else
                echo '{"sha":"0123456789012345678901234567890123456789"}'
            fi
        else
            while (($#)); do
                if [[ "$1" == -o ]]; then cp "$TEST_ARCHIVE" "$2"; return; fi
                shift
            done
            return 1
        fi
    }
    pveam() {
        printf 'pveam %s\n' "$*" >>"$TEST_LOG"
        if [[ "$1" == available && "$SCENARIO" != no-template ]]; then
            echo 'system debian-12-standard_12.12-1_amd64.tar.zst'
            echo 'system debian-13-standard_13.1-1_amd64.tar.zst'
            echo 'system debian-13-standard_13.2-1_amd64.tar.zst'
            echo 'system debian-13-standard_13.2-1_arm64.tar.zst'
        fi
    }
    pct() {
        printf 'pct %s\n' "$*" >>"$TEST_LOG"
        case "$1" in
            status) return 1 ;;
            exec)
                if [[ "$*" == *hostname* ]]; then echo '192.0.2.143 fd00::143'; fi
                if [[ "$SCENARIO" == install-fails && "$*" == *'-- bash '* ]]; then return 42; fi
                ;;
        esac
        return 0
    }
    bash() {
        [[ "$1" == */source/proxmox/create-lxc.sh ]] || return 1
        [[ -f "${1%/*}/install-lxc.sh" ]] || return 1
        printf 'bundle-installer %s\n' "${*:2}" >>"$TEST_LOG"
        [[ "$SCENARIO" != install-fails ]] || return 42
    }
    shift 2
    main "$@"
    exit
fi

work=$(mktemp -d)
trap 'rm -rf -- "${work:?}"' EXIT
mkdir -p "$work/bundle/spotweb3-test/proxmox"
cp "$ROOT/proxmox/create-lxc.sh" "$work/bundle/spotweb3-test/proxmox/"
echo '# native installer placeholder, pct exec is mocked' >"$work/bundle/spotweb3-test/proxmox/install-lxc.sh"
tar -czf "$work/source.tar.gz" -C "$work/bundle" spotweb3-test
export TEST_ARCHIVE="$work/source.tar.gz" TEST_LOG="$work/commands.log"

run_case() {
    local scenario=$1 expected=$2
    shift 2
    : >"$TEST_LOG"
    if bash "$0" --scenario "$scenario" "$@" >"$work/output" 2>&1; then
        [[ "$expected" == success ]] || { cat "$work/output"; echo "Unexpected success: $scenario"; exit 1; }
    else
        [[ "$expected" == failure ]] || { cat "$work/output"; echo "Unexpected failure: $scenario"; exit 1; }
    fi
}
assert_contains() { grep -F -- "$2" "$1" >/dev/null || { cat "$1"; echo "Missing: $2"; exit 1; }; }
assert_absent() { if grep -F -- "$2" "$1"; then echo "Unexpected: $2"; exit 1; fi; }

run_case defaults success --yes
assert_contains "$TEST_LOG" 'pvesh get /cluster/nextid --vmid 143'
assert_contains "$TEST_LOG" 'pveam download local debian-13-standard_13.2-1_amd64.tar.zst'
assert_contains "$TEST_LOG" 'bundle-installer --id 143 --template local:vztmpl/debian-13-standard_13.2-1_amd64.tar.zst --storage local-lvm'
assert_contains "$TEST_LOG" '--bridge vmbr0 --hostname spotweb --memory 2048 --cores 2 --disk 16'
assert_contains "$TEST_LOG" 'https://codeload.github.com/Cyclone47/spotweb3/tar.gz/0123456789012345678901234567890123456789'
assert_contains "$work/output" 'https://192.0.2.143/?page=setup'

run_case custom success --yes --id 150 --storage custom --memory 4096 --disk 32
assert_contains "$TEST_LOG" 'bundle-installer --id 150'
assert_contains "$TEST_LOG" '--storage custom'
assert_contains "$TEST_LOG" '--memory 4096 --cores 2 --disk 32'

run_case preview success --dry-run
assert_contains "$work/output" 'Preview only.'
assert_absent "$TEST_LOG" 'curl '
assert_absent "$TEST_LOG" 'pveam '
assert_absent "$TEST_LOG" 'bundle-installer'

for scenario in collision badsha no-template; do
    run_case "$scenario" failure --yes
    assert_absent "$TEST_LOG" 'bundle-installer'
done
run_case inactive failure --yes --storage archive
assert_contains "$work/output" 'does not support rootdir'
assert_absent "$TEST_LOG" 'curl '
run_case bad-id failure --yes --id 99
assert_absent "$TEST_LOG" 'bundle-installer'
run_case bad-bridge failure --yes --bridge missing
assert_absent "$TEST_LOG" 'bundle-installer'
run_case install-fails failure --yes
assert_contains "$work/output" 'retained'
assert_absent "$TEST_LOG" 'pct destroy'

echo 'Proxmox helper: 10 scenarios passed (all host commands mocked).'
