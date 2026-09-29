#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT
mkdir -p "$test_root/bin"
printf '#!/bin/sh\nexit 0\n' >"$test_root/crowd"
chmod +x "$test_root/crowd"

cat >"$test_root/bin/curl" <<'MOCK'
#!/usr/bin/env bash
output=''
url=''
while (( $# )); do
  case "$1" in
    -o|-H|--retry|--connect-timeout|--max-time) [[ "$1" == -o ]] && output=$2; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  */crowd-linux-amd64|*/crowd-linux-arm64) cp "$CROW_TEST_BINARY" "$output" ;;
  */crowd-linux-amd64.sha256|*/crowd-linux-arm64.sha256)
    asset=${url##*/}
    asset=${asset%.sha256}
    if [[ "${CROW_TEST_BAD_SHA:-}" == 1 ]]; then
      printf '%064d  %s\n' 0 "$asset" >"$output"
    else
      printf '%s  %s\n' "$(sha256sum "$CROW_TEST_BINARY" | cut -d ' ' -f 1)" "$asset" >"$output"
    fi ;;
  */api/sessions) printf '%s' "${CROW_TEST_SESSIONS:-[]}" ;;
  */api/health) printf '{"status":"ok"}' ;;
  *) exit 22 ;;
esac
MOCK
cat >"$test_root/bin/uname" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == -m && -n "${CROW_TEST_ARCH:-}" ]]; then
  printf '%s\n' "$CROW_TEST_ARCH"
else
  /usr/bin/uname "$@"
fi
MOCK
cat >"$test_root/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CROW_TEST_LOG"
if [[ "$1" == --user && "$2" == is-active ]]; then
  [[ "${CROW_TEST_ACTIVE:-}" == 1 ]]
  exit
fi
MOCK
cat >"$test_root/bin/loginctl" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1" == show-user ]]; then printf 'yes\n'; fi
MOCK
chmod +x "$test_root/bin/"*

run_case() {
  local name=$1 active=$2 sessions=$3 bad_sha=$4 arch=${5:-amd64}
  local home="$test_root/$name"
  mkdir -p "$home/.local/share/crow-harness"
  printf '%032d' 0 >"$home/.local/share/crow-harness/token"
  : >"$home/systemctl.log"
  if ! env HOME="$home" PATH="$test_root/bin:$PATH" \
    CROW_TEST_BINARY="$test_root/crowd" CROW_TEST_LOG="$home/systemctl.log" \
    CROW_TEST_ACTIVE="$active" CROW_TEST_SESSIONS="$sessions" CROW_TEST_BAD_SHA="$bad_sha" CROW_TEST_ARCH="$arch" \
    bash "$script_dir/install.sh" >"$home/output.log" 2>&1; then
    cat "$home/output.log" >&2
    return 1
  fi
}

run_case fresh 0 '[]' 0
cmp "$test_root/crowd" "$test_root/fresh/.local/bin/crowd"
grep -q -- '--user start crowd.service' "$test_root/fresh/systemctl.log"

run_case arm64 0 '[]' 0 aarch64
cmp "$test_root/crowd" "$test_root/arm64/.local/bin/crowd"

run_case busy 1 '[{"state":"running"}]' 0
! grep -q -- '--user restart crowd.service' "$test_root/busy/systemctl.log"
grep -q 'no se reinició' "$test_root/busy/output.log"

run_case idle 1 '[{"state":"exited"}]' 0
grep -q -- '--user restart crowd.service' "$test_root/idle/systemctl.log"

run_case unknown 1 'not-json' 0
! grep -q -- '--user restart crowd.service' "$test_root/unknown/systemctl.log"

if run_case checksum 0 '[]' 1; then
  echo 'El instalador aceptó un checksum inválido.' >&2
  exit 1
fi
[[ ! -e "$test_root/checksum/.local/bin/crowd" ]]
echo 'Pruebas del instalador: OK'
