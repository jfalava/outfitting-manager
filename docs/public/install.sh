#!/bin/sh
set -eu

repository="jfalava/outfitting-manager"
releases_api="https://api.github.com/repos/$repository/releases?per_page=30"

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v unzip >/dev/null 2>&1 || fail "unzip is required."
command -v jq >/dev/null 2>&1 || fail "jq is required."
[ -n "${HOME:-}" ] || fail 'HOME is not set.'

os=$(uname -s)
arch=$(uname -m)
case "$os:$arch" in
  Darwin:arm64|Darwin:aarch64)
    asset="outfitting-manager-darwin-arm64.zip"
    ;;
  Darwin:x86_64)
    if command -v sysctl >/dev/null 2>&1 && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = "1" ]; then
      asset="outfitting-manager-darwin-arm64.zip"
    else
      fail "macOS Intel is not supported; the CLI release is for Apple silicon."
    fi
    ;;
  Linux:x86_64|Linux:amd64)
    asset="outfitting-manager-linux-x64.zip"
    ;;
  Linux:aarch64|Linux:arm64)
    asset="outfitting-manager-linux-arm64.zip"
    ;;
  *)
    fail "Unsupported platform: $os/$arch."
    ;;
esac

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/outfitting-manager-install.XXXXXX")
staged_binary=""
cleanup() {
  [ -z "$staged_binary" ] || rm -f "$staged_binary"
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

curl --fail --location --silent --show-error --retry 3 \
  -H 'Accept: application/vnd.github+json' \
  -H 'User-Agent: outfitting-manager-installer' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "$releases_api" --output "$tmp_dir/releases.json"

jq '
  map(select(.draft == false and .prerelease == false)
      | select(.tag_name | test("^cli-v[0-9]+\\.[0-9]+\\.[0-9]+$")))
  | sort_by(.tag_name | ltrimstr("cli-v") | split(".") | map(tonumber))
  | last // empty
' "$tmp_dir/releases.json" > "$tmp_dir/release.json"
tag=$(jq -r '.tag_name' "$tmp_dir/release.json")
[ -n "$tag" ] || fail "No stable CLI release was found."

for required_asset in "$asset" "$asset.sha256"; do
  jq -e --arg name "$required_asset" \
    '[.assets[]?.name] | index($name) != null' "$tmp_dir/release.json" >/dev/null || \
    fail "Release $tag is missing $required_asset."
done

release_url="https://github.com/$repository/releases/download/$tag"
curl --fail --location --silent --show-error --retry 3 \
  -H 'User-Agent: outfitting-manager-installer' \
  "$release_url/$asset" --output "$tmp_dir/$asset"
curl --fail --location --silent --show-error --retry 3 \
  -H 'User-Agent: outfitting-manager-installer' \
  "$release_url/$asset.sha256" --output "$tmp_dir/$asset.sha256"

expected=$(awk 'NF { print tolower($1); exit }' "$tmp_dir/$asset.sha256")
printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$' || fail "Invalid SHA-256 file for $asset."

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp_dir/$asset" | awk '{ print tolower($1) }')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp_dir/$asset" | awk '{ print tolower($1) }')
else
  fail "sha256sum or shasum is required to verify the download."
fi
[ "$actual" = "$expected" ] || fail "SHA-256 verification failed for $asset."

install_dir="$HOME/.local/bin"
mkdir -p "$install_dir"
staged_binary="$install_dir/.outfitting-manager.$$"
unzip -p "$tmp_dir/$asset" outfitting-manager > "$staged_binary" || fail "The release archive does not contain outfitting-manager."
chmod 755 "$staged_binary"
mv -f "$staged_binary" "$install_dir/outfitting-manager"
staged_binary=""

if [ "$os" = "Darwin" ] && command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$install_dir/outfitting-manager" >/dev/null 2>&1 || \
    printf 'Warning: macOS could not apply an ad-hoc signature; the CLI may be blocked from opening.\n' >&2
fi

printf 'Installed outfitting-manager %s to %s/outfitting-manager\n' "${tag#cli-v}" "$install_dir"
case ":${PATH:-}:" in
  *":$install_dir:"*) ;;
  *) printf 'Add %s to your PATH to run outfitting-manager from any terminal.\n' "$install_dir" ;;
esac
