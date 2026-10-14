"""CI-only helper tests. No product imports, dependencies, credentials or live services."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("qualification", Path(__file__).with_name("run.py"))
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)


class QualificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cra879-helper-", dir="/tmp" if os.name != "nt" else None)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def test_rejects_runtime_beneath_real_home(self):
        with self.assertRaisesRegex(ValueError, "real home"):
            qualification.preflight(self.root / "child", self.root)

    def test_rejects_marker_in_physical_ancestor(self):
        (self.root / ".agents").mkdir()
        with self.assertRaisesRegex(ValueError, "ancestor"):
            qualification.preflight(self.root / "child", self.root / "other-home")

    def test_rejects_traversal_catalog(self):
        with self.assertRaisesRegex(ValueError, "path"):
            qualification.verify_sources(self.root, [{"path": "../outside", "sha256": "0" * 64}])

    def test_rejects_wrong_source_hash(self):
        (self.root / "source.txt").write_text("actual")
        with self.assertRaisesRegex(ValueError, "hash"):
            qualification.verify_sources(self.root, [{"path": "source.txt", "sha256": "0" * 64}])

    def test_verifies_exact_source(self):
        (self.root / "source.txt").write_bytes(b"exact")
        rows = [{"path": "source.txt", "sha256": hashlib.sha256(b"exact").hexdigest()}]
        self.assertEqual(qualification.verify_sources(self.root, rows), 1)

    def test_clean_environment_drops_nested_test_and_secrets(self):
        parent = {"NODE_TEST_CONTEXT": "child-v8", "OPENAI_API_KEY": "private", "HOME": "/real", "PATH": "/ambient"}
        env = qualification.clean_env(self.root, Path(sys.executable), parent)
        self.assertNotIn("NODE_TEST_CONTEXT", env)
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("/ambient", env["PATH"])
        self.assertEqual(env["HOME"], str(self.root / "home"))
        self.assertEqual(env["TMP"], str(self.root / "tmp"))

    def test_missing_or_duplicate_summary_is_not_a_pass(self):
        for text in ["", self.summary() + self.summary()]:
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    qualification.parse_summary(text)

    def test_zero_tests_and_skips_do_not_qualify(self):
        for tests, passed, skipped in [(0, 0, 0), (1, 0, 1)]:
            counts = qualification.parse_summary(self.summary(tests, passed, skipped))
            self.assertFalse(qualification.qualifies(counts, expected=1, exit_code=0))

    def test_nonzero_command_exit_overrides_green_summary(self):
        counts = qualification.parse_summary(self.summary())
        self.assertFalse(qualification.qualifies(counts, expected=1, exit_code=1))

    def test_exact_positive_counts_qualify(self):
        counts = qualification.parse_summary(self.summary())
        self.assertTrue(qualification.qualifies(counts, expected=1, exit_code=0))
        self.assertFalse(qualification.qualifies(counts, expected=2, exit_code=0))

    def test_rejects_resolved_evidence_escape(self):
        source = self.root / "evidence"
        source.mkdir()
        escaped = source / "data.json"
        escaped.write_text("{}")
        real_resolve = Path.resolve
        def resolve(path, *args, **kwargs):
            return self.root / "outside.json" if path == escaped else real_resolve(path, *args, **kwargs)
        anchor = self.anchor(source)
        with patch.object(Path, "resolve", resolve):
            with self.assertRaisesRegex(ValueError, "escaping"):
                qualification.retain_evidence(source, self.root / "retained", anchor)

    def test_command_failure_keeps_exit_and_completed_logs(self):
        out = self.root / "command"
        env = qualification.clean_env(self.root, Path(sys.executable), os.environ)
        result = qualification.run_command([sys.executable, "-c", "print('owned toy'); raise SystemExit(7)"], self.root, env, out, 5)
        self.assertEqual(result["exitCode"], 7)
        self.assertTrue(result["nativeParentSettled"])
        self.assertFalse(result["timedOut"])
        self.assertIn("owned toy", (out / "stdout.txt").read_text())
        self.assertEqual(json.loads((out / "exit.json").read_text())["exitCode"], 7)

    def test_command_timeout_cannot_be_cleanup_generated_success(self):
        out = self.root / "timeout"
        env = qualification.clean_env(self.root, Path(sys.executable), os.environ)
        result = qualification.run_command([sys.executable, "-c", "import time; time.sleep(30)"], self.root, env, out, 0.05)
        self.assertTrue(result["timedOut"])
        self.assertTrue(result["nativeParentSettled"])
        self.assertNotEqual(result["exitCode"], 0)
        self.assertTrue((out / "failure-before-cleanup.json").is_file())

    def test_missing_tap_keeps_settled_failure_evidence(self):
        project, rows, source, anchor, out = self.result_fixture()
        (out / "tests/stdout.txt").write_text("incomplete TAP")
        result = qualification.finish_tests(project, rows, source, anchor, out, self.failed_command(), 1)
        self.assertFalse(result["qualificationComplete"])
        self.assertIn("summary", result["errors"])
        self.assertEqual(json.loads((out / "test-evidence/custody.json").read_text()), {"settled": True})

    def test_scan_error_cannot_qualify_otherwise_green_run(self):
        project, rows, source, anchor, out = self.result_fixture()
        command = {**self.failed_command(), "exitCode": 0}
        with patch.object(qualification.os, "scandir", side_effect=PermissionError("owned scan failure")):
            result = qualification.finish_tests(project, rows, source, anchor, out, command, 1)
        self.assertFalse(result["qualificationComplete"])
        self.assertIn("owned scan failure", result["errors"]["evidence"])
        self.assertEqual(result["counts"]["pass"], 1)
        self.assertNotIn("summary", result["errors"])
        self.assertNotIn("source", result["errors"])

    def test_source_failure_keeps_independent_fixture_evidence(self):
        project, rows, source, anchor, out = self.result_fixture()
        rows[0]["sha256"] = "0" * 64
        result = qualification.finish_tests(project, rows, source, anchor, out, self.failed_command(), 1)
        self.assertIn("source", result["errors"])
        self.assertTrue((out / "test-evidence/custody.json").is_file())
        self.assertFalse(result["qualificationComplete"])

    def test_unsettled_parent_does_not_snapshot_live_evidence(self):
        project, rows, source, anchor, out = self.result_fixture()
        command = {**self.failed_command(), "nativeParentSettled": False}
        result = qualification.finish_tests(project, rows, source, anchor, out, command, 1)
        self.assertIn("settlement", result["errors"])
        self.assertFalse((out / "test-evidence").exists())
        self.assertFalse(result["qualificationComplete"])

    def test_replaced_evidence_root_is_rejected(self):
        source = self.root / "evidence"
        source.mkdir()
        anchor = self.anchor(source)
        source.rename(self.root / "old-evidence")
        source.mkdir()
        (source / "data.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "root identity"):
            qualification.retain_evidence(source, self.root / "retained", anchor)

    def test_home_cache_and_raw_session_trees_are_excluded(self):
        source = self.root / "evidence"
        source.mkdir()
        (source / "custody.json").write_text("{}")
        for name in ["home", "config", "cache", "appdata", "sessions", "transcripts", "node_modules"]:
            (source / name).mkdir()
            (source / name / "private.json").write_text("{}")
        (source / "session.jsonl").write_text("{}")
        rows = qualification.retain_evidence(source, self.root / "retained", self.anchor(source))
        self.assertEqual([row["path"] for row in rows], ["custody.json"])

    def test_runner_context_is_only_evaluated_in_steps(self):
        repo = Path(__file__).resolve().parents[2]
        workflow = (repo / ".github/workflows/cra879-qualification.yml").read_text()
        job_prefix, steps = workflow.split("\n    steps:\n", 1)
        self.assertNotIn("runner.", job_prefix, "runner context is unavailable in jobs.<job_id>.env")
        self.assertNotIn("env.CRA879_OUT", workflow)
        self.assertEqual(steps.count("${{ runner.temp }}/cra879-results"), 3)

    def test_workflow_overrides_ambient_crlf_before_checkout(self):
        repo = Path(__file__).resolve().parents[2]
        workflow = (repo / ".github/workflows/cra879-qualification.yml").read_text()
        values = dict(re.findall(r"^      (GIT_CONFIG_(?:COUNT|KEY_\d|VALUE_\d)): '([^']*)'$", workflow, re.M))
        self.assertEqual(values.get("GIT_CONFIG_COUNT"), "2")
        config = self.root / "gitconfig"
        config.write_text("[core]\n\tautocrlf = true\n")
        env = {**os.environ, "GIT_CONFIG_GLOBAL": str(config), "GIT_CONFIG_NOSYSTEM": "1", **values}
        filtered = subprocess.check_output(["git", "cat-file", "--filters", "HEAD:.github/workflows/test.yml"], cwd=repo, env=env)
        self.assertEqual(hashlib.sha256(filtered).hexdigest(), "c36117c424e2f7ab69a40f840e9e56bb2ba3cf8b0c3580d1d971961552394273")
        self.assertNotIn(b"\r\n", filtered)

    def result_fixture(self):
        project = self.root / "project"
        project.mkdir()
        (project / "source.txt").write_bytes(b"exact")
        rows = [{"path": "source.txt", "sha256": hashlib.sha256(b"exact").hexdigest()}]
        source = self.root / "evidence"
        source.mkdir()
        (source / "custody.json").write_text('{"settled": true}')
        out = self.root / "out"
        (out / "tests").mkdir(parents=True)
        (out / "tests/stdout.txt").write_text(self.summary())
        return project, rows, source, self.anchor(source), out

    def anchor(self, source):
        stat = source.stat()
        parent_stat = self.root.stat()
        return {"path": str(source.resolve()), "device": stat.st_dev, "inode": stat.st_ino,
                "runtime": str(self.root.resolve()), "runtimeDevice": parent_stat.st_dev, "runtimeInode": parent_stat.st_ino}

    @staticmethod
    def failed_command():
        return {"exitCode": 1, "timedOut": False, "nativeParentSettled": True}

    @staticmethod
    def summary(tests=1, passed=1, skipped=0):
        return f"# tests {tests}\n# pass {passed}\n# fail 0\n# cancelled 0\n# skipped {skipped}\n"


if __name__ == "__main__":
    unittest.main()
