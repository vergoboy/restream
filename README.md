# noisy-next (milestone 2) - served at /restream

Per-user destinations (RTMP URL + stream key stored separately, key sealed with AES-GCM),
multi-select start/stop (one datarhei process per destination), per-destination chart,
real traffic metering + quota stop, optional re-encode bitrate, admin VPN route switch
with per-route latency traces, admin management of every destination.

## Upgrade from milestone 1 (fish, as root)
    # new sudoers (args are validated inside the scripts)
    printf '%s\n' \
      'noisy ALL=(root) NOPASSWD: /opt/noisy/scripts/egress-ping *' \
      'noisy ALL=(root) NOPASSWD: /opt/noisy/scripts/egress-status' \
      'noisy ALL=(root) NOPASSWD: /opt/noisy/scripts/egress-set *' > /etc/sudoers.d/noisy-ping
    chmod 440 /etc/sudoers.d/noisy-ping; visudo -cf /etc/sudoers.d/noisy-ping
    cp scripts/egress-ping scripts/egress-ping.mjs /opt/noisy/scripts/
    chown root:root /opt/noisy/scripts/egress-ping*; chmod 755 /opt/noisy/scripts/egress-ping
    # restream.env needs the datarhei core API login (same values as secrets/core.env):
    #   NOISY_CORE_API=http://127.0.0.1:18080  NOISY_CORE_USER=...  NOISY_CORE_PASS=...
    #   NOISY_NGINX_RTMP_HOST=172.28.240.1
    sudo -u noisy npm run build; systemctl restart restream-web
The master key (secrets/master.key) must be readable by the noisy user.

## Switching the RTMP gate (do this last, in a quiet moment)
nginx/rtmp.conf: on_publish http://127.0.0.1:18082/restream/internal/rtmp/publish;
then nginx -t && reload. Old single ingest key stops working; each user has their own.
