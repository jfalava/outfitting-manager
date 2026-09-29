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

tag=$(awk -F '"' -v archive_name="$asset" '
  function newer(candidate, current, candidate_parts, current_parts, i) {
    split(candidate, candidate_parts, ".")
    split(current, current_parts, ".")
    for (i = 1; i <= 3; i++) {
      if ((candidate_parts[i] + 0) > (current_parts[i] + 0)) return 1
      if ((candidate_parts[i] + 0) < (current_parts[i] + 0)) return 0
    }
    return 0
  }
  function consider(version) {
    if (tag ~ /^cli-v[0-9]+\.[0-9]+\.[0-9]+$/ && draft == "false" && prerelease == "false" && has_archive && has_checksum) {
      version = substr(tag, 6)
      if (best_tag == "" || newer(version, best_version)) {
        best_tag = tag
        best_version = version
      }
    }
  }
  /^  \{$/ {
    in_release = 1
    tag = draft = prerelease = ""
    has_archive = has_checksum = 0
    next
  }
  /^  \},?$/ {
    if (in_release) consider()
    in_release = 0
    next
  }
  in_release && $2 == "tag_name" { tag = $4 }
  in_release && $2 == "draft" { draft = $3; gsub(/[[:space:],:]/, "", draft) }
  in_release && $2 == "prerelease" { prerelease = $3; gsub(/[[:space:],:]/, "", prerelease) }
  in_release && $2 == "name" && $4 == archive_name { has_archive = 1 }
  in_release && $2 == "name" && $4 == archive_name ".sha256" { has_checksum = 1 }
  END {
    if (in_release) consider()
    print best_tag
  }
' "$tmp_dir/releases.json")

[ -n "$tag" ] || fail "No stable release with $asset and its SHA-256 file was found."

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
