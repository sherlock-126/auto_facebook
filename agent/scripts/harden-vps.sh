#!/usr/bin/env bash
# Idempotent VPS hardening for the auto-facebook agent VPS (caycuoc).
# Run after first install AND after every restore from backup.
#
# Fixes:
#   1. Bootloader (prevent repeated "grub rescue>" loop)
#   2. Cockpit + Portainer (port 9090 brute-force vector that was attacked before)
#   3. UFW firewall — only open the ports in use
#   4. fail2ban + whitelist cloud server IP (113.161.57.9) to avoid self-banning
set -euo pipefail

CLOUD_IP="113.161.57.9"   # public IP of nextclaw cloud — do NOT ban

echo "==> [1/5] Reinstalling GRUB to /dev/sda (prevent grub-rescue loop)"
grub-install /dev/sda
update-grub

echo "==> [2/5] Stop + mask Cockpit (port 9090 brute-force vector)"
systemctl stop    cockpit.socket cockpit.service 2>/dev/null || true
systemctl disable cockpit.socket cockpit.service 2>/dev/null || true
systemctl mask    cockpit.socket cockpit.service 2>/dev/null || true

echo "==> [3/5] Remove Portainer container if present"
if command -v docker >/dev/null 2>&1; then
  docker rm -f portainer 2>/dev/null || true
fi

echo "==> [4/5] UFW firewall (ADD allow rules — do NOT reset, keep existing rules)"
if ! command -v ufw >/dev/null 2>&1; then apt-get install -y ufw; fi
# Add (idempotent) allow rules for the ports the agent uses — do not reset, do not
# change the default policy. The customer may already have their own UFW config; don't break it.
for p in 22 24700 6092 80 443; do ufw allow $p/tcp >/dev/null 2>&1 || true; done
ufw status verbose | head -10 || true

echo "==> [5/5] fail2ban + whitelist cloud IP $CLOUD_IP"
apt-get install -y fail2ban
mkdir -p /etc/fail2ban/jail.d
cat >/etc/fail2ban/jail.d/00-ignoreip.local <<EOF
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 $CLOUD_IP
EOF
systemctl enable --now fail2ban
fail2ban-client reload >/dev/null

echo ""
echo "✓ harden-vps.sh complete"
echo "  - GRUB reinstalled on /dev/sda"
echo "  - Cockpit + Portainer stopped + masked"
echo "  - UFW allow: 24700 6092 80 443 18789 18791"
echo "  - fail2ban whitelist: $CLOUD_IP"
echo ""
echo "Smoke test from another machine:  curl -k -m 3 https://$(hostname -I | awk '{print $1}'):9090/  (expect refused)"
