# Noisy

Single-user restreaming service. OBS publishes RTMP to a public endpoint, the
panel authenticates the publish, and the stream is forwarded to a configured
destination (normally a YouTube live stream) with **all** outbound traffic
forced through a VPN endpoint.

- Panel: `https://vergoboy.ir/noisy/`
- Ingest: `rtmp://vergoboy.ir:19350/noisy/<ingest-key>` (shown in the panel)

## How a stream flows

```
OBS ──rtmp──▶ nginx:19350 ──on_publish──▶ panel gate (ingest key)
                     │
                     │  (the restreamer reads it back as an RTMP client)
                     ▼
              datarhei core (ffmpeg) ──rtmps──▶ destination
                                │
                                └──▶ sing-box TUN ──▶ VPN endpoint ──▶ internet
```

Three things about this shape are load-bearing and easy to get wrong:

1. **The gate must answer `on_publish` with an empty 2xx body.** nginx-rtmp
   reads a non-empty 2xx body as *the name of a stream to redirect to*, so a
   gate that returns `ok` renames the publish and closes the session.
2. **nginx does not relay anything.** Debian's `libnginx-mod-rtmp` ships
   `ngx_rtmp_auto_push_module` instead of `ngx_rtmp_push_module`: it accepts the
   `push` directive and opens the TCP connection, then relays no bytes. The
   core therefore reads the application out of nginx itself, over the docker
   bridge gateway, as an ordinary RTMP client.
3. **The stream name is the ingest key**, because the ingest URL has no separate
   playpath. The core bakes the current key into its input address, which is why
   rotating the key drops any running process.

## Layout

| Path | What it is |
| --- | --- |
| `/opt/noisy/app` | Flask panel (runs as the `noisy` user, gunicorn on 127.0.0.1:18081) |
| `/opt/noisy/secrets` | master key, encrypted secret store, tunnel configs, core credentials |
| `/opt/noisy/data` | panel state the service may write (`secrets.enc`, `session.key`) |
| `/opt/noisy/scripts` | `noisyctl`, `egress-test`, `egress-watchdog`, `check-venv` |
| `/opt/noisy/systemd` | `noisy-web.service`, egress watchdog unit and timer |
| `/opt/noisy/restreamer` | datarhei core config and data, bind-mounted into the container |

Containers on the `noisy` docker network (`172.28.240.0/24`):

| Container | Address | Role |
| --- | --- | --- |
| `noisy-restreamer` | `172.28.240.2` | datarhei core, runs the ffmpeg process |
| `noisy-egress` | shared netns | sing-box TUN, so ffmpeg cannot bypass the tunnel |
| `noisy-egress-xray` | `172.28.240.3` | SOCKS5 fallback for XHTTP/ML-KEM, unreachable from the host |

The core's own RTMP server is **disabled**. It is a client of nginx now, so its
listener would only be an unused attack surface.

## Operating

```sh
sudo /opt/noisy/scripts/noisyctl status     # containers, health, tunnel
sudo /opt/noisy/scripts/noisyctl logs       # data-plane (compose) logs
sudo /opt/noisy/scripts/noisyctl web-logs   # panel (journal) logs
sudo /opt/noisy/scripts/egress-status       # tunnel routes and exit IP
sudo /opt/noisy/scripts/egress-set <route>  # switch VPN route (refreshes the watchdog)
sudo systemctl restart noisy-web.service     # panel only, drops live sessions
sudo bash /opt/noisy/install.sh              # re-run the installer (idempotent)
```

Tunnel: `sudo systemctl status noisy-egress-watchdog.timer`, and check the exit
IP the restreamer actually gets:

```sh
docker exec noisy-restreamer wget -qO- https://api.ipify.org
```

That must be the VPN endpoint. If it ever prints the host's public IP, the
tunnel is not routing and the restream is leaking the host's address.

### How the tunnel is watched

`noisy-egress-watchdog` runs every minute and checks the restreamer's **exit
IP**, not DNS. That distinction matters: compose hands the containers public
resolvers, so DNS keeps answering when every packet is already leaving on the
host IP, and a DNS-based check reports a leak as healthy. It compares the exit
IP against the two values recorded by the installer
(`data/egress/expected_exit_ip` and `data/egress/host_exit_ip`) and:

- repairs a confirmed host-IP egress immediately, because that is a leak and
  not a flaky probe;
- otherwise wants two consecutive failures, so one slow request cannot loop;
- recreates `noisy-egress` with `compose up --force-recreate`, not
  `docker restart`. The tunnel shares the restreamer's network namespace
  (`network_mode: service:noisy-restreamer`), so if that namespace is
  recreated — a plain `docker restart noisy-restreamer` is enough — a running
  tunnel container stays attached to the *old* namespace and a restart in place
  does not rejoin it. Only a fresh container does.

After switching routes, run `egress-set`; it refreshes the expected exit IP so
the watchdog does not fight the new route.

### The core leaks zombie processes

The datarhei core spawns ffmpeg for the process and never reaps the children.
Every attempt that fails — no publisher connected yet, destination
unreachable — leaves a permanent zombie behind, at the rate of
`reconnect_delay_seconds` (5s). Measured on this host: 242 zombies, all
`ppid` = the core, which is the entire `pids.max`.

At Docker's default 256 that is reached within minutes, and once `pids.current`
hits `pids.max` **every `fork` in the container fails with `EAGAIN`**. The
symptoms are confusing because nothing looks broken: the container still reports
`healthy`, the TUN is still up, DNS still resolves, and plain HTTP still works —
but `docker exec` reports `can't fork`, every panel probe comes back empty, and
the data plane is dead. The tunnel looks "broken" when the tunnel is fine.

Only the parent can reap a zombie, and the parent is the core, so the fix is to
replace the container. Two mitigations are in place:

- `pids_limit: 4096` on `noisy-restreamer`, so the pile takes hours to become
  fatal instead of minutes.
- `reclaim_zombies()` in the watchdog: before each probe it reads the
  container's `pids.current` and `pids.max` from the cgroup and recreates the
  container (and the tunnel, which shares its netns) at 80%. It reads the cgroup
  from the host rather than asking the container, precisely because a container
  out of pids cannot fork to answer the question.

The underlying leak is upstream and not fixed here.

**Known limitation, not fixed:** this repairs the leak, it does not prevent
it. Between the tunnel dropping and the next watchdog tick (up to ~70s) traffic
does leave on the host IP, and the restreamer's netns keeps a default route via
the bridge that allows it. Two fixes were tried on this host and rejected:

1. *Deleting the default route inside the restreamer's netns.* sing-box needs
   that route for its own outbound, and removing it took the container's DNS
   and health probes with it, so the stack could no longer self-diagnose.
   Needs `CAP_NET_ADMIN` to do at all.

2. *A host netfilter drop in `DOCKER-USER` for unmarked packets from
   `172.28.240.0/24`,* with sing-box tagging its own traffic via
   `route.default_mark`. This is the shape of the real fix, and it **does not
   work here**: sing-box's mark is not visible to the host's filter chain, so
   the drop rule blackholes the tunnel outright. Measured, not assumed — with
   the mark set in the running config (`default_mark: 20057`) and two counting
   `ACCEPT` rules at the top of `DOCKER-USER` (which cannot break the data
   path), one successful tunneled request produced:

   ```
   0 packets  mark match 0x4e59/0x4e59   /* the tunnel's own traffic */
   5 packets  (no mark match)            /* everything else */
   ```

   All of the tunnel's own traffic arrives **unmarked**. The config parses and
   the mark is set; it is simply not on the packet by the time it reaches the
   host. Rolling the rules back restored the tunnel in one probe, but DNS
   stayed wedged until `noisy-egress` was restarted.

   To re-check this before touching production, use the same counting probe —
   never install a `DROP` on the strength of it:

   ```sh
   sudo iptables -I DOCKER-USER 1 -s 172.28.240.0/24 -m mark --mark 0x4e59/0x4e59 \
     -m comment --comment markprobe -j ACCEPT
   sudo iptables -I DOCKER-USER 2 -s 172.28.240.0/24 \
     -m comment --comment markprobe-unmarked -j ACCEPT
   docker exec noisy-restreamer wget -qO- --timeout=20 https://api.ipify.org
   sudo iptables -L DOCKER-USER -v -n --line-numbers
   ```

   If the marked counter is still 0, sing-box is not marking its outbound and
   this whole approach is dead. A different mechanism is needed — a marked
   rule is not one, since the restreamer netns also needs its default route
   for the tunnel to exist at all.

Whoever retries this must first confirm the mark is visible to the host with a
counter-only rule, and must ship a rollback that is faster than the repair. Do
not enable a drop rule on a live box on the assumption it works.

## Tests

Both scripts take the panel password as their only argument and must run as root.

```sh
sudo bash /opt/noisy/tests/e2e-control.sh   '<password>'   # panel, auth, CSRF, gate
sudo bash /opt/noisy/tests/e2e-dataplane.sh '<password>'   # real stream, end to end
```

The data-plane test publishes a paced synthetic stream to the public URL and
requires bytes to arrive at an in-network sink. It leaves the destination
cleared and the process stopped; run the control suite afterwards, not before,
because the control suite rotates the ingest key and trips the login rate limit
(5 attempts per 5 minutes per IP).

## Gotchas

- **Login is rate limited** to 5 attempts per 5 minutes per IP. The limiter is
  in memory, so restarting `noisy-web.service` clears it.
- **Never write the secret store as root.** `SecretStore` rewrites
  `secrets.enc` with the writer's ownership; a root write leaves it `root:root`
  and every panel request that needs a secret returns 500. Use the API as the
  `noisy` user, or run the code as `noisy`.
- **`-f flv` on the output is required.** ffmpeg picks a muxer from the output
  extension and an RTMP URL has none, so the process dies with `Unable to
  choose an output format` and nothing is ever sent.
- **`start` reports scheduling, not data.** A started process with no publisher
  is legitimately `running` with zero frames; the panel cannot know whether
  OBS is connected. Check `frame` in `/api/status` for that.
- The test publisher must be paced (`-re`). An unpaced `lavfi` source runs at
  roughly 28x realtime and is dropped.
