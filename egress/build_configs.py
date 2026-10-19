#!/usr/bin/env python3
"""
Noisy egress configuration builder.

Reads the (secret) subscription file and renders two data-plane configs:

  sing-box.json  - owns the TUN device inside the restreamer container's netns.
                   Handles every protocol sing-box supports natively.
  xray.json      - plain userspace SOCKS5 proxy on the docker bridge. Handles
                   the protocols sing-box cannot do (XHTTP, ML-KEM XTLS).
                   sing-box reaches it through a socks outbound, so the two
                   engines never nest inside each other's tunnel.

No secret is ever written to stdout or to a log file.
"""
import base64
import json
import os
import re
import socket
import stat
import sys
import urllib.parse as up

SECRETS = "/opt/noisy/secrets"
DATA = "/opt/noisy/data"
SB_OUT = os.path.join(SECRETS, "sing-box.json")
XR_OUT = os.path.join(SECRETS, "xray.json")
SUB = os.path.join(SECRETS, "subscription.txt")

# Deterministic, collision-free addressing for the internal docker network.
NET_CIDR = "172.28.240.0/24"
XR_IP = "172.28.240.3"
XR_SOCKS_PORT = 1081

# Route preference. First entry that passes its health check is the primary.
PREFERRED_ORDER = [
    "vpn-hysteria2",
    "vpn-grpc",
    "vpn-reality",
    "vpn-httpupgrade",
    "vpn-xhttp",
    "vpn-httpobf",
]

# Google's video/ingest hosts. RTMP ingest lands on a.rtmps.youtube.com, so
# this list has to cover the whole family and not just www.youtube.com.
YOUTUBE_DOMAINS = [
    "youtube.com",
    "googlevideo.com",
    "ytimg.com",
    "ggpht.com",
    "googleapis.com",
]


def _q(qs):
    out = {}
    for part in qs.split("&"):
        if part:
            k, _, v = part.partition("=")
            out.setdefault(up.unquote_plus(k), up.unquote_plus(v))
    return out


def is_httpobf(p):
    # Some subscriptions encode HTTP obfuscation as type=tcp + headerType=http
    # rather than type=http.
    return p.get("type", "tcp") == "http" or p.get("headerType") == "http"


def tag_for(scheme, p):
    if scheme == "hysteria2":
        return "vpn-hysteria2"
    sec = p.get("security", "none")
    t = p.get("type", "tcp")
    if sec == "reality":
        return "vpn-reality"
    if t == "grpc":
        return "vpn-grpc"
    if t == "httpupgrade":
        return "vpn-httpupgrade"
    if t == "xhttp":
        return "vpn-xhttp"
    if is_httpobf(p):
        return "vpn-httpobf"
    if p.get("encryption", "none").startswith("mlkem"):
        return "vpn-mlkem"
    return "vpn-vless-" + t


def parse_subscription(path=SUB):
    raw = open(path, "r").read().strip()
    if "://" not in raw:
        raw = base64.b64decode(raw).decode("utf-8", "replace")
    entries = []
    for line in raw.splitlines():
        line = line.strip()
        if not line or "://" not in line:
            continue
        scheme, _, rest = line.partition("://")
        cred, _, hostpart = rest.rpartition("@")
        hostpart = hostpart.split("#", 1)[0]
        address, _, port = hostpart.partition(":")
        port = port.split("/")[0].split("?")[0]
        qs = line.split("?", 1)[1].split("#", 1)[0] if "?" in line else ""
        p = _q(qs)
        entries.append({
            "scheme": scheme,
            "tag": tag_for(scheme, p),
            "uuid_or_password": cred,
            "host": address,
            "port": int(port),
            "q": p,
        })
    return entries


def xray_only(entry):
    """True when sing-box cannot express this outbound."""
    q = entry["q"]
    if entry["scheme"] != "vless":
        return False
    if q.get("type") == "xhttp":          # no XHTTP transport in sing-box
        return True
    if q.get("encryption", "none").startswith("mlkem"):
        return True                        # post-quantum XTLS is Xray-only
    return False


def singbox_outbound(e):
    q, host, port = e["q"], e["host"], e["port"]
    if e["scheme"] == "hysteria2":
        return {
            "type": "hysteria2", "tag": e["tag"],
            "server": host, "server_port": port,
            "password": e["uuid_or_password"],
            "up_mbps": 50, "down_mbps": 300,
            "obfs": {"type": "salamander", "password": q.get("obfs-password", "")},
            "tls": {"enabled": True, "server_name": q.get("sni", host),
                    "alpn": q.get("alpn", "h3").split(",")},
        }
    ob = {
        "type": "vless", "tag": e["tag"],
        "server": host, "server_port": port,
        "uuid": e["uuid_or_password"],
        "packet_encoding": "xudp",
    }
    if q.get("flow"):
        ob["flow"] = q["flow"]
    fp = q.get("fp", "chrome")
    if q.get("security") == "reality":
        ob["tls"] = {
            "enabled": True, "server_name": q.get("sni", host),
            "alpn": ["h2", "http/1.1"],
            "utls": {"enabled": True, "fingerprint": fp},
            "reality": {"enabled": True, "public_key": q["pbk"]},
        }
        if q.get("sid"):
            ob["tls"]["reality"]["short_id"] = q["sid"]
        return ob

    ob["tls"] = {
        "enabled": True, "server_name": q.get("sni", host),
        "alpn": q.get("alpn", "h2,http/1.1").split(","),
        "utls": {"enabled": True, "fingerprint": fp},
    }
    path, hst = q.get("path", ""), q.get("host", "")
    typ = q.get("type", "tcp")
    if typ == "grpc":
        ob["transport"] = {"type": "grpc",
                           "service_name": q.get("serviceName", "")}
    elif typ == "httpupgrade":
        ob["transport"] = {"type": "httpupgrade", "path": path,
                           "host": hst or ""}
    elif is_httpobf(q):
        ob["transport"] = {"type": "http", "path": path, "host": hst or ""}
    return ob


def xray_outbound(e):
    q, host, port = e["q"], e["host"], e["port"]
    user = {"id": e["uuid_or_password"],
            "encryption": q.get("encryption", "none")}
    if q.get("flow"):
        user["flow"] = q["flow"]
    ss = {"network": q.get("type", "tcp"), "security": q.get("security", "none")}
    if q.get("security") == "reality":
        rs = {"fingerprint": q.get("fp", "chrome"),
              "serverName": q.get("sni", host), "publicKey": q["pbk"]}
        if q.get("sid"):
            rs["shortId"] = q["sid"]
        if q.get("spx"):
            rs["spiderX"] = q["spx"]
        ss["realitySettings"] = rs
    else:
        ss["tlsSettings"] = {"serverName": q.get("sni", host),
                             "fingerprint": q.get("fp", "chrome"),
                             "alpn": q.get("alpn", "h2,http/1.1").split(",")}
        typ = q.get("type", "tcp")
        if typ == "grpc":
            ss["grpcSettings"] = {"serviceName": q.get("serviceName", ""),
                                  "multiMode": False}
        elif typ == "httpupgrade":
            ss["httpupgradeSettings"] = {"path": q.get("path", ""),
                                         "host": q.get("host", "")}
        elif typ == "xhttp":
            ss["xhttpSettings"] = {"path": q.get("path", ""),
                                   "host": q.get("host", ""),
                                   "mode": q.get("mode", "auto"),
                                   "extra": json.loads(q["extra"])
                                   if q.get("extra", "").startswith("{") else None}
        elif is_httpobf(q):
            # network stays "tcp"; the obfuscation is a crafted HTTP request.
            ss["tcpSettings"] = {"header": {
                "type": "http",
                "request": {"version": "1.1", "method": "GET",
                            "path": [q.get("path", "/")]}}}
    return {"tag": "prox-" + e["tag"].replace("vpn-", ""),
            "protocol": "vless",
            "settings": {"vnext": [{"address": host, "port": port,
                                    "users": [user]}]},
            "streamSettings": ss}


def build(entries, primary=None):
    native = [e for e in entries if not xray_only(e)]
    xray_ones = [e for e in entries if xray_only(e)]
    # Static hosts entries break the bootstrap cycle: sing-box must be able to
    # resolve the tunnel endpoint before that tunnel exists. Resolved here, on
    # the host, with the host's normal working resolver.
    dns_hosts = {}
    vpn_ips = []
    for e in entries:
        host = e["host"]
        try:
            addrs = sorted({i[4][0] for i in
                           socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)})
        except OSError:
            addrs = []
        if not addrs:
            raise SystemExit(
                "cannot resolve tunnel endpoint %s - the host resolver is "
                "broken and the tunnel cannot bootstrap" % host)
        dns_hosts[host] = addrs
        for a in addrs:
            vpn_ips.append("%s/32" % a)

    sb_tags = [e["tag"] for e in native]
    if primary and primary in sb_tags:
        final = primary
    else:
        final = next((t for t in PREFERRED_ORDER if t in sb_tags), sb_tags[0])

    outbounds = [singbox_outbound(e) for e in native]
    if xray_ones:
        outbounds.append({"type": "socks", "tag": "vpn-xray",
                          "server": XR_IP, "server_port": XR_SOCKS_PORT,
                          "version": "5"})
    outbounds.append({"type": "direct", "tag": "direct"})

    rules = [
        {"action": "sniff"},
        # Plain DNS is hijacked on this network AND at the VPN exit, so
        # resolution has to happen inside sing-box or TLS never completes.
        {"protocol": "dns", "action": "hijack-dns"},
    ]
    if xray_ones:
        # The Hysteria2 node on this account resets TLS to Google's video and
        # ingest hosts: www.youtube.com completes no handshake through it
        # (verified repeatedly from the restreamer netns), while the same
        # request through the Xray outbound returns 204. Since YouTube is the
        # main thing this service restreams to, send those domains over the
        # outbound that is known to work instead of the one that does not.
        # Placed after hijack-dns and before the catch-all "final".
        rules.append({
            "domain_suffix": YOUTUBE_DOMAINS,
            "outbound": "vpn-xray",
            "action": "route",
        })
    rules += [
        # Keep the container-to-container plane and the tunnel
        # handshakes off the tunnel itself.
        {"ip_cidr": [NET_CIDR, "127.0.0.0/8", "224.0.0.0/4"],
         "outbound": "direct", "action": "route"},
        {"ip_cidr": vpn_ips, "outbound": "direct",
         "action": "route"},
    ]

    dns_servers = [
        {"type": "hosts", "tag": "dns-static",
         "predefined": dns_hosts},
        {"type": "udp", "tag": "dns-udp", "server": "1.1.1.1"},
        {"type": "tcp", "tag": "dns-tcp", "server": "1.1.1.1"},
    ]
    dns_rules = []
    if xray_ones:
        # Resolution has to leave from the same exit as the data. Asking 1.1.1.1
        # over the Hysteria2 exit returns 10.10.34.35 for www.youtube.com, and
        # that address resets the TLS handshake on both exits, so ffmpeg can
        # never finish connecting to the RTMP ingest host. The same question
        # asked over the Xray exit returns 142.251.15x.4, which is verified to
        # serve /generate_204 with a 204. TCP here, not UDP: the socks outbound
        # carries DNS over TCP reliably.
        dns_servers.append({"type": "tcp", "tag": "dns-xray",
                            "server": "1.1.1.1", "detour": "vpn-xray"})
        dns_rules.append({"domain_suffix": YOUTUBE_DOMAINS,
                          "server": "dns-xray"})

    singbox = {
        "log": {"level": "warn", "timestamp": True},
        "inbounds": [{
            "type": "tun", "tag": "tun-in", "interface_name": "tun0",
            "address": ["172.31.240.1/30", "fdfe:dead:beef::1/126"],
            "mtu": 1500, "auto_route": True, "strict_route": True,
            "stack": "system",
        }],
        "outbounds": outbounds,
        "route": {
            "rules": rules,
            "final": final,
            "auto_detect_interface": True,
            "default_domain_resolver": {"server": "dns-udp"},
        },
        "dns": {
            # Plain DNS is hijacked on this network and at the VPN exit, so
            # resolution has to happen inside sing-box. Use stateless transports
            # only. A long lived DoH/HTTP2 connection is the one part of this
            # that wedges silently: when Cloudflare closes it, sing-box stops
            # answering every query until the process is restarted, taking the
            # restream down with it. Measured on this host, plain UDP through
            # the tunnel is also far quicker than DNS over TCP, which pays a
            # fresh tunnel handshake per query.
            "servers": dns_servers,
            "rules": dns_rules,
            "final": "dns-udp",
            "strategy": "prefer_ipv4",
        },
        "experimental": {"cache_file": {"enabled": True,
                                        "path": "/opt/noisy/data/egress/cache.db"}},
    }

    xray = {
        "log": {"loglevel": "warning"},
        "inbounds": [{"tag": "socks-in", "protocol": "socks",
                      "listen": "0.0.0.0", "port": XR_SOCKS_PORT,
                      "settings": {"auth": "noauth", "udp": True,
                                   "allowTransparent": False}}],
        "outbounds": [xray_outbound(e) for e in xray_ones] + [
            {"tag": "direct", "protocol": "freedom", "settings": {}}],
        "observatory": {
            "subjectSelector": ["prox-"],
            "probeURL": "https://www.gstatic.com/generate_204",
            "probeInterval": "45s",
            "enableConcurrency": True,
        },
        "routing": {
            "domainStrategy": "AsIs",
            "rules": [{"type": "field", "inboundTag": ["socks-in"],
                       "balancerTag": "balancer"}],
            "balancers": [{
                "tag": "balancer",
                "selector": ["prox-"],
                "strategy": {"type": "leastPing", "settings": {"baseline": 300}},
                "fallbackTag": "direct",
            }],
        },
    }
    return singbox, xray, sb_tags, final


def write_secure(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(obj, fh, indent=2)
    os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
    os.replace(tmp, path)
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def main():
    # usage: build_configs.py [primary-route] [output-dir]
    # The output dir lets a health check render an isolated config for a
    # candidate route without touching the live one.
    primary = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != "-" else None
    outdir = sys.argv[2] if len(sys.argv) > 2 else None
    entries = parse_subscription()
    sb, xr, sb_tags, final = build(entries, primary)
    if outdir:
        os.makedirs(outdir, mode=0o700, exist_ok=True)
        write_secure(os.path.join(outdir, "sing-box.json"), sb)
        write_secure(os.path.join(outdir, "xray.json"), xr)
    else:
        write_secure(SB_OUT, sb)
        write_secure(XR_OUT, xr)
    routes = PREFERRED_ORDER + ["vpn-xray"]
    print(json.dumps({
        "singbox_primary": final,
        "singbox_native": sb_tags,
        "xray_only": [e["tag"] for e in entries if xray_only(e)],
        "routes": routes,
    }, indent=2))


if __name__ == "__main__":
    main()
