#!/usr/bin/env bash
# Idempotently ensure the Docker daemon is running and usable by the current
# user. The Cloud Agent VM has no init system, so dockerd is launched directly
# and configured for the nested-container environment (fuse-overlayfs storage
# driver and legacy iptables are set up in install.sh).
set -euo pipefail

if docker info >/dev/null 2>&1; then
	exit 0
fi

sudo mkdir -p /var/log
if [ ! -S /var/run/docker.sock ] && ! pgrep -x dockerd >/dev/null 2>&1; then
	sudo nohup dockerd >/var/log/dockerd.log 2>&1 &
fi

for _ in $(seq 1 60); do
	if sudo docker info >/dev/null 2>&1; then
		break
	fi
	sleep 1
done

if ! sudo docker info >/dev/null 2>&1; then
	echo "dockerd did not become ready" >&2
	sudo tail -n 40 /var/log/dockerd.log >&2 || true
	exit 1
fi

# Let the unprivileged user reach the daemon without sudo in this session and
# for later logins (group membership is added in install.sh).
sudo chgrp docker /var/run/docker.sock 2>/dev/null || true
sudo chmod g+rw /var/run/docker.sock 2>/dev/null || true
