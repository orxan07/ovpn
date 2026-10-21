import importlib.util
import json
from pathlib import Path
import subprocess
import unittest

spec = importlib.util.spec_from_file_location(
    "policy", Path(__file__).resolve().parents[1] / "infra/sstp/ensure-policy-route.py")
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
OWN = {"priority": 8999, "src": "10.27.0.0", "srclen": 24, "fwmark": "0x2023", "table": "2022"}


class Host:
    def __init__(self):
        self.rules = [{"priority": 0, "src": "all", "table": "local"},
                      {"priority": 9000, "src": "all", "fwmark": "0x2024", "goto": 9002}]
        self.routes = [{"dst": "default", "dev": "sbtun", "gateway": "172.19.0.2"}]
        self.links = [{"flags": ["UP", "POINTOPOINT"]}]
        self.inactive = None
        self.nft_missing = False
        self.adds = []

    def run(self, args):
        if args[0] == "/usr/bin/systemctl":
            if args[-1] == self.inactive:
                raise subprocess.CalledProcessError(3, args)
            return ""
        if args[0] == "/usr/sbin/nft":
            if self.nft_missing:
                raise subprocess.CalledProcessError(1, args)
            return "table inet sstp-singbox {}"
        if args == [policy.IP, "-j", "-4", "route", "show", "table", "2022"]:
            return json.dumps(self.routes)
        if args == [policy.IP, "-j", "link", "show", "dev", "sbtun"]:
            return json.dumps(self.links)
        if args == [policy.IP, "-j", "-4", "rule", "show"]:
            return json.dumps(self.rules)
        expected = [policy.IP, "-4", "rule", "add", "pref", "8999", "from", "10.27.0.0/24",
                    "fwmark", "0x2023", "lookup", "2022"]
        if args != expected:
            raise AssertionError(f"Unexpected command: {args}")
        self.adds.append(args)
        self.rules.append(OWN.copy())
        return ""


class PolicyTests(unittest.TestCase):
    def test_recovers_without_native_singbox_rules_and_is_idempotent(self):
        host = Host()
        original = host.rules.copy()
        self.assertTrue(policy.ensure(host.run))
        self.assertFalse(policy.ensure(host.run))
        self.assertEqual(len(host.adds), 1)
        self.assertEqual(host.rules, original + [OWN])

    def test_inactive_service_never_adds_rule(self):
        for service in ("sing-box", "sstp-singbox-route"):
            host = Host()
            host.inactive = service
            self.assertFalse(policy.ensure(host.run))
            self.assertEqual(host.adds, [])

    def test_cidr_json_variant_is_recognized(self):
        host = Host()
        cidr_rule = dict(OWN, src="10.27.0.0/24")
        del cidr_rule["srclen"]
        host.rules.append(cidr_rule)
        self.assertFalse(policy.ensure(host.run))
        self.assertEqual(host.adds, [])

    def test_missing_nft_never_adds_rule(self):
        host = Host()
        host.nft_missing = True
        with self.assertRaises(subprocess.CalledProcessError):
            policy.ensure(host.run)
        self.assertEqual(host.adds, [])

    def test_conflicting_or_duplicate_rule_is_preserved(self):
        for conflicting in ([dict(OWN, table="main")], [dict(OWN, src="all")],
                            [dict(OWN, srclen=16)], [dict(OWN, fwmask="0xffff")], [dict(OWN, iif="other")],
                            [OWN.copy(), OWN.copy()]):
            host = Host()
            host.rules += conflicting
            original = host.rules.copy()
            with self.assertRaisesRegex(RuntimeError, "occupied"):
                policy.ensure(host.run)
            self.assertEqual(host.rules, original)
            self.assertEqual(host.adds, [])

    def test_missing_or_wrong_route_never_adds_rule(self):
        for routes in ([], [{"dst": "default", "dev": "wan", "gateway": "172.19.0.2"}],
                       [{"dst": "default", "dev": "sbtun", "gateway": "172.19.0.3"}],
                       [{"dst": "default", "dev": "sbtun", "gateway": "172.19.0.2", "flags": ["linkdown"]}]):
            host = Host()
            host.routes = routes
            with self.assertRaisesRegex(RuntimeError, "no usable default"):
                policy.ensure(host.run)
            self.assertEqual(host.adds, [])

    def test_down_tun_never_adds_rule(self):
        host = Host()
        host.links = [{"flags": ["POINTOPOINT"]}]
        with self.assertRaisesRegex(RuntimeError, "TUN is down"):
            policy.ensure(host.run)
        self.assertEqual(host.adds, [])


if __name__ == "__main__":
    unittest.main()
