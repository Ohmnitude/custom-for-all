#!/bin/sh
set -eu

CHAIN="CFA-FORM-EGRESS"
SUBNET="172.30.250.0/28"

start() {
  iptables -N "$CHAIN" 2>/dev/null || true
  iptables -F "$CHAIN"
  iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -A "$CHAIN" -d "$SUBNET" -j ACCEPT
  iptables -A "$CHAIN" -d 5.161.61.100/32 -j REJECT
  iptables -A "$CHAIN" -d 10.0.0.0/8 -j REJECT
  iptables -A "$CHAIN" -d 172.16.0.0/12 -j REJECT
  iptables -A "$CHAIN" -d 192.168.0.0/16 -j REJECT
  iptables -A "$CHAIN" -d 169.254.0.0/16 -j REJECT
  iptables -A "$CHAIN" -j RETURN
  iptables -C DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null \
    || iptables -I DOCKER-USER 1 -s "$SUBNET" -j "$CHAIN"
}

stop() {
  iptables -D DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null || true
  iptables -F "$CHAIN" 2>/dev/null || true
  iptables -X "$CHAIN" 2>/dev/null || true
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  *) echo "Usage: $0 {start|stop|restart}" >&2; exit 2 ;;
esac
