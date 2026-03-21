#!/bin/sh
# shellcheck shell=sh
# Resolve Mac IPv4 for iPad/iPhone dev. Avoid http://192.0.0.2 on device: iPadOS often uses
# interface lo0 for that destination (NW logs: "interface: lo0") — connection never reaches the Mac.
#
# Usage: . this file, then pgstudio_resolve_mac_lan_ipv4
# Exit: 0 prints one IPv4; 1 if none (and USB fallback disallowed).
#
# PGSTUDIO_IOS_DEV_HOST — explicit IP (honored unless 192.0.0.2 without PGSTUDIO_IOS_ALLOW_USB_HOST=1)
# PGSTUDIO_IOS_ALLOW_USB_HOST=1 — allow 192.0.0.2 when nothing else works (rare / older OS)

pgstudio_resolve_mac_lan_ipv4() {
  _allow_usb="${PGSTUDIO_IOS_ALLOW_USB_HOST:-0}"

  if [ -n "${PGSTUDIO_IOS_DEV_HOST:-}" ]; then
    if [ "$PGSTUDIO_IOS_DEV_HOST" != "192.0.0.2" ] || [ "$_allow_usb" = "1" ]; then
      printf '%s' "$PGSTUDIO_IOS_DEV_HOST"
      return 0
    fi
  fi

  if [ -n "${TAURI_DEV_HOST:-}" ]; then
    _h="$TAURI_DEV_HOST"
    case "$_h" in
      http://*) _h="${_h#http://}" ;;
      https://*) _h="${_h#https://}" ;;
    esac
    _h="${_h%%/*}"
    _h="${_h%%:*}"
    if [ -n "$_h" ] && { [ "$_h" != "192.0.0.2" ] || [ "$_allow_usb" = "1" ]; }; then
      printf '%s' "$_h"
      return 0
    fi
  fi

  route_if=$(route -n get default 2>/dev/null | awk '/interface:/{print $2;exit}')
  ip=""
  if [ -n "$route_if" ]; then
    case "$route_if" in
      utun*) ;;
      *)
        ip=$(ipconfig getifaddr "$route_if" 2>/dev/null || true)
        ;;
    esac
  fi
  if [ -n "$ip" ] && [ "$ip" != "192.0.0.2" ]; then
    printf '%s' "$ip"
    return 0
  fi
  for iface in en0 en1 en2 en3 en4 en5 en6 en7 en8 en9 bridge100 bridge101 bridge0; do
    ip=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
    if [ -n "$ip" ] && [ "$ip" != "192.0.0.2" ]; then
      printf '%s' "$ip"
      return 0
    fi
  done

  # Default route may be VPN (utun*), so the above misses Wi‑Fi. Scan all ifconfig IPv4s.
  _scan=$(
    ifconfig 2>/dev/null | awk '
      BEGIN { minp = 999; best = "" }
      /^[^[:space:]:]+:/ {
        iface = $1
        sub(/:$/, "", iface)
      }
      /^[[:space:]]+inet[[:space:]]+/ {
        ip = $2
        if (iface == "lo0") next
        if (iface ~ /^utun/) next
        if (ip == "127.0.0.1" || ip == "192.0.0.2") next
        if (ip ~ /^169\.254\./) next
        p = 100
        if (iface ~ /^en[0-9]+$/) p = 10
        else if (iface ~ /^bridge/) p = 25
        else if (iface ~ /^awdl/) p = 90
        else p = 45
        if (ip ~ /^192\.168\./) p += 0
        else if (ip ~ /^10\./) p += 1
        else if (ip ~ /^172\.(1[6-9]|2[0-9]|3[0-1])\./) p += 2
        else p += 40
        if (p < minp) { minp = p; best = ip }
      }
      END { if (best != "") print best }
    '
  )
  if [ -n "$_scan" ] && [ "$_scan" != "192.0.0.2" ]; then
    printf '%s' "$_scan"
    return 0
  fi

  if [ "$_allow_usb" = "1" ]; then
    printf '%s' "192.0.0.2"
    return 0
  fi

  if ifconfig 2>/dev/null | grep -q '[[:space:]]inet 192\.0\.0\.2[[:space:]]'; then
    echo "pgstudio: This Mac only has IPv4 192.0.0.2 on an interface (USB / iOS tether). That address does not work from most iPads (they hit lo0, not your Mac)." >&2
    echo "pgstudio: Fix — connect this Mac to Wi‑Fi (or Ethernet) so it gets 192.168.x.x or 10.x.x.x; put the iPad on the same network; run pnpm ios:dev:open again." >&2
    echo "pgstudio: Or force an IP you know the iPad can reach: PGSTUDIO_IOS_DEV_HOST=192.168.x.x pnpm ios:dev:open" >&2
    echo "pgstudio: Last resort (often still broken on iPad): PGSTUDIO_IOS_ALLOW_USB_HOST=1 pnpm ios:dev:open" >&2
  else
    echo "pgstudio: No usable private IPv4 found (check Wi‑Fi/Ethernet, or set PGSTUDIO_IOS_DEV_HOST)." >&2
  fi
  return 1
}
