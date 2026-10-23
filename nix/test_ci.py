#!/usr/bin/env python3
"""Offline regression checks: no credentials, network, Nix builds or publication."""

import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from ci import GitHub, GitHubError, METADATA, artifact_name, context, metadata, plan, publish

SHA = "a" * 40
SYSTEM = "x86_64-linux"


class FakeGitHub:
    repo = "owner/repo"

    def __init__(self):
        self.statuses = []
        self.available = []
        self.remote = {}
        self.events = []
        self.fail_on = None
        self.missing_run = False

    def pages(self, endpoint):
        if endpoint.startswith("commits/"):
            return [self.statuses]
        if self.missing_run:
            raise GitHubError("HTTP 404")
        return [{"artifacts": self.available}]

    def status(self, sha, system, kind):
        self.events.append(("status", system, kind))

    def ensure_release(self):
        pass

    def assets(self):
        return self.remote.copy()

    def upload(self, path):
        if path.name == self.fail_on:
            raise GitHubError("HTTP 503")
        self.events.append(("upload", path.name))
        self.remote[path.name] = {"state": "uploaded", "size": path.stat().st_size}

    def api(self, endpoint, method=None):
        self.events.append((method, endpoint))

    def checked(self, state="success"):
        return {"context": context(SYSTEM, "checked"), "state": state,
                "target_url": "https://github.com/owner/repo/actions/runs/123"}

    def cached(self, state="success"):
        return {"context": context(SYSTEM, "cached"), "state": state}


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.gh = FakeGitHub()

    def test_first_build(self):
        self.assertEqual(plan(self.gh, SYSTEM, SHA, True, False), {"action": "build"})

    def test_already_checked_and_published(self):
        self.gh.statuses = [self.gh.checked(), self.gh.cached()]
        self.assertEqual(plan(self.gh, SYSTEM, SHA, True, False), {"action": "skip"})

    def test_force_rebuilds(self):
        self.gh.statuses = [self.gh.checked(), self.gh.cached()]
        self.assertEqual(plan(self.gh, SYSTEM, SHA, True, True), {"action": "build"})

    def test_pull_requests_do_not_read_or_write_publication_state(self):
        with patch.object(self.gh, "pages", side_effect=AssertionError("unexpected API request")):
            self.assertEqual(plan(self.gh, SYSTEM, SHA, False, False), {"action": "build"})
        self.assertEqual(self.gh.events, [])

    def test_failed_publication_reuses_artifact(self):
        self.gh.statuses = [self.gh.checked(), self.gh.cached("failure")]
        self.gh.available = [{"name": artifact_name(SYSTEM, SHA), "expired": False}]
        self.assertEqual(plan(self.gh, SYSTEM, SHA, True, False),
                         {"action": "reuse", "source_run": "123"})

    def test_expired_or_wrong_revision_artifact_rebuilds(self):
        self.gh.statuses = [self.gh.checked()]
        for artifact in ({"name": artifact_name(SYSTEM, SHA), "expired": True},
                         {"name": artifact_name(SYSTEM, "b" * 40), "expired": False}):
            self.gh.available = [artifact]
            self.assertEqual(plan(self.gh, SYSTEM, SHA, True, False), {"action": "build"})

    def test_deleted_artifact_run_rebuilds(self):
        self.gh.statuses = [self.gh.checked()]
        self.gh.missing_run = True
        self.assertEqual(plan(self.gh, SYSTEM, SHA, True, False), {"action": "build"})

    def test_newest_failure_does_not_use_older_success(self):
        self.gh.statuses = [self.gh.checked("failure"), self.gh.checked(), self.gh.cached()]
        self.assertEqual(plan(self.gh, SYSTEM, SHA, True, False), {"action": "build"})

    def test_other_platform_does_not_count_as_checked(self):
        self.gh.statuses = [self.gh.checked(), self.gh.cached()]
        self.assertEqual(plan(self.gh, "aarch64-darwin", SHA, True, False), {"action": "build"})


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.gh = FakeGitHub()
        self.cache = self.add_platform(SYSTEM)

    def add_platform(self, system, prefix="aaa"):
        cache = self.root / artifact_name(system, SHA)
        cache.mkdir()
        (cache / f"{prefix}.nar.zst").write_bytes(b"archive")
        (cache / f"{prefix}.narinfo").write_text(f"URL: {prefix}.nar.zst\nSig: harness-1:test\n")
        (cache / "nix-cache-info").write_text("StoreDir: /nix/store\n")
        metadata(cache, SHA, system)
        return cache

    def test_append_only_idempotent_and_archive_first(self):
        old = {"state": "uploaded", "size": 99}
        self.gh.remote["older-platform.narinfo"] = old.copy()
        self.assertEqual(publish(self.gh, self.root, SHA), 3)
        uploads = [event[1] for event in self.gh.events if event[0] == "upload"]
        self.assertLess(uploads.index("aaa.nar.zst"), uploads.index("aaa.narinfo"))
        self.assertEqual(self.gh.events[-1], ("status", SYSTEM, "cached"))
        self.assertEqual(self.gh.remote["older-platform.narinfo"], old)
        self.gh.events.clear()
        self.assertEqual(publish(self.gh, self.root, SHA), 0)
        self.assertFalse(any(event[0] == "upload" for event in self.gh.events))

    def test_all_platform_archives_precede_any_narinfo(self):
        self.add_platform("aarch64-darwin", "zzz")
        publish(self.gh, self.root, SHA)
        uploads = [event[1] for event in self.gh.events if event[0] == "upload"]
        self.assertLess(uploads.index("zzz.nar.zst"), uploads.index("aaa.narinfo"))
        self.assertEqual(sum(event[0] == "status" for event in self.gh.events), 2)

    def test_failed_archive_never_publishes_narinfo_or_success(self):
        self.gh.fail_on = "aaa.nar.zst"
        with self.assertRaises(GitHubError):
            publish(self.gh, self.root, SHA)
        self.assertFalse(any(event[0] == "status" or event[-1].endswith(".narinfo")
                             for event in self.gh.events))

    def test_failed_narinfo_never_records_success_and_retry_finishes(self):
        self.gh.fail_on = "aaa.narinfo"
        with self.assertRaises(GitHubError):
            publish(self.gh, self.root, SHA)
        self.assertIn("aaa.nar.zst", self.gh.remote)
        self.assertFalse(any(event[0] == "status" for event in self.gh.events))
        self.gh.fail_on = None
        self.gh.events.clear()
        self.assertEqual(publish(self.gh, self.root, SHA), 1)
        self.assertEqual(self.gh.events[0], ("upload", "aaa.narinfo"))

    def test_recovers_only_incomplete_upload(self):
        self.gh.remote["aaa.nar.zst"] = {"id": 7, "state": "starter", "size": 0}
        publish(self.gh, self.root, SHA)
        self.assertIn(("DELETE", "releases/assets/7"), self.gh.events)
        self.assertEqual(sum(event[0] == "DELETE" for event in self.gh.events), 1)

    def test_refuses_to_clobber_existing_asset(self):
        self.gh.remote["aaa.nar.zst"] = {"state": "uploaded", "size": 100}
        with self.assertRaises(ValueError):
            publish(self.gh, self.root, SHA)
        self.assertEqual(self.gh.events, [])

    def test_rejects_wrong_revision_or_unsafe_reference(self):
        with self.assertRaises(ValueError):
            publish(self.gh, self.root, "b" * 40)
        for url in ("../aaa.nar.zst", "missing.nar.zst", "nix-cache-info"):
            (self.cache / "aaa.narinfo").write_text(f"URL: {url}\n")
            with self.assertRaises(ValueError):
                publish(self.gh, self.root, SHA)
        self.assertEqual(self.gh.events, [])

    def test_rejects_conflicting_platform_payloads(self):
        other = self.add_platform("aarch64-linux")
        (other / "aaa.nar.zst").write_bytes(b"different archive")
        with self.assertRaises(ValueError):
            publish(self.gh, self.root, SHA)
        self.assertEqual(self.gh.events, [])

    def test_empty_cache_cannot_be_marked_ready(self):
        empty = self.root / "empty"
        empty.mkdir()
        with self.assertRaises(ValueError):
            metadata(empty, SHA, SYSTEM)
        self.assertFalse((empty / METADATA).exists())


class TransportTests(unittest.TestCase):
    def test_transient_errors_retry_but_permission_errors_do_not(self):
        gh = GitHub("owner/repo")
        transient = subprocess.CompletedProcess([], 1, "", "HTTP 403: API rate limit exceeded")
        success = subprocess.CompletedProcess([], 0, "{}", "")
        with patch("ci.subprocess.run", side_effect=[transient, success]) as run, patch("ci.time.sleep") as sleep:
            self.assertEqual(gh.api("example"), {})
            self.assertEqual(run.call_count, 2)
            sleep.assert_called_once_with(2)
        denied = subprocess.CompletedProcess([], 1, "", "HTTP 403: Resource not accessible")
        with patch("ci.subprocess.run", return_value=denied) as run, patch("ci.time.sleep") as sleep:
            with self.assertRaises(GitHubError):
                gh.api("example")
            self.assertEqual(run.call_count, 1)
            sleep.assert_not_called()

    def test_retry_count_is_bounded(self):
        failed = subprocess.CompletedProcess([], 1, "", "HTTP 503")
        with patch("ci.subprocess.run", return_value=failed) as run, patch("ci.time.sleep"):
            with self.assertRaises(GitHubError):
                GitHub("owner/repo").api("example")
            self.assertEqual(run.call_count, 5)


if __name__ == "__main__":
    unittest.main()
