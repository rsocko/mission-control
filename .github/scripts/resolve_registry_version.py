#!/usr/bin/env python3
"""Resolve an immutable image tag from Docker Registry semantic-version tags."""
from __future__ import annotations

import base64
import binascii
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

SEMVER_PATTERN = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")
DOCKER_TAG_PATTERN = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")


def parse_registry_repository(value: str) -> tuple[str, str]:
    normalized = str(value or "").strip().strip("/")
    if not normalized or "/" not in normalized:
        raise ValueError("registry repository must look like <registry-host>/<repository>")
    host, repository = normalized.split("/", 1)
    return host, repository


def candidate_bases(registry_host: str, authenticated: bool = False) -> list[str]:
    if registry_host.startswith("http://") or registry_host.startswith("https://"):
        base = registry_host.rstrip("/")
        if authenticated and base.startswith("http://"):
            raise ValueError("refusing to send registry credentials over plaintext HTTP")
        return [base]
    if authenticated:
        return [f"https://{registry_host}"]
    return [f"https://{registry_host}", f"http://{registry_host}"]


def build_auth_header(registry_host: str) -> dict[str, str]:
    username = str(os.environ.get("REGISTRY_USERNAME") or "").strip()
    password = str(os.environ.get("REGISTRY_PASSWORD") or "")
    if not username:
        docker_config_path = os.path.join(os.path.expanduser("~"), ".docker", "config.json")
        if os.path.exists(docker_config_path):
            try:
                with open(docker_config_path, encoding="utf-8") as handle:
                    payload = json.load(handle)
                auths = payload.get("auths", {})
                for key in [registry_host, f"https://{registry_host}", f"http://{registry_host}"]:
                    auth_value = str(auths.get(key, {}).get("auth") or "").strip()
                    if auth_value:
                        decoded = base64.b64decode(auth_value, validate=True).decode("utf-8")
                        if ":" not in decoded:
                            raise ValueError("Docker registry credentials have an invalid format")
                        username, password = decoded.split(":", 1)
                        break
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, binascii.Error) as error:
                raise ValueError(f"could not read Docker registry credentials: {error}") from error
    if not username:
        return {}
    token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    return {"Authorization": f"Basic {token}"}


def exchange_bearer_token(challenge: str, headers: dict[str, str]) -> dict[str, str]:
    if not challenge.lower().startswith("bearer "):
        raise ValueError("registry returned an unsupported authentication challenge")
    parameters = dict(re.findall(r'([A-Za-z]+)="([^"]*)"', challenge[7:]))
    realm = parameters.pop("realm", "")
    if not realm:
        raise ValueError("registry bearer challenge omitted its token realm")
    if urllib.parse.urlparse(realm).scheme != "https":
        raise ValueError("refusing to send registry credentials to a non-HTTPS token realm")
    token_url = f"{realm}?{urllib.parse.urlencode(parameters)}"
    request = urllib.request.Request(token_url, headers=headers)
    with urllib.request.urlopen(request, timeout=15) as response:
        payload = json.loads(response.read().decode("utf-8"))
    token = str(payload.get("token") or payload.get("access_token") or "").strip()
    if not token:
        raise ValueError("registry token exchange returned no bearer token")
    return {"Authorization": f"Bearer {token}"}


def fetch_tags(base_url: str, repository: str, headers: dict[str, str]) -> list[str]:
    encoded_repo = "/".join(urllib.parse.quote(segment, safe="") for segment in repository.split("/"))
    next_url: str | None = f"{base_url}/v2/{encoded_repo}/tags/list?n=1000"
    tags: list[str] = []
    seen: set[str] = set()
    request_headers = headers
    while next_url:
        request = urllib.request.Request(next_url, headers=request_headers)
        try:
            response = urllib.request.urlopen(request, timeout=15)
        except urllib.error.HTTPError as error:
            challenge = error.headers.get("WWW-Authenticate", "")
            if error.code != 401 or not headers or request_headers != headers or not challenge:
                raise
            request_headers = exchange_bearer_token(challenge, headers)
            continue
        with response:
            payload = json.loads(response.read().decode("utf-8"))
            for tag in payload.get("tags") or []:
                tag_value = str(tag).strip()
                if tag_value and tag_value not in seen:
                    seen.add(tag_value)
                    tags.append(tag_value)
            link_header = response.headers.get("Link", "")
            match = re.search(r'<([^>]+)>;\s*rel="next"', link_header)
            next_url = urllib.parse.urljoin(next_url, match.group(1)) if match else None
    return tags


def latest_semver(tags: list[str]) -> tuple[str, tuple[int, int, int]] | None:
    semver_tags: list[tuple[tuple[int, int, int], str]] = []
    for tag in tags:
        match = SEMVER_PATTERN.match(tag.strip())
        if match:
            parsed = (int(match.group(1)), int(match.group(2)), int(match.group(3)))
            semver_tags.append((parsed, tag))
    if not semver_tags:
        return None
    parsed, tag = max(semver_tags, key=lambda entry: entry[0])
    return tag, parsed


def compute_next_version(mode: str, latest: tuple[int, int, int] | None) -> str:
    if latest is None:
        return "1.0.0" if mode == "next_major" else "0.1.0"
    major, minor, patch = latest
    if mode == "next_major":
        return f"{major + 1}.0.0"
    if mode == "next_minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def validate_explicit_tag(tag: str) -> str:
    if not DOCKER_TAG_PATTERN.fullmatch(tag):
        raise ValueError("EXPLICIT_TAG must be a valid Docker tag")
    if tag == "latest":
        raise ValueError("EXPLICIT_TAG cannot use the mutable latest tag")
    return tag


def write_output(name: str, value: str) -> None:
    output_path = os.environ.get("GITHUB_OUTPUT")
    if not output_path:
        return
    with open(output_path, "a", encoding="utf-8") as handle:
        handle.write(f"{name}={value}\n")


def main() -> int:
    repository_value = os.environ.get("REGISTRY_REPOSITORY", "")
    mode = str(os.environ.get("VERSION_MODE") or "next_patch").strip()
    explicit_tag = str(os.environ.get("EXPLICIT_TAG") or "").strip()

    if mode not in {"explicit", "next_major", "next_minor", "next_patch"}:
        raise SystemExit(f"Unsupported VERSION_MODE: {mode}")
    if mode == "explicit" and not explicit_tag:
        raise SystemExit("EXPLICIT_TAG is required when VERSION_MODE=explicit")

    registry_host, repository = parse_registry_repository(repository_value)
    auth_headers = build_auth_header(registry_host)
    latest_tag = ""
    registry_base_used = ""

    if mode == "explicit":
        resolved_tag = validate_explicit_tag(explicit_tag)
    else:
        last_error: Exception | None = None
        for base_url in candidate_bases(registry_host, authenticated=bool(auth_headers)):
            try:
                tags = fetch_tags(base_url, repository, auth_headers)
                latest = latest_semver(tags)
                latest_tag = latest[0] if latest else ""
                latest_tuple = latest[1] if latest else None
                registry_base_used = base_url
                break
            except (OSError, ValueError, json.JSONDecodeError) as error:
                last_error = error
        else:
            raise SystemExit(f"Could not inspect registry tags: {last_error}")
        resolved_tag = compute_next_version(mode, latest_tuple)

    print(f"Registry: {repository_value}")
    print(f"Version mode: {mode}")
    print(f"Resolved tag: {resolved_tag}")
    if latest_tag:
        print(f"Latest semantic tag: {latest_tag}")

    write_output("resolved_tag", resolved_tag)
    write_output("resolved_image", f"{repository_value}:{resolved_tag}")
    write_output("latest_tag", latest_tag)
    write_output("registry_api_base", registry_base_used)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        print(f"Registry HTTP error: {error.code} {body}", file=sys.stderr)
        raise
