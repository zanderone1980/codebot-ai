#!/usr/bin/env python3
"""
RFC 003 Part C — first concrete cross-task memory component.

Walks the resolved tasks from a SWE-bench run and extracts structured
SWELesson entries. Output is a single JSON catalog that future runs can
load + match against incoming problem statements.

Usage:
  python3 mine-lessons.py <suite-name> --output lessons.json

Example:
  python3 mine-lessons.py verified-50-20260416-202834 --output seed-lessons.json

This is the FIRST concrete piece of RFC 003. It does NOT close the
reinforce/weaken loop yet (that's Part A — needs CodeBot core changes).
It does mine real evidence from real resolved tasks so the memory has
something to start with when Parts A and B land.
"""
import argparse
import collections
import glob
import json
import re
import sys
from pathlib import Path


def keywords_from_problem(text: str, top_n: int = 8) -> list[str]:
    """Extract content keywords from a problem statement.
    Drops boilerplate and stopwords; keeps technical terms."""
    if not text:
        return []
    # Lowercase, split on non-word
    words = re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", text.lower())
    # Drop common stopwords + SWE-bench boilerplate
    stop = {
        "the", "and", "for", "this", "that", "with", "from", "will",
        "have", "should", "would", "could", "into", "what", "when",
        "where", "which", "your", "there", "their", "these", "those",
        "about", "than", "then", "here", "such", "also", "been", "being",
        "very", "just", "like", "more", "most", "some", "only", "other",
        "between", "above", "below", "after", "before", "while", "during",
        "are", "was", "is", "be", "do", "does", "did", "has", "had",
        "but", "not", "all", "any", "can", "may", "see", "way",
        "code", "file", "function", "method", "class", "test", "tests",
        "example", "expected", "actual", "output", "input", "result",
        "issue", "problem", "bug", "fix", "fixed", "fixing", "broken",
        "current", "currently", "behavior", "behaviour", "above", "below",
        "following", "instead", "however", "therefore", "because",
    }
    counter = collections.Counter(w for w in words if w not in stop)
    return [w for w, _ in counter.most_common(top_n)]


def files_from_patch(patch: str) -> list[str]:
    """Extract a/path/to/file from `--- a/...` lines in a unified diff."""
    files = set()
    for line in patch.splitlines():
        m = re.match(r"^\+\+\+ b/(.+)$", line)
        if m:
            files.add(m.group(1))
    return sorted(files)


def repo_from_instance_id(instance_id: str) -> str:
    """astropy__astropy-12907 → astropy/astropy"""
    if "__" in instance_id:
        org, _, rest = instance_id.partition("__")
        repo, _, _ = rest.partition("-")
        return f"{org}/{repo}"
    return instance_id


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.strip().split("\n")[0])
    p.add_argument("suite", help="run-id of a SWE-bench eval suite (e.g. 'verified-50-20260416-202834')")
    p.add_argument("--predictions", default="",
                   help="path to predictions.json from gen phase (auto-discover by suite if omitted)")
    p.add_argument("--output", default="seed-lessons.json")
    p.add_argument("--dataset", default="princeton-nlp/SWE-bench_Verified",
                   help="HF dataset to pull problem statements from")
    args = p.parse_args()

    bench_dir = Path(__file__).parent
    eval_dir = bench_dir / "logs" / "run_evaluation" / args.suite / "codebot-ai-2.10.0"
    if not eval_dir.exists():
        print(f"ERROR: no eval dir at {eval_dir}", file=sys.stderr)
        return 2

    # Find resolved task IDs
    resolved_ids = []
    for report in glob.glob(str(eval_dir / "*" / "report.json")):
        tid = Path(report).parent.name
        try:
            with open(report) as f:
                inner = json.load(f).get(tid, {})
            if inner.get("resolved"):
                resolved_ids.append(tid)
        except (OSError, json.JSONDecodeError):
            continue
    print(f"# resolved tasks in suite: {len(resolved_ids)}")
    if not resolved_ids:
        print("ERROR: no resolved tasks to mine — nothing to learn from", file=sys.stderr)
        return 2

    # Load predictions to get patches
    if args.predictions:
        pred_path = Path(args.predictions)
    else:
        # Auto-discover: predictions-<suite>.json
        candidates = sorted(bench_dir.glob(f"predictions-{args.suite}.json"))
        if not candidates:
            # Try the prefix-only match
            candidates = sorted(bench_dir.glob("predictions-verified-50-*.json"))
        if not candidates:
            print(f"ERROR: no predictions json found", file=sys.stderr)
            return 2
        pred_path = candidates[-1]
    print(f"# loading predictions from {pred_path.name}")
    with open(pred_path) as f:
        predictions = {p["instance_id"]: p for p in json.load(f)}

    # Load HF dataset to get problem_statement per resolved task
    print(f"# loading dataset {args.dataset} for problem statements...")
    try:
        from datasets import load_dataset
        ds = load_dataset(args.dataset, split="test")
        instances = {row["instance_id"]: row for row in ds if row["instance_id"] in resolved_ids}
    except Exception as e:
        print(f"ERROR loading dataset: {e}", file=sys.stderr)
        return 2

    # Build lessons
    lessons = []
    for tid in resolved_ids:
        pred = predictions.get(tid)
        inst = instances.get(tid)
        if not pred or not inst:
            print(f"  skip {tid}: missing prediction or instance", file=sys.stderr)
            continue
        patch = pred.get("model_patch", "")
        problem = inst.get("problem_statement", "")
        ftp = inst.get("FAIL_TO_PASS", "[]")
        try:
            ftp_list = json.loads(ftp) if isinstance(ftp, str) else list(ftp)
        except (TypeError, json.JSONDecodeError):
            ftp_list = []

        lessons.append({
            "pattern_id": f"swe:{tid}",
            "repo": repo_from_instance_id(tid),
            "instance_id": tid,
            "problem_keywords": keywords_from_problem(problem),
            "files_modified": files_from_patch(patch),
            "fail_to_pass_count": len(ftp_list),
            "patch_size_bytes": len(patch),
            "approach_summary": "",  # human/model fills in later — leave empty rather than hallucinate
            "source_session_ids": [tid],
            "reinforcements": 1,    # this one is by definition a known-good
            "weakenings": 0,
        })

    out = {
        "schema_version": 1,
        "source_suite": args.suite,
        "mined_at": __import__("datetime").datetime.now(__import__("datetime").UTC).isoformat(),
        "lesson_count": len(lessons),
        "lessons": lessons,
    }
    with open(args.output, "w") as f:
        json.dump(out, f, indent=2)
    print(f"# wrote {len(lessons)} lessons to {args.output}")

    # Quick stats
    by_repo = collections.Counter(l["repo"] for l in lessons)
    print("# by repo:")
    for repo, n in by_repo.most_common():
        print(f"  {n:3}  {repo}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
