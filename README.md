# noisy-next (milestone 1)

Replaces the Flask panel. nginx, datarhei and the egress stack stay untouched.

Done: multi-user login, admin (accounts, quota, logs), per-user ingest keys with a
quota-aware `on_publish` gate, fa/en + dark/light, live tunnel ping/jitter/loss chart.
Not yet: per-user datarhei processes, real traffic metering, applying the bitrate
(it is only stored), route switching UI.

## Install (fish, as root)
    systemctl stop noisy-web.service
    cp scripts/egress-ping scripts/egress-ping.mjs /opt/noisy/scripts/
    chown root:root /opt/noisy/scripts/egress-ping /opt/noisy/scripts/egress-ping.mjs
    chmod 755 /opt/noisy/scripts/egress-ping
    echo 'noisy ALL=(root) NOPASSWD: /opt/noisy/scripts/egress-ping' > /etc/sudoers.d/noisy-ping
    chmod 440 /etc/sudoers.d/noisy-ping
    npm install; npm run build
    # first start only: NOISY_ADMIN_PASSWORD=... in config/web.env (remove it afterwards)
    # systemd: EnvironmentFile=/opt/noisy/config/web.env, ExecStart=/usr/bin/npm start
Existing ingest keys change: every user gets a new key, shown in their panel.
