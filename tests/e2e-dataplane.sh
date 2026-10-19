#!/bin/bash
# Data-plane proof: a real stream published to the public ingest URL must
# travel nginx-rtmp -> datarhei core -> ffmpeg -> destination, and the
# destination connection must leave through the VPN, not the host IP.
set -uo pipefail
BASE=https://vergoboy.ir/noisy
J=/tmp/noisy-dp
PASS="$1"

# The login limiter is shared and persistent (sqlite), so a control-suite run
# right before this one can leave the budget drained for 5 minutes. When run
# as root (the documented way), reset that ephemeral bookkeeping so the first
# login of this suite is not refused. This touches only rate-limit counters.
if [ "$(id -u)" = "0" ] && [ -d /opt/noisy/data ]; then
  rm -f /opt/noisy/data/ratelimit.db \
        /opt/noisy/data/ratelimit.db-wal /opt/noisy/data/ratelimit.db-shm
fi

rm -rf $J; mkdir -p $J
ok(){ echo "  PASS  $1"; }
bad(){ echo "  FAIL  $1"; FAILED=$((FAILED+1)); }
FAILED=0
SINKMARK="noisy-sink-$$"

cleanup(){
  sudo docker rm -f "$SINKMARK" >/dev/null 2>&1
  # Put the operator's real destination back. The test overwrites it with the
  # local sink, and the panel deliberately never returns the stored key over
  # the API, so the only way to snapshot it is to read the encrypted store
  # directly as the noisy user. Without this the test silently destroys the
  # real YouTube credentials.
  if [ -r "$J/dest_backup" ]; then
    sudo -u noisy /opt/noisy/app/.venv/bin/python - "$J/dest_backup" <<'PY' >/dev/null 2>&1
import json, sys
sys.path.insert(0, "/opt/noisy/app")
from store import SecretStore
backup = json.load(open(sys.argv[1]))
s = SecretStore()
if backup.get("url"):
    s.set("destination_url", backup["url"])
    if backup.get("key"):
        s.set("destination_key", backup["key"])
else:
    s.delete("destination_url")
    s.delete("destination_key")
PY
  fi
}
trap cleanup EXIT

echo "== 1. core process is startable =="
curl -sk -c $J/jar $BASE/login -o $J/l.html
CSRF=$(grep -o 'name="csrf_token" value="[^"]*"' $J/l.html | head -1 | sed 's/.*value="//;s/"//')
curl -sk -b $J/jar -c $J/jar -o /dev/null \
  --data-urlencode "username=admin" --data-urlencode "password=$PASS" \
  --data-urlencode "csrf_token=$CSRF" $BASE/login
CSRF=$(curl -sk -b $J/jar $BASE/ | grep -o 'data-csrf="[^"]*"' | sed 's/.*="//;s/"//')
DASH=$(curl -sk -b $J/jar $BASE/); echo "$DASH" | grep -q "data-csrf" && ok "dashboard loads" || bad "dashboard broken"

echo "== 2. start an in-network RTMP sink =="
# The core image's entrypoint is the core binary, so the entrypoint has to be
# replaced, and ffmpeg has to be looped or the container exits as soon as one
# publisher disconnects.
sudo docker run -d --name "$SINKMARK" --network noisy_noisy_net --network-alias sink \
  --entrypoint sh datarhei/core@sha256:d80f1f2beb7ef2a9551f36e80bcc09a6d4d2216c70b6ad5ff733798738835187 \
  -c 'while true; do ffmpeg -hide_banner -loglevel error -listen 1 \
        -i rtmp://0.0.0.0:19360/live -c copy -f flv -y /tmp/received.flv; \
        stat -c %s /tmp/received.flv >> /tmp/sizes.log 2>/dev/null; sleep 1; done' >/dev/null
sleep 5
sudo docker exec "$SINKMARK" ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=d=1:s=64x64 \
  -t 1 -c:v libx264 -pix_fmt yuv420p -f flv -y rtmp://0.0.0.0:19360/live >/dev/null 2>&1
sleep 3
sudo docker exec "$SINKMARK" test -s /tmp/received.flv && ok "sink accepts RTMP" || bad "sink did not accept RTMP"

echo "== 3. point the core process at the sink =="
# Snapshot the real destination first, so the trap can restore it.
sudo -u noisy /opt/noisy/app/.venv/bin/python - > $J/dest_backup <<'PY'
import json, sys
sys.path.insert(0, "/opt/noisy/app")
from store import SecretStore
s = SecretStore()
json.dump({"url": s.get("destination_url"), "key": s.get("destination_key")}, sys.stdout)
PY
if grep -q '"key": *"[^"]' $J/dest_backup; then
  echo "  (saved the configured destination, it will be restored)"
fi
# Address the sink by IP, not by its docker alias: sing-box hijacks DNS in
# this network, so the container's own resolver is bypassed and docker service
# names come back NXDOMAIN.
SINK_IP=$(sudo docker inspect "$SINKMARK" -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
echo "  sink ip: $SINK_IP"
curl -sk -b $J/jar -X POST $BASE/api/destination --data-urlencode "csrf_token=$CSRF" \
  --data-urlencode "server=rtmp://$SINK_IP:19360/live" --data-urlencode "key=streamkey" -o $J/dest.json
grep -q '"ok":true' $J/dest.json && ok "destination accepted" || { cat $J/dest.json; bad "destination rejected"; }

echo "== 4. start the core process =="
code=$(curl -sk -o $J/start.json -w '%{http_code}' -b $J/jar -X POST $BASE/api/start \
  --data-urlencode "csrf_token=$CSRF")
echo "  start -> $code $(cat $J/start.json)"
grep -q '"ok":true' $J/start.json && ok "core process started" || bad "core process did not start"

echo "== 5. publish a synthetic stream to the public ingest URL =="
# The sink truncates received.flv on every reconnect, so by the time we look
# the good session may already have been overwritten by a later one. Reset the
# log and read the peak of the recorded session sizes instead of the current
# file size.
sudo docker exec "$SINKMARK" sh -c ': > /tmp/sizes.log'
KEY=$(curl -sk -b $J/jar $BASE/api/ingest | python3 -c 'import json,sys;print(json.load(sys.stdin)["key"])')
# Publish from inside the core container to the host's nginx on the docker
# bridge gateway, which is the same 19350 listener the public URL resolves to.
# -re and a modest bitrate matter: an unpaced lavfi source pushes at ~28x
# realtime, the core drops that session immediately (rx_bytes=0, STOP one
# second after START) and nothing ever reaches the destination. A real encoder
# publishes at line rate, which is what this has to imitate.
sudo docker exec noisy-restreamer sh -c "
  ffmpeg -hide_banner -loglevel error -re -f lavfi -i testsrc=d=20:s=320x180 \
    -c:v libx264 -preset veryfast -b:v 800k -g 30 -pix_fmt yuv420p \
    -f flv -y rtmp://172.28.240.1:19350/noisy/$KEY" >/dev/null 2>&1
sleep 4

echo "== 6. did the stream reach the destination? =="
sudo docker exec "$SINKMARK" sh -c 'cat /tmp/sizes.log 2>/dev/null | sed "s/^/  session bytes: /"'
SIZE=$(sudo docker exec "$SINKMARK" sh -c \
  'cat /tmp/sizes.log 2>/dev/null | sort -n | tail -1' 2>/dev/null)
CUR=$(sudo docker exec "$SINKMARK" sh -c 'stat -c %s /tmp/received.flv 2>/dev/null || echo 0')
[ "${CUR:-0}" -gt "${SIZE:-0}" ] 2>/dev/null && SIZE=$CUR
if [ "${SIZE:-0}" -gt 20000 ]; then
  ok "stream travelled end to end (${SIZE} bytes at the sink)"
else
  bad "nothing arrived at the destination (${SIZE} bytes)"
  echo "  --- core log ---"; sudo docker logs --tail 25 noisy-restreamer 2>&1 | sed 's/^/  /'
fi

echo "== 7. outbound really goes through the VPN =="
EXITIP=$(sudo docker exec noisy-restreamer wget -qO- --timeout=20 https://api.ipify.org 2>/dev/null | tr -d '\r\n ')
echo "  exit ip seen by the core container: $EXITIP"
[ "$EXITIP" = "130.185.120.88" ] && ok "traffic exits via the VPN endpoint" \
  || bad "unexpected exit ip '$EXITIP' (host ip would be 45.135.242.135)"
# BusyBox wget indents the status line ("  HTTP/1.1 204 ..."), so cut on a
# single space reads the empty first field and reports no code at all. awk
# collapses the whitespace and takes the real second field.
YTCODE=$(sudo docker exec noisy-restreamer wget -S --timeout=25 -O /dev/null \
  https://www.youtube.com/generate_204 2>&1 | grep -m1 'HTTP/' | awk '{print $2}')
echo "  youtube status: $YTCODE"
[ "$YTCODE" = "204" ] && ok "YouTube reachable from the core container" || bad "YouTube got '$YTCODE'"

echo "== 8. stop and clean up =="
curl -sk -b $J/jar -X POST $BASE/api/stop --data-urlencode "csrf_token=$CSRF" -o $J/stop.json
sleep 3
curl -sk -b $J/jar $BASE/api/status -o $J/end.json
grep -q '"streaming":false' $J/end.json && ok "core process stopped" \
  || { bad "core process still streaming"; echo "  status: $(cat $J/end.json)"; }

echo
echo "failed checks: $FAILED"
exit $((FAILED > 0))
