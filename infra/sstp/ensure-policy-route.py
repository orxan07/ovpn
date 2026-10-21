#!/usr/bin/python3
"""Keep the SSTP policy rule independent of sing-box's transient 9000 rules."""
import json
import subprocess
import sys

IP = "/usr/sbin/ip"
PRIORITY = 8999
SOURCE = "10.27.0.0/24"


def command(args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=3).stdout


def matches(rule):
    source_ok = (rule.get("src") == "10.27.0.0" and rule.get("srclen") == 24) or (
        rule.get("src") == SOURCE and "srclen" not in rule)
    return (
        set(rule) <= {"priority", "src", "srclen", "fwmark", "fwmask", "table", "protocol"}
        and rule.get("priority") == PRIORITY
        and source_ok
        and rule.get("fwmark") == "0x2023"
        and rule.get("fwmask", "0xffffffff") == "0xffffffff"
        and str(rule.get("table")) == "2022"
    )


def ensure(run=command):
    # Never reactivate an explicitly disabled integration, or send to a dead TUN.
    for service in ("sstp-singbox-route", "sing-box"):
        try:
            run(["/usr/bin/systemctl", "is-active", "--quiet", service])
        except subprocess.CalledProcessError:
            return False
    run(["/usr/sbin/nft", "list", "table", "inet", "sstp-singbox"])
    routes = json.loads(run([IP, "-j", "-4", "route", "show", "table", "2022"]))
    if not any(r.get("dst") == "default" and r.get("dev") == "sbtun"
               and r.get("gateway") == "172.19.0.2" and "dead" not in r.get("flags", [])
               and "linkdown" not in r.get("flags", []) for r in routes):
        raise RuntimeError("sing-box table 2022 has no usable default via sbtun")
    links = json.loads(run([IP, "-j", "link", "show", "dev", "sbtun"]))
    if not links or "UP" not in links[0].get("flags", []):
        raise RuntimeError("sing-box TUN is down")
    rules = json.loads(run([IP, "-j", "-4", "rule", "show"]))
    reserved = [r for r in rules if r.get("priority") == PRIORITY]
    if reserved:
        if len(reserved) != 1 or not matches(reserved[0]):
            raise RuntimeError("priority 8999 is occupied; refusing to replace another rule")
        return False
    run([IP, "-4", "rule", "add", "pref", str(PRIORITY), "from", SOURCE,
         "fwmark", "0x2023", "lookup", "2022"])
    print("Restored SSTP policy route: priority 8999, source 10.27.0.0/24, mark 0x2023 -> table 2022")
    return True


if __name__ == "__main__":
    try:
        ensure()
    except (subprocess.SubprocessError, ValueError, RuntimeError, OSError) as error:
        print(f"SSTP policy route check failed: {error}", file=sys.stderr)
        sys.exit(1)
