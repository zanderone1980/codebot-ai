# Tier 2.1 v2 — Docker-based test-driven inner loop (DESIGNED, NOT BUILT)

## Why v1 isn't enough

The current `run_failing_tests()` in `gen_predictions.py` runs pytest in the
harness venv. Per-repo Python and dep versions vary widely across SWE-bench
tasks (Django 3.0 wants distutils, astropy wants cython/numpy/scipy at
specific versions, etc.) so for almost every task the inner pytest call
collects with `ModuleNotFoundError` and the loop correctly returns "no
signal — submit patch as-is".

Net effect of v1: behaves identically to having no test loop on most tasks.
Real lift is bounded by however many tasks happen to import cleanly in the
harness Python. In our 50-task slice that's ≤2 tasks.

## v2 design

Use the SWE-bench Docker image that the eval phase already pulls. That
image has the exact Python + deps the official scoring uses. If a patch
passes inside that container, it will (almost certainly) pass the eval.

### Pseudocode

```python
def run_failing_tests_in_docker(instance_id, test_names, patch, base_commit):
    image = f"swebench/sweb.eval.x86_64.{instance_id}:latest"
    # 1. Spawn container, mount nothing — image already has the repo at base_commit
    # 2. Apply patch inside the container
    # 3. Run pytest inside the container with timeout
    # 4. Capture and return output

    apply = subprocess.run([
        "docker", "run", "--rm", "-i",
        "-v", f"{patch_path}:/tmp/patch.diff:ro",
        image,
        "bash", "-c",
        "cd /testbed && git apply --whitespace=fix /tmp/patch.diff && "
        f"python -m pytest --tb=short -x --no-header -q {' '.join(shlex.quote(t) for t in test_names[:5])}"
    ], capture_output=True, text=True, timeout=180)

    if apply.returncode == 0:
        return True, ""
    return False, (apply.stdout + "\n" + apply.stderr)[-2000:]
```

### Cost / wall-time impact

- Per inner iteration: ~2-3 min (image already cached after eval phase pull)
- One extra inner iteration on ~50% of tasks ≈ +1-1.5 hr wall on a 50-task run
- Token cost for the extra LLM call: ~$0.30 per task that triggers
- Expected lift: 5-15pp on resolved-rate based on the django-11400 evidence
  (4/6 FAIL_TO_PASS were already passing — one targeted iteration likely
  closes the gap)

### Open questions before implementing

1. **Image availability**: Some SWE-bench Verified instances may not have a
   pre-built image; the eval harness builds them on demand. Inner loop
   would need fallback (skip, don't fail the whole task).
2. **Patch apply conflicts**: If CodeBot's patch can't apply cleanly (line
   numbers shifted, whitespace, etc.) the loop must distinguish that from
   a test failure.
3. **Concurrency**: Eval runs `max_workers=2` Docker containers. If we add
   inner-loop containers for the gen phase, peak concurrency could be 4+,
   which on a 32GB Mac may swap. Probably need a semaphore.

### Status

- Design: this document
- Implementation: not started
- Estimated effort: ~1 day (4-6 hrs of careful Docker/subprocess work + testing)
- Priority: highest single lever for SWE-bench score after Tier 1
