#!/usr/bin/env bash
# Idempotently ensure the Docker daemon is running and reachable by the current
# user. The Cloud Agent VM has no init system, so dockerd is launched directly
# and configured for the nested-container environment (fuse-overlayfs storage
# driver and legacy iptables are set up in install.sh).
set -euo pipefail

log=/tmp/dockerd.log

if ! docker info >/dev/null 2>&1; then
	if ! pgrep -x dockerd >/dev/null 2>&1; then
		# Launch dockerd as root; run the redirect inside the root shell so the
		# log file is created with root privileges (a user-level redirect to a
		# root-owned path fails before sudo runs).
		sudo sh -c "nohup dockerd >'$log' 2>&1 &"
	fi
	for _ in $(seq 1 60); do
		if sudo docker info >/dev/null 2>&1; then
			break
		fi
		sleep 1
	done
fi

if ! sudo docker info >/dev/null 2>&1; then
	echo "dockerd did not become ready" >&2
	sudo tail -n 40 "$log" 2>/dev/null >&2 || true
	exit 1
fi

# Let the unprivileged user reach the daemon without sudo in every session,
# regardless of whether docker-group membership has taken effect for this login.
sudo chmod 666 /var/run/docker.sock
