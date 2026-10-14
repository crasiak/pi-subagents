#!/usr/bin/env python3
"""CI-only exact-source qualification. No product changes, ambient homes or retries."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

EXPECTED = {"unit": 1184, "integration": 586, "e2e": 1}
CATALOG = Path(__file__).with_name("source-v4.json")


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_sources(root, rows):
    seen = set()
    for row in rows:
        name = row["path"]
        relative = PurePosixPath(name)
        if not name or relative.is_absolute() or ".." in relative.parts or "\\" in name or ":" in name or name in seen:
            raise ValueError(f"invalid/duplicate source path: {name}")
        seen.add(name)
        path = root / name
        if not path.resolve().is_relative_to(root.resolve()) or path.is_symlink():
            raise ValueError(f"source path escapes or is a symlink: {name}")
        if sha(path) != row["sha256"]:
            raise ValueError(f"source hash mismatch: {name}")
    return len(seen)


def preflight(path, real_home):
    physical = path.resolve()
    if physical.is_relative_to(real_home.resolve()):
        raise ValueError(f"runtime beneath real home: {physical}")
    for ancestor in [physical, *physical.parents]:
        for marker in [".pi", ".agents"]:
            if (ancestor / marker).exists():
                raise ValueError(f"unsafe project-discovery ancestor: {ancestor / marker}")
    return str(physical)


def clean_env(runtime, node, parent):
    paths = [str(node.parent)]
    env = {}
    if os.name == "nt":
        for key in ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]:
            if key in parent:
                env[key] = parent[key]
        system = Path(parent.get("SystemRoot", r"C:\Windows"))
        paths += [str(system / "System32"), str(system), str(system / "System32/Wbem")]
        git = shutil.which("git", path=parent.get("PATH", parent.get("Path", "")))
        if git:
            paths.append(str(Path(git).parent))
    else:
        paths += ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    env.update({
        "PATH": os.pathsep.join(paths), "HOME": str(runtime / "home"),
        "USERPROFILE": str(runtime / "home"), "APPDATA": str(runtime / "home/AppData/Roaming"),
        "LOCALAPPDATA": str(runtime / "home/AppData/Local"),
        "TMPDIR": str(runtime / "tmp"), "TMP": str(runtime / "tmp"), "TEMP": str(runtime / "tmp"),
        "XDG_CONFIG_HOME": str(runtime / "config"), "XDG_CACHE_HOME": str(runtime / "cache"),
        "XDG_DATA_HOME": str(runtime / "data"), "XDG_STATE_HOME": str(runtime / "state"),
        "CRA879_EVIDENCE_DIR": str(runtime / "test-evidence"), "JITI_FS_CACHE": "true",
        "GIT_OPTIONAL_LOCKS": "0", "LANG": "C.UTF-8", "NO_COLOR": "1", "FORCE_COLOR": "0",
        "npm_config_cache": str(runtime / "npm-cache"),
        "npm_config_userconfig": str(runtime / "empty-npmrc"),
        "npm_config_globalconfig": str(runtime / "empty-global-npmrc"),
    })
    return env


def parse_summary(text):
    values = {}
    for key in ["tests", "pass", "fail", "cancelled", "skipped"]:
        matches = re.findall(r"^# " + key + r" (\d+)\r?$", text, re.M)
        if len(matches) != 1:
            raise ValueError(f"missing/ambiguous TAP summary: {key}")
        values[key] = int(matches[0])
    return values


def qualifies(counts, expected, exit_code):
    return (exit_code == 0 and counts == {
        "tests": expected, "pass": expected, "fail": 0, "cancelled": 0, "skipped": 0,
    } and expected > 0)


def run_command(argv, cwd, env, out, timeout):
    out.mkdir(parents=True, exist_ok=False)
    save(out / "command.json", {"argv": argv, "cwd": str(cwd), "environment": env,
         "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "outerFailureTimeoutSeconds": timeout})
    start = time.monotonic()
    result = {"exitCode": None, "timedOut": False, "nativeParentSettled": False, "cleanup": []}
    # Only rename logs after native parent settlement. In-flight .pending files are NOT uploaded.
    with (out / "stdout.pending").open("xb") as stdout, (out / "stderr.pending").open("xb") as stderr:
        options = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
        process = subprocess.Popen(argv, cwd=cwd, env=env, stdout=stdout, stderr=stderr, **options)
        try:
            result["exitCode"] = process.wait(timeout=timeout)
            result["nativeParentSettled"] = True
        except subprocess.TimeoutExpired:
            result["timedOut"] = True
            save(out / "failure-before-cleanup.json", {"reason": "outer command timeout", "pid": process.pid})
            if process.poll() is None and process.pid > 0 and process.pid != os.getpid():
                try:
                    if os.name == "nt":
                        system = Path(os.environ.get("SystemRoot", r"C:\Windows"))
                        killed = subprocess.run([str(system / "System32/taskkill.exe"), "/PID", str(process.pid), "/T", "/F"],
                                                capture_output=True, timeout=10)
                        result["cleanup"].append({"action": "owned-parent taskkill tree", "exitCode": killed.returncode})
                    else:
                        if os.getpgid(process.pid) != process.pid:
                            raise RuntimeError("owned process group no longer matches parent")
                        os.killpg(process.pid, signal.SIGKILL)
                        result["cleanup"].append({"action": "owned new process group SIGKILL"})
                except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                    result["cleanup"].append({"error": str(error)})
            try:
                result["exitCode"] = process.wait(timeout=10)
                result["nativeParentSettled"] = True
            except subprocess.TimeoutExpired:
                result["cleanup"].append({"error": "owned test parent did not settle; descendant state unknown"})
    result["elapsedMs"] = (time.monotonic() - start) * 1000
    if result["nativeParentSettled"]:
        for name in ["stdout", "stderr"]:
            (out / f"{name}.pending").rename(out / f"{name}.txt")
    result["descendantLimit"] = "Parent settlement is not exhaustive detached-descendant closure; test-owned lifecycle evidence is separate."
    save(out / "exit.json", result)
    return result


def evidence_anchor(source, runtime):
    physical = source.resolve()
    if source.is_symlink() or physical != source.absolute() or physical.parent != runtime.resolve():
        raise ValueError("evidence root identity is not the newly owned runtime child")
    stat, parent_stat = source.stat(), runtime.stat()
    return {"path": str(physical), "device": stat.st_dev, "inode": stat.st_ino,
            "runtime": str(runtime.resolve()), "runtimeDevice": parent_stat.st_dev, "runtimeInode": parent_stat.st_ino}


def check_evidence_root(source, anchor):
    fixed = Path(anchor["path"])
    runtime = Path(anchor["runtime"])
    if (not source.is_dir() or source.is_symlink() or getattr(source, "is_junction", lambda: False)()
            or source.resolve() != fixed or not fixed.is_relative_to(runtime)):
        raise ValueError("evidence root identity replaced or redirected")
    stat, parent_stat = source.stat(), runtime.stat()
    if ((stat.st_dev, stat.st_ino) != (anchor["device"], anchor["inode"])
            or (parent_stat.st_dev, parent_stat.st_ino) != (anchor["runtimeDevice"], anchor["runtimeInode"])):
        raise ValueError("evidence root identity changed since creation")
    return fixed


EXCLUDED_DIRS = {"home", "config", "cache", "appdata", "localappdata", "sessions", "transcripts",
                 "node_modules", "jiti", "node-compile-cache", ".pi", ".agents", ".sage", ".sage-memory"}


def retain_evidence(source, target, anchor):
    fixed = check_evidence_root(source, anchor)
    target.mkdir(exist_ok=False)
    rows, total, entries = [], 0, 0
    def fail_scan(error):
        raise error
    for current, dirs, files in os.walk(source, followlinks=False, onerror=fail_scan):
        check_evidence_root(source, anchor)
        dirs[:] = sorted(name for name in dirs if name.lower() not in EXCLUDED_DIRS and not name.startswith("v8-compile-cache-"))
        for name in sorted(dirs + files):
            entries += 1
            if entries > 10000:
                raise ValueError("synthetic evidence exceeds 10000 processed-entry retention cap")
            path = Path(current) / name
            if (path.is_symlink() or getattr(path, "is_junction", lambda: False)()
                    or not path.resolve().is_relative_to(fixed)):
                raise ValueError("symlink or escaping reparse path refused in public synthetic evidence")
            if not path.is_file() or path.suffix not in {".json", ".jsonl", ".txt"}:
                continue
            if path.suffix == ".jsonl" and ("session" in name.lower() or "transcript" in name.lower()):
                continue
            check_evidence_root(source, anchor)
            remaining = 100 * 1024 * 1024 - total
            with path.open("rb") as stream:
                data = stream.read(remaining + 1)
            if len(data) > remaining:
                raise ValueError("synthetic evidence exceeds 100MiB retention bound")
            total += len(data)
            relative = path.relative_to(source)
            dest = target / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            with dest.open("xb") as stream:
                stream.write(data)
            rows.append({"path": str(relative), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    check_evidence_root(source, anchor)
    return sorted(rows, key=lambda row: row["path"])


def finish_tests(project, rows, source, anchor, out, command, expected):
    errors, evidence, counts = {}, [], None
    if not command["nativeParentSettled"]:
        errors["settlement"] = "native test parent not settled; no fixture snapshot"
    else:
        # Failure evidence is independent of source/TAP validity. Each outcome stays separate.
        try:
            evidence = retain_evidence(source, out / "test-evidence", anchor)
        except Exception as error:
            errors["evidence"] = str(error)
        try:
            verify_sources(project, rows)
        except Exception as error:
            errors["source"] = str(error)
        try:
            counts = parse_summary((out / "tests/stdout.txt").read_text(encoding="utf-8"))
        except Exception as error:
            errors["summary"] = str(error)
    complete = not errors and not command["timedOut"] and qualifies(counts, expected, command["exitCode"])
    result = {"counts": counts, "command": command, "errors": errors, "qualificationComplete": complete,
              "postParentExitEvidenceSnapshots": evidence,
              "evidenceLimit": "Snapshots after test-parent exit, not exhaustive detached-writer closure or hostile same-UID security. On retention error partial files are not certified. Failure cleanup never creates a pass.",
              "excludedEvidenceDirectories": sorted(EXCLUDED_DIRS),
              "excludedEvidenceFiles": "session/transcript-named JSONL; non-json/jsonl/txt; v8-compile-cache-* directories",
              "skipPolicy": "No skipped coverage qualifies. Five inherited Windows skips each in unit/integration remain unwaived.",
              "scope": "One exact-source platform/profile/suite execution; no retry or performance-equivalence claim."}
    save(out / "result.json", result)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite", choices=EXPECTED, required=True)
    parser.add_argument("--profile", choices=["default", "serial"], required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=False)
    root = Path(__file__).resolve().parents[2]
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    rows = catalog["identities"]
    node = Path(shutil.which("node") or "missing-node").resolve()
    real_home = Path.home().resolve()
    parent = Path(os.environ["RUNNER_TEMP"]) if os.name == "nt" else Path("/tmp")
    runtime = Path(tempfile.mkdtemp(prefix="cra879-platform-", dir=parent)).resolve()
    try:
        preflight(runtime, real_home)
        verify_sources(root, rows)
        for directory in ["home", "tmp", "config", "cache", "data", "state", "test-evidence", "npm-cache", "home/AppData/Local", "home/AppData/Roaming"]:
            (runtime / directory).mkdir(parents=True, exist_ok=True)
        for name in ["empty-npmrc", "empty-global-npmrc"]:
            (runtime / name).touch(exist_ok=False)
        project = runtime / "project"
        project.mkdir()
        for row in rows:
            dest = project / row["path"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(root / row["path"], dest)
        for path in [project, runtime / "home", runtime / "tmp"]:
            preflight(path, real_home)
        env = clean_env(runtime, node, os.environ)
        anchor = evidence_anchor(runtime / "test-evidence", runtime)
        version = subprocess.check_output([str(node), "--version"], env=env, timeout=10, text=True).strip()
        if version != "v24.13.0":
            raise ValueError(f"wrong Node executable version: {version}")
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, env=env, timeout=10, text=True).strip()
        expected_head = os.environ.get("CRA879_EXPECTED_HEAD", "")
        if not re.fullmatch(r"[0-9a-f]{40}", expected_head) or head != expected_head:
            raise ValueError("checkout does not match exact approved PR head")
        save(args.out / "identity.json", {"headSha": head, "pythonVersion": sys.version,
             "controllerSha256": sha(Path(__file__)), "node": str(node), "nodeVersion": version, "nodeSha256": sha(node),
             "sourceCatalogSha256": sha(CATALOG), "originalSourceCatalogSha256": catalog["originalSourceCatalogSha256"],
             "sourcePaths": verify_sources(project, rows), "runtime": str(runtime), "ancestryPreflight": "passed", "evidenceAnchor": anchor,
             "suite": args.suite, "profile": args.profile,
             "ci": {key: os.environ.get(key) for key in ["GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB", "RUNNER_OS", "RUNNER_ARCH", "ImageOS", "ImageVersion"]}})
        npm_candidates = [node.parent / "node_modules/npm/bin/npm-cli.js", node.parent.parent / "lib/node_modules/npm/bin/npm-cli.js"]
        npm = next((path for path in npm_candidates if path.is_file()), None)
        if npm is None:
            raise ValueError("npm-cli.js not found beside selected Node; no ambient npm fallback")
        install = run_command([str(node), str(npm), "ci", "--ignore-scripts", "--no-audit", "--no-fund"], project, env, args.out / "install", 600)
        if install["exitCode"] != 0 or install["timedOut"]:
            raise RuntimeError("locked dependency installation failed; zero product tests launched")
        verify_sources(project, rows)
        dependencies = []
        for name in ["jiti", "typebox", "@earendil-works/pi-tui", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent"]:
            path = project / "node_modules" / name / "package.json"
            dependencies.append({"name": name, "version": json.loads(path.read_text(encoding="utf-8"))["version"], "packageJsonSha256": sha(path)})
        save(args.out / "selected-dependencies.json", {"packages": dependencies, "limit": "Selected package identities and lock; not whole dependency-file/executable closure."})
        argv = [str(node)]
        if args.suite == "unit":
            argv += ["--experimental-strip-types"]
        else:
            argv += ["--experimental-transform-types", "--import", "./test/support/register-loader.mjs"]
        argv += ["--test", "--test-reporter=tap"]
        if args.profile == "serial":
            argv += ["--test-concurrency=1"]
        argv += [str(path) for path in sorted((project / "test" / args.suite).glob("*.test.ts"))]
        command = run_command(argv, project, env, args.out / "tests", 900)
        result = finish_tests(project, rows, runtime / "test-evidence", anchor, args.out, command, EXPECTED[args.suite])
        print(json.dumps({"suite": args.suite, "profile": args.profile, "counts": result["counts"], "errors": result["errors"], "qualificationComplete": result["qualificationComplete"]}))
        return 0 if result["qualificationComplete"] else 1
    except Exception as error:
        save(args.out / "failure.json", {"error": str(error), "qualificationComplete": False})
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
