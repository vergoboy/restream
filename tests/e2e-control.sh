#!/bin/bash
# End-to-end verification of the Noisy control plane.
# Exercises auth, CSRF, the RTMP publish gate, and key revocation.
set -uo pipefail
BASE=https://vergoboy.ir/noisy
# Asset hrefs in the HTML are absolute from the site root (/noisy/static/...),
# so they must be fetched against the origin, not against $BASE -- concatenating
# BASE with them requests /noisy/noisy/static/... and 404s for reasons that have
# nothing to do with the assets.
ORIGIN=https://vergoboy.ir

# The login limiter is shared and persistent (sqlite), so a previous run's
# rate-limit section can leave the budget drained for 5 minutes. When run as
# root (the documented way), reset that ephemeral bookkeeping so a back-to-back
# run starts clean. This touches only rate-limit counters, never secrets.
if [ "$(id -u)" = "0" ] && [ -d /opt/noisy/data ]; then
  rm -f /opt/noisy/data/ratelimit.db \
        /opt/noisy/data/ratelimit.db-wal /opt/noisy/data/ratelimit.db-shm
fi
J=/tmp/noisy-e2e
PASS="$1"
rm -rf $J; mkdir -p $J
ok(){ echo "  PASS  $1"; }
bad(){ echo "  FAIL  $1"; FAILED=$((FAILED+1)); }
FAILED=0

echo "== 1. unauthenticated access is refused =="
code=$(curl -sk -o /dev/null -w '%{http_code}' $BASE/api/status)
[ "$code" = "401" ] && ok "api requires auth ($code)" || bad "api returned $code, want 401"
code=$(curl -sk -o /dev/null -w '%{http_code}' $BASE/)
[ "$code" = "302" ] && ok "root redirects when logged out ($code)" || bad "root returned $code, want 302"

echo "== 2. login sets a session, wrong password fails =="
curl -sk -c $J/jar $BASE/login -o $J/l0.html
CSRF0=$(grep -o 'name="csrf_token" value="[^"]*"' $J/l0.html | head -1 | sed 's/.*value="//;s/"//')
code=$(curl -sk -o /dev/null -w '%{http_code}' -b $J/jar -c $J/jar \
  --data-urlencode "username=admin" --data-urlencode "password=wrong-password-123" \
  --data-urlencode "csrf_token=$CSRF0" $BASE/login)
[ "$code" = "401" ] && ok "bad password rejected ($code)" || bad "bad password got $code, want 401"

curl -sk -b $J/jar -c $J/jar $BASE/login -o $J/login.html
CSRF=$(grep -o 'name="csrf_token" value="[^"]*"' $J/login.html | head -1 | sed 's/.*value="//;s/"//')
[ -n "$CSRF" ] && ok "login page issues a CSRF token" || bad "no CSRF token on login page"

code=$(curl -sk -o /dev/null -w '%{http_code}' -b $J/jar -c $J/jar \
  --data-urlencode "username=admin" --data-urlencode "password=$PASS" \
  --data-urlencode "csrf_token=$CSRF" $BASE/login)
[ "$code" = "302" ] && ok "login redirects on success ($code)" || bad "login got $code"

echo "== 3. the panel's own assets are served =="
# The panel has no static route of its own; nginx serves /noisy/static/
# directly. If that location is missing or points at the wrong directory the
# stylesheet 404s and the panel renders completely unstyled -- while every
# page still returns 200, so the rest of this suite passes happily.
curl -sk -b $J/jar $BASE/ -o $J/dash.html
for asset in $(grep -oE '(href|src)="/noisy/static/[^"]*"' $J/dash.html | sed 's/.*="//;s/"//' | sort -u); do
  [ -n "$asset" ] || continue
  ctype=$(curl -sk -o $J/asset -w '%{http_code} %{content_type}' "$ORIGIN$asset")
  code=${ctype%% *}; type=${ctype#* }
  case "$asset" in
    *.css) want="text/css" ;;
    *.js)  want="javascript" ;;
    *)     want="" ;;
  esac
  if [ "$code" = "200" ] && [ -n "$want" ] && [[ "$type" == *"$want"* ]] && [ -s $J/asset ]; then
    ok "$asset served ($code, $type, $(wc -c < $J/asset) bytes)"
  else
    bad "$asset broken: http=$code type=${type:-none} bytes=$(wc -c < $J/asset)"
  fi
done
# Guard against the check silently passing by finding no assets at all.
grep -q '/noisy/static/' $J/dash.html \
  && ok "dashboard references its stylesheet" \
  || bad "dashboard references no stylesheet - the asset loop proved nothing"

echo "== 4. authenticated API works =="
CSRF=$(curl -sk -b $J/jar $BASE/ | grep -o 'data-csrf="[^"]*"' | sed 's/.*="//;s/"//')
[ -n "$CSRF" ] && ok "dashboard issues a CSRF token" || bad "no CSRF token on dashboard"
curl -sk -b $J/jar $BASE/api/status -o $J/status.json
python3 - "$J/status.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert "core" in d, d
print("  core reachable:", d["core"])
PY
grep -q '"core":true' $J/status.json && ok "core reported reachable" \
  || bad "core reported unreachable"

echo "== 5. CSRF is enforced =="
code=$(curl -sk -o /dev/null -w '%{http_code}' -b $J/jar \
  -d "route=vpn-grpc" $BASE/api/egress/select)
[ "$code" = "403" ] && ok "state change without CSRF refused ($code)" || bad "missing CSRF got $code, want 403"

echo "== 6. the stream key is never echoed back =="
curl -sk -b $J/jar -X POST $BASE/api/destination \
  --data-urlencode "csrf_token=$CSRF" \
  --data-urlencode "server=rtmps://a.rtmps.youtube.com/live2" \
  --data-urlencode "key=SECRETKEY1234567890abcdef" -o $J/dest.json
grep -q "SECRETKEY1234567890abcdef" $J/dest.json && bad "stream key leaked in the save response" \
  || ok "save response does not contain the key"
grep -q '\.\.\.cdef' $J/dest.json && ok "only a 4 char suffix is shown" || bad "no key suffix shown"
curl -sk -b $J/jar $BASE/api/status -o $J/s2.json
grep -q "SECRETKEY1234567890abcdef" $J/s2.json && bad "stream key leaked in status" \
  || ok "status does not contain the key"

echo "== 7. destination validation =="
code=$(curl -sk -o /dev/null -w '%{http_code}' -b $J/jar -X POST $BASE/api/destination \
  --data-urlencode "csrf_token=$CSRF" --data-urlencode "server=javascript:alert(1)" \
  --data-urlencode "key=SECRETKEY1234567890abcdef")
[ "$code" = "400" ] && ok "non-rtmp destination rejected ($code)" || bad "bad url got $code"

echo "== 8. RTMP publish gate =="
KEY=$(curl -sk -b $J/jar $BASE/api/ingest | python3 -c 'import json,sys;print(json.load(sys.stdin)["key"])')
[ -n "$KEY" ] && ok "ingest key retrievable when authenticated" || bad "no ingest key"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18081/noisy/internal/rtmp/publish \
  -d "app=noisy&name=$KEY")
[ "$code" = "200" ] && ok "valid key accepted by the gate ($code)" || bad "valid key got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18081/noisy/internal/rtmp/publish \
  -d "app=noisy&name=wrongkey")
[ "$code" = "403" ] && ok "wrong key rejected ($code)" || bad "wrong key got $code, want 403"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18081/noisy/internal/rtmp/publish \
  -d "app=other&name=$KEY")
[ "$code" = "403" ] && ok "wrong app rejected ($code)" || bad "wrong app got $code, want 403"

echo "== 9. rotation revokes the old key immediately =="
NEWKEY=$(curl -sk -b $J/jar -X POST $BASE/api/ingest/rotate \
  --data-urlencode "csrf_token=$CSRF" | python3 -c 'import json,sys;print(json.load(sys.stdin)["url"])')
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18081/noisy/internal/rtmp/publish \
  -d "app=noisy&name=$KEY")
[ "$code" = "403" ] && ok "old key revoked without a reload ($code)" || bad "old key still valid ($code)"
case "$NEWKEY" in *19350/noisy/*) ok "rotated URL uses port 19350" ;; *) bad "unexpected url: $NEWKEY" ;; esac

echo "== 10. rate limiting =="
# The login view allows 5 attempts per 300s per client address. Steps above
# already consumed part of that budget, so a few more must trip the limiter.
for i in $(seq 1 8); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' -b $J/jar \
    --data-urlencode "username=admin" --data-urlencode "password=nope-$i" \
    --data-urlencode "csrf_token=$CSRF" $BASE/login)
  [ "$code" = "429" ] && { ok "login rate limit engages (429 after $i more attempts)"; break; }
done
[ "$code" = "429" ] || bad "no rate limit after 8 attempts, last got $code"

echo
echo "failed checks: $FAILED"
exit $((FAILED > 0))
