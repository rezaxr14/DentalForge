#!/usr/bin/env python3
"""TraceForge reference worker (contract v1).

Pull-based and OUTBOUND-ONLY: it polls the web app, so it works from a home GPU
behind NAT, a Colab/Kaggle session, or a cloud box — no inbound port needed.

    export TRACEFORGE_URL=https://your-app.vercel.app
    export TRACEFORGE_TOKEN=tf_wrk_...        # pnpm worker:token --org <slug>
    pip install -r requirements.txt && python worker.py

Only handlers listed in HANDLERS are advertised at /register, so the app's
capability ladder never routes work to something this worker cannot do. Add a
handler (see the stubs below) and it is advertised automatically.

Robustness rules baked in (Colab sessions die; networks flap):
  * heartbeat runs on its own thread — it renews job leases and returns
    `cancelJobIds`, so a long job with no events is not reaped from a live worker;
  * 409 on any job write  = lease lost / cancelled / finished -> drop the job;
  * 503 (+Retry-After)    = server or DB is down -> back off and keep polling;
  * 401 / 426             = fatal (revoked token / unsupported contract version).
"""
from __future__ import annotations

import hashlib
import json
import os
import signal
import socket
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import httpx

from worker_errors import ContractError, NonRetryable

CONTRACT_VERSION = "1"
COMPAT_REPROBE_S = int(os.environ.get("COMPAT_REPROBE_S", "300"))


@dataclass
class JobContext:
    job: dict[str, Any]
    client: "Client"
    abort: threading.Event
    seq: int = 0
    artifact_ids: list[str] = field(default_factory=list)

    def emit(self, type_: str, data: Any) -> None:
        if self.abort.is_set():
            raise ContractError(409, "job_cancelled", "cancelled")
        self.seq += 1
        self.client.post(f"/jobs/{self.job['id']}/events", {"events": [{"seq": self.seq, "type": type_, "data": data}]})

    def upload(self, name: str, mime: str, data: bytes) -> str:
        artifact_id = self.client.upload_artifact(self.job["id"], name, mime, data)
        self.artifact_ids.append(artifact_id)
        return artifact_id


class Client:
    def __init__(self, base_url: str, token: str, timeout: float = 35.0):
        self.base = base_url.rstrip("/") + "/api/worker/v1"
        self.token = token
        self.worker_id: str | None = None
        self.http = httpx.Client(timeout=timeout)

    def _headers(self) -> dict[str, str]:
        h = {"authorization": f"Bearer {self.token}", "x-contract-version": CONTRACT_VERSION}
        if self.worker_id:
            h["x-worker-id"] = self.worker_id
        return h

    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        r = self.http.post(self.base + path, json=body, headers=self._headers())
        if r.is_success:
            return r.json()
        code, detail = "unknown", r.reason_phrase
        try:
            p = r.json()
            code, detail = p.get("code", code), p.get("detail") or p.get("title") or detail
        except ValueError:
            pass
        ra = r.headers.get("retry-after")
        raise ContractError(r.status_code, code, f"POST {path} -> {r.status_code} {code}: {detail}",
                            float(ra) if ra and ra.replace(".", "", 1).isdigit() else None)

    def get(self, path: str) -> dict[str, Any]:
        r = self.http.get(self.base + path, headers=self._headers())
        if r.is_success:
            return r.json()
        code, detail = "unknown", r.reason_phrase
        try:
            p = r.json()
            code, detail = p.get("code", code), p.get("detail") or p.get("title") or detail
        except ValueError:
            pass
        ra = r.headers.get("retry-after")
        raise ContractError(r.status_code, code, f"GET {path} -> {r.status_code} {code}: {detail}",
                            float(ra) if ra and ra.replace(".", "", 1).isdigit() else None)

    def register(self, name: str, runtime: str, jobs: list[str], software: dict[str, Any] | None = None) -> dict[str, Any]:
        r = self.post("/register", {
            "name": name, "runtime": runtime,
            "software": software if software is not None else {"python": sys.version.split()[0]},
            "capabilities": [{"job": j, "versions": [1]} for j in jobs],
        })
        self.worker_id = r["workerId"]
        return r

    def upload_artifact(self, job_id: str, name: str, mime: str, data: bytes) -> str:
        p = self.post(f"/jobs/{job_id}/artifacts/presign",
                      {"name": name, "mime": mime, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        put = self.http.put(p["uploadUrl"], content=data, headers=p.get("headers", {}))
        if not put.is_success:
            raise ContractError(put.status_code, "upload_failed", f"artifact PUT -> {put.status_code}")
        return p["artifactId"]


# --------------------------------------------------------------------------- handlers
def system_ping(ctx: JobContext) -> dict[str, Any]:
    """Contract diagnostic: echo + progress events. Implemented so the pipe is testable with no GPU."""
    p = ctx.job["payload"]
    steps = int(p.get("steps", 3))
    for i in range(1, steps + 1):
        ctx.emit("progress", {"pct": round(100 * i / max(steps, 1)), "step": i})
        time.sleep(float(os.environ.get("STEP_DELAY_S", "0.3")))
    return {"echo": p.get("message", "ping"), "workerName": WORKER_NAME, "steps": steps}


def agent_run(ctx: JobContext) -> dict[str, Any]:  # pragma: no cover - stub
    """STUB. Run the agent loop, streaming one `turn` event per turn.

    VLM-DENTAL: `dental_agent/agent/langgraph_loop.py`. Emit each turn record
    (turn, raw_output, parsed, status, tool_calls_this_turn) via ctx.emit("turn", ...), upload tool
    images as artifacts, and return {finalAnswer, nTurns, nToolCalls, formatOk, rewardComponents?}.
    """
    raise NotImplementedError("wire the LangGraph agent loop here")


def eval_run(ctx: JobContext) -> dict[str, Any]:  # pragma: no cover - stub
    """STUB. Evaluate a model; stream case rows as `partial` events.

    VLM-DENTAL: `scripts/run_zero_shot.py` / `dental_agent/evaluation/`. Return {runId (uuid), n, summary:{...}}.
    """
    raise NotImplementedError("wire the evaluation harness here")


def al_score(ctx: JobContext) -> dict[str, Any]:  # pragma: no cover - stub
    """STUB. Uncertainty scores for the active-learning queue ({scores:[{imageId, meanConf, minConf, entropy, nBoxes}]})."""
    raise NotImplementedError("score images with the YOLO model here")


# Only IMPLEMENTED handlers are advertised. Move a stub in here once it works.
HANDLERS: dict[str, Callable[[JobContext], dict[str, Any]]] = {
    "system.ping": system_ping,
}


def _enable_dental_handlers() -> None:
    """tool.execute / yolo.prelabel from VLM-DENTAL's `dental_agent`, each only if its prerequisites hold."""
    try:
        import dental_handlers
    except ImportError as e:  # pragma: no cover - dental_handlers itself has no hard deps
        print(f"[worker] dental handlers unavailable: {e}", flush=True)
        return
    HANDLERS.update(dental_handlers.discover())

WORKER_NAME = os.environ.get("WORKER_NAME", f"py-{socket.gethostname()}"[:60])
RUNTIME = os.environ.get("WORKER_RUNTIME", "local-gpu")  # local-gpu | colab | kaggle | cloud


def compat_software() -> dict[str, Any]:
    """The `software` block sent at registration: provenance + the drift report (ADR-0024).

    Never raises and never gates: a missing or broken checkout just produces a smaller report, so a
    worker with no VLM-DENTAL still registers (and serves system.ping). `None`/empty values are
    omitted because the contract types are optional strings/arrays.
    """
    software: dict[str, Any] = {"python": sys.version.split()[0]}
    try:
        import vlm_compat

        # A broken native dependency upstream can abort the importing process; a child process turns
        # that into a report instead of killing the worker (ADR-0024).
        probe = getattr(vlm_compat, "probe_isolated", None) or vlm_compat.probe
        report = probe()
    except Exception as e:  # noqa: BLE001 - registration must survive a broken probe
        software["compatError"] = f"{type(e).__name__}: {e}"
        return software

    prov = report.get("provenance") or {}
    packages = report.get("packages") or {}
    jobs = report.get("jobs") or {}

    def put(key: str, value: Any) -> None:
        if value not in (None, "", [], {}):
            software[key] = value

    put("torch", packages.get("torch"))
    put("vlmDentalCommit", prov.get("commit"))
    put("vlmDentalBranch", prov.get("branch"))
    put("vlmDentalDirty", prov.get("dirty"))
    put("vlmDentalPath", report.get("path"))
    put("groundingWeights", report.get("groundingWeights"))
    # Reported even when empty: "probed and found none" is different from "never probed".
    software["cuda"] = "available" if report.get("cuda") else "unavailable"
    software["packages"] = packages
    software["packageErrors"] = report.get("packageErrors") or {}
    software["jobs"] = {
        job: {
            "available": row.get("available", False),
            "reason": row.get("reason"),
            "warnings": row.get("warnings") or [],
        }
        for job, row in jobs.items()
    }
    software["tools"] = report.get("tools") or []
    software["unknownToApp"] = report.get("unknownToApp") or []
    software["missingUpstream"] = report.get("missingUpstream") or []
    software["advertisedJobs"] = report.get("advertisedJobs") or []
    return software


def software_and_signature() -> tuple[dict[str, Any], str]:
    """Report plus a stable hash, so a changed upstream checkout triggers exactly one re-register."""
    software = compat_software()
    digest = hashlib.sha256(json.dumps(software, sort_keys=True, default=str).encode()).hexdigest()
    return software, digest


# --------------------------------------------------------------------------- main loop
def run_job(client: Client, job: dict[str, Any], cancelled: set[str]) -> None:
    abort = threading.Event()
    if job["id"] in cancelled:
        abort.set()
    ctx = JobContext(job=job, client=client, abort=abort)
    handler = HANDLERS.get(job["type"])
    short = job["id"][:8]
    if handler is None:
        client.post(f"/jobs/{job['id']}/fail",
                    {"error": {"code": "unsupported_job", "message": f"no handler for {job['type']}", "retryable": False}})
        return
    print(f"[worker] job {short} {job['type']} (attempt {job['attempt']})", flush=True)
    try:
        result = handler(ctx)
        client.post(f"/jobs/{job['id']}/complete", {"result": result, "artifactIds": ctx.artifact_ids})
        print(f"[worker] job {short} succeeded", flush=True)
    except ContractError as e:
        if e.lost_job:
            print(f"[worker] job {short} dropped: {e.code}", flush=True)
            return
        raise
    except Exception as e:  # noqa: BLE001 - every handler failure is reported to the server
        retryable = not isinstance(e, (NonRetryable, NotImplementedError))
        print(f"[worker] job {short} failed: {e}", flush=True)
        try:
            client.post(f"/jobs/{job['id']}/fail",
                        {"error": {"code": "handler_error", "message": str(e)[:500], "retryable": retryable}})
        except ContractError as fe:
            print(f"[worker] fail() also failed: {fe}", flush=True)


def main() -> int:
    base = os.environ.get("TRACEFORGE_URL", "http://localhost:3000")
    token = os.environ.get("TRACEFORGE_TOKEN")
    if not token:
        print("TRACEFORGE_TOKEN is required (pnpm worker:token --org <slug>)", file=sys.stderr)
        return 2
    max_jobs = int(os.environ["MAX_JOBS"]) if os.environ.get("MAX_JOBS") else None
    _enable_dental_handlers()

    client = Client(base, token)
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())

    software, software_sig = software_and_signature()

    # Register with backoff: the app may still be cold-starting or its DB briefly down.
    for attempt in range(20):
        try:
            reg = client.register(WORKER_NAME, RUNTIME, list(HANDLERS), software=software)
            break
        except ContractError as e:
            if e.status in (401, 426):
                print(f"[worker] fatal: {e}", file=sys.stderr)
                return 1
            wait = e.retry_after or min(15, 2 ** attempt)
            print(f"[worker] register failed ({e}); retrying in {wait:.0f}s", flush=True)
            if stop.wait(wait):
                return 0
        except httpx.HTTPError as e:
            print(f"[worker] register network error ({e}); retrying", flush=True)
            if stop.wait(min(15, 2 ** attempt)):
                return 0
    else:
        print("[worker] could not register", file=sys.stderr)
        return 1
    print(f"[worker] registered as {client.worker_id} advertising {list(HANDLERS)}", flush=True)

    cancelled: set[str] = set()
    busy = threading.Event()

    def heartbeat_loop() -> None:
        while not stop.wait(10):
            try:
                r = client.post("/heartbeat", {"workerId": client.worker_id, "status": "busy" if busy.is_set() else "idle"})
                cancelled.update(r.get("cancelJobIds", []))
            except (ContractError, httpx.HTTPError) as e:
                print(f"[worker] heartbeat failed: {e}", flush=True)

    threading.Thread(target=heartbeat_loop, daemon=True).start()

    processed = 0
    next_probe = time.monotonic() + COMPAT_REPROBE_S if COMPAT_REPROBE_S > 0 else None
    while not stop.is_set() and (max_jobs is None or processed < max_jobs):
        if next_probe is not None and time.monotonic() >= next_probe:
            # ADR-0024: re-probe so a `git pull` in VLM-DENTAL shows up without restarting the
            # worker. Handlers are fixed at start-up (they are wired imports), so a newly available
            # job needs a restart; the report is what the app displays meanwhile.
            next_probe = time.monotonic() + COMPAT_REPROBE_S
            try:
                fresh, fresh_sig = software_and_signature()
                if fresh_sig != software_sig:
                    client.register(WORKER_NAME, RUNTIME, list(HANDLERS), software=fresh)
                    software_sig = fresh_sig
                    print("[worker] upstream report changed; re-registered with fresh provenance", flush=True)
            except (ContractError, httpx.HTTPError) as e:
                print(f"[worker] re-probe registration failed: {e}", flush=True)
        try:
            jobs = client.post("/jobs/claim", {"workerId": client.worker_id, "accepts": list(HANDLERS), "max": 1, "waitMs": 10000})["jobs"]
        except ContractError as e:
            if e.status == 401:
                print(f"[worker] fatal: {e}", file=sys.stderr)
                return 1
            wait = e.retry_after or 3
            print(f"[worker] claim failed ({e}); retrying in {wait:.0f}s", flush=True)
            stop.wait(wait)
            continue
        except httpx.HTTPError as e:
            print(f"[worker] network error ({e}); retrying", flush=True)
            stop.wait(3)
            continue
        for job in jobs:
            busy.set()
            try:
                run_job(client, job, cancelled)
            finally:
                busy.clear()
            processed += 1
    print(f"[worker] done, processed {processed} job(s)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
