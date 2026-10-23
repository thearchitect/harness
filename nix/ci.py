#!/usr/bin/env python3
"""CI state and append-only cache publication; stdlib + the runner's gh CLI.

Commit statuses record real checked artifacts and completed publication, not
successful no-op workflow runs. All platforms and workflows share these states.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

SYSTEMS = ("x86_64-linux", "aarch64-linux", "aarch64-darwin")
METADATA = "harness-ci.json"
RELEASE = "nix-cache"
DELAYS = (2, 5, 15, 45)
TRANSIENT = re.compile(r"HTTP (408|429|5\d\d)|rate limit|timed out|connection reset|TLS handshake", re.I)


class GitHubError(RuntimeError):
    pass


class GitHub:
    def __init__(self, repo):
        self.repo = repo

    def run(self, *args, data=None, retry=True):
        for attempt in range(len(DELAYS) + 1):
            try:
                result = subprocess.run(
                    ["gh", *args], input=data, text=True, capture_output=True, timeout=120,
                )
                if result.returncode == 0:
                    return result.stdout
                error = result.stdout + result.stderr
            except subprocess.TimeoutExpired as exc:
                error = f"gh timed out: {exc}"
            if not retry or not TRANSIENT.search(error) or attempt == len(DELAYS):
                raise GitHubError(error)
            print(f"Transient GitHub error; retrying in {DELAYS[attempt]}s: {error}", file=sys.stderr)
            time.sleep(DELAYS[attempt])

    def api(self, endpoint, data=None, method=None):
        args = ["api", "--method", method or ("POST" if data is not None else "GET"),
                f"repos/{self.repo}/{endpoint}"]
        if data is not None:
            args += ["--input", "-"]
        output = self.run(*args, data=json.dumps(data) if data is not None else None)
        return json.loads(output) if output.strip() else None

    def pages(self, endpoint):
        separator = "&" if "?" in endpoint else "?"
        result = self.run("api", "--paginate", "--slurp",
                          f"repos/{self.repo}/{endpoint}{separator}per_page=100")
        return json.loads(result)

    def assets(self):
        return {asset["name"]: asset for page in self.pages(f"releases/{self.release_id}/assets")
                for asset in page}

    def status(self, sha, system, kind):
        self.api(f"statuses/{sha}", {
            "state": "success", "context": context(system, kind),
            "description": "Checked cache artifact ready" if kind == "checked" else "Binary cache published",
            "target_url": f"https://github.com/{self.repo}/actions/runs/{os.environ['GITHUB_RUN_ID']}",
        })

    def ensure_release(self):
        try:
            release = self.api(f"releases/tags/{RELEASE}")
        except GitHubError as exc:
            if "HTTP 404" not in str(exc):
                raise
            release = self.api("releases", {
                "tag_name": RELEASE, "name": "Nix binary cache", "prerelease": True,
                "make_latest": "false", "body": "Append-only binary cache, maintained by CI. Not a release.",
            })
        self.release_id = release["id"]

    def upload(self, path):
        for attempt in range(len(DELAYS) + 1):
            try:
                self.run("release", "upload", RELEASE, str(path), "--repo", self.repo, retry=False)
                return
            except GitHubError as exc:
                # An upload can succeed server-side even if the response is lost.
                asset = self.assets().get(path.name)
                if asset and asset["state"] == "uploaded":
                    check_asset(asset, path)
                    return
                if asset and asset["state"] == "starter":
                    # Only remove an incomplete upload, never a published cache asset.
                    self.api(f"releases/assets/{asset['id']}", method="DELETE")
                if not TRANSIENT.search(str(exc)) or attempt == len(DELAYS):
                    raise
                print(f"Upload failed; retrying in {DELAYS[attempt]}s: {exc}", file=sys.stderr)
                time.sleep(DELAYS[attempt])


def context(system, kind):
    return f"harness/v1/{kind}/{system}"


def artifact_name(system, sha):
    return f"cache-{system}-{sha}"


def artifacts(github, run_id):
    return [artifact for page in github.pages(f"actions/runs/{run_id}/artifacts")
            for artifact in page["artifacts"] if not artifact["expired"]]


def plan(github, system, sha, publish, force):
    if not publish or force:
        return {"action": "build"}
    statuses = [status for page in github.pages(f"commits/{sha}/statuses") for status in page]
    latest = {}
    for status in statuses:  # GitHub returns newest first.
        latest.setdefault(status["context"], status)
    checked = latest.get(context(system, "checked"), {})
    cached = latest.get(context(system, "cached"), {})
    if checked.get("state") == cached.get("state") == "success":
        print(f"{system}: {sha} is already checked and published", file=sys.stderr)
        return {"action": "skip"}
    if checked.get("state") == "success":
        match = re.fullmatch(rf"https://github\.com/{re.escape(github.repo)}/actions/runs/(\d+)",
                             checked.get("target_url", ""))
        if match:
            run_id = match[1]
            try:
                available = artifacts(github, run_id)
            except GitHubError as exc:
                if "HTTP 404" not in str(exc):
                    raise
                available = []
            if any(a["name"] == artifact_name(system, sha) for a in available):
                print(f"{system}: reusing checked artifact from run {run_id}", file=sys.stderr)
                return {"action": "reuse", "source_run": run_id}
    return {"action": "build"}


def metadata(directory, sha, system):
    if not any(directory.glob("*.narinfo")):
        raise ValueError("No signed cache to publish; check NIX_CACHE_SIGNING_KEY")
    (directory / METADATA).write_text(json.dumps({"sha": sha, "system": system}) + "\n")


def payload(directory, sha):
    files = {}
    systems = set()
    for marker in sorted(directory.glob(f"cache-*/{METADATA}")):
        info = json.loads(marker.read_text())
        if info.get("sha") != sha or info.get("system") not in SYSTEMS:
            raise ValueError(f"Unexpected cache metadata: {marker}")
        if info["system"] in systems:
            raise ValueError(f"Duplicate platform artifact: {info['system']}")
        systems.add(info["system"])
        narinfos = list(marker.parent.glob("*.narinfo"))
        if not narinfos:
            raise ValueError(f"Empty checked cache: {marker.parent}")
        for path in marker.parent.iterdir():
            if path.name == METADATA:
                continue
            if not path.is_file() or path.is_symlink():
                raise ValueError(f"Unexpected cache entry: {path}")
            if path.name != "nix-cache-info" and not re.fullmatch(r"[a-z0-9]+\.(narinfo|nar\.(zst|xz|bz2))", path.name):
                raise ValueError(f"Unexpected cache filename: {path.name}")
            if path.name in files:
                with path.open("rb") as left, files[path.name].open("rb") as right:
                    if hashlib.file_digest(left, "sha256").digest() != hashlib.file_digest(right, "sha256").digest():
                        raise ValueError(f"Conflicting cache files: {path.name}")
            files[path.name] = path
    if not systems:
        raise ValueError(f"No checked platform artifacts in {directory}")
    return files, sorted(systems)


def check_asset(asset, path):
    if asset["state"] != "uploaded" or asset["size"] != path.stat().st_size:
        raise ValueError(f"Existing asset is incomplete or differs in size: {path.name}; not overwriting it")


def publish(github, directory, sha):
    files, systems = payload(directory, sha)
    github.ensure_release()
    existing = github.assets()
    # Validate every reference before uploading anything.
    for path in files.values():
        asset = existing.get(path.name)
        if asset and asset["state"] != "starter":
            check_asset(asset, path)
        if path.suffix == ".narinfo":
            urls = [line[5:] for line in path.read_text().splitlines() if line.startswith("URL: ")]
            if (len(urls) != 1 or Path(urls[0]).name != urls[0]
                    or ".nar." not in urls[0] or urls[0] not in files):
                raise ValueError(f"Missing or unsafe archive reference in {path.name}")
    # Recover only unfinished uploads left by a cancelled/failed publisher.
    for name, asset in list(existing.items()):
        if name in files and asset["state"] == "starter":
            github.api(f"releases/assets/{asset['id']}", method="DELETE")
            del existing[name]
    uploaded = 0
    # Finish every archive before publishing any narinfo that could reference it.
    for narinfos in (False, True):
        for name, path in sorted(files.items()):
            if (path.suffix == ".narinfo") != narinfos or name in existing:
                continue
            github.upload(path)
            uploaded += 1
    # A failed or interrupted upload never marks a platform published.
    for system in systems:
        github.status(sha, system, "cached")
    print(f"Published {uploaded} new assets; kept {len(existing)} existing assets; platforms: {', '.join(systems)}")
    return uploaded


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "metadata", "ready", "artifacts", "publish"))
    parser.add_argument("directory", nargs="?", type=Path)
    args = parser.parse_args()
    if args.command in ("metadata", "publish") and args.directory is None:
        parser.error("this command requires a directory")
    sha = os.environ["CI_SHA"]
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("CI_SHA must be a full commit SHA")
    github = GitHub(os.environ["GH_REPO"])
    if args.command in ("plan", "metadata", "ready"):
        system = os.environ["CI_SYSTEM"]
        if system not in SYSTEMS:
            raise ValueError(f"Unsupported platform: {system}")
    if args.command == "plan":
        for key, value in plan(github, system, sha, os.environ.get("CI_PUBLISH") == "true",
                               os.environ.get("CI_FORCE") == "true").items():
            print(f"{key}={value}")
    elif args.command == "metadata":
        metadata(args.directory, sha, system)
    elif args.command == "ready":
        github.status(sha, system, "checked")
    elif args.command == "artifacts":
        expected = {artifact_name(system, sha) for system in SYSTEMS}
        available = any(a["name"] in expected for a in artifacts(github, os.environ["GITHUB_RUN_ID"]))
        print(f"available={str(available).lower()}")
        if not available:
            print("No new cache artifacts; nothing to publish", file=sys.stderr)
    elif args.command == "publish":
        publish(github, args.directory, sha)


if __name__ == "__main__":
    main()
