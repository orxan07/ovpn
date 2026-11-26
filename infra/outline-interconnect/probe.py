#!/usr/bin/python3
"""Exercise the same marked route, DNS and HTTPS egress used by SSTP."""
import socket
import ssl

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.settimeout(5)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, 0x2023)
    sock.bind(("10.27.0.1", 0))
    sock.connect(("chatgpt.com", 443))
    with ssl.create_default_context().wrap_socket(sock, server_hostname="chatgpt.com") as tls:
        tls.sendall(b"GET /cdn-cgi/trace HTTP/1.0\r\nHost: chatgpt.com\r\nConnection: close\r\n\r\n")
        with tls.makefile("rb") as stream:
            response = stream.read(32768)
        headers, _, body = response.partition(b"\r\n\r\n")
        if not headers.startswith((b"HTTP/1.0 200 ", b"HTTP/1.1 200 ")) or b"ip=156.67.63.163" not in body.splitlines():
            raise SystemExit(1)
