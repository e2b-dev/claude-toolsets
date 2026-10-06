"""Application URL policy plus reserved sandbox endpoint protection."""

from __future__ import annotations

import ipaddress
import re
from collections.abc import Iterable
from urllib.parse import urlsplit

from anthropic.tools import ToolError
from anthropic.tools.browser import BetaURLPolicy


def normalize_url(url: str) -> str:
    url = re.sub(r"[\t\r\n]", "", url).lstrip("".join(map(chr, range(33)))).replace("\\", "/")
    if not re.match(r"^[a-z][a-z0-9+.-]*:", url, re.I) or re.match(r"^[^:/?#]+:\d+(?:[/?#]|$)", url):
        url = "https://" + url
    return url


def check_url(url: str) -> str:
    url = normalize_url(url)
    try:
        parts = urlsplit(url)
        if parts.scheme == "about" and parts.path == "blank" and not parts.query:
            return url
        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
            raise ValueError
        port = parts.port or (443 if parts.scheme == "https" else 80)
        if local_host(parts.hostname) and port in {9222, 49983, 6080}:
            raise ValueError
    except ValueError:
        raise ToolError("The URL scheme, credentials or reserved endpoint is not allowed") from None
    return url


def local_host(host: str) -> bool:
    host = host.lower().rstrip(".")
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        address = ipaddress.ip_address(host)
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        return not address.is_global
    except ValueError:
        # Chrome accepts legacy IPv4 notation; treat numeric hosts conservatively.
        return bool(re.match(r"^(?:0x[0-9a-f]+|[0-9.]+)$", host, re.I))


def allow_hosts(domains: Iterable[str]) -> BetaURLPolicy:
    """Allow HTTP(S) hosts and subdomains, optionally restricted to a port. Not a DNS firewall."""
    rules = []
    for domain in domains:
        parsed = urlsplit("https://" + domain.strip())
        if not parsed.hostname or parsed.path or parsed.query or parsed.fragment or parsed.username:
            raise ValueError("Host rules must be hostnames with an optional port")
        rules.append((parsed.hostname.lower().rstrip("."), parsed.port))

    def policy(_context, url: str) -> None:
        parsed = urlsplit(check_url(url))
        if parsed.scheme == "about":
            return
        host = (parsed.hostname or "").lower().rstrip(".")
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        if not any((host == rule or host.endswith("." + rule)) and (p is None or port == p) for rule, p in rules):
            raise ToolError("Navigation is outside the allowed hosts")

    return policy
