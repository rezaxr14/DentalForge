"""WP3 acceptance: the handlers' real output, validated against the published contract.

The unit suites prove the handlers *do* the right thing; this one proves what they emit is what the
contract says. It reads the recording produced by `examples/python-worker/acceptance_fixtures.py`
(the same file the vitest suite parses with Zod) and validates every piece against
`docs/worker-openapi.json` with `jsonschema`:

  * each job's event stream as a `JobEventsRequest` body — the exact shape the worker POSTs;
  * each job's result against its `*Result` component;
  * each `/ingest/eval-run` body against `IngestEvalRunRequest`.

A negative control runs beside every check: a bogus event type and a result missing a required field
must both be rejected. Without it, a schema that degraded to `{}` would still "pass".

The recording is also compared with a fresh run, so the committed file cannot silently go stale.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import jsonschema
import pytest
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "examples" / "python-worker"))

from acceptance_fixtures import FIXTURE_PATH, record  # noqa: E402

DOC_PATH = ROOT / "docs" / "worker-openapi.json"

RESULT_SCHEMAS = {
    "eval.run": "EvalRunResult",
    "al.score": "AlScoreResult",
    "trace.render_artifacts": "TraceRenderArtifactsResult",
}


@pytest.fixture(scope="module")
def doc() -> dict[str, Any]:
    return json.loads(DOC_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def fixture() -> dict[str, Any]:
    if not FIXTURE_PATH.is_file():
        pytest.fail(
            f"missing {FIXTURE_PATH.relative_to(ROOT)}; run "
            "`python examples/python-worker/record_acceptance.py --write`",
            pytrace=False,
        )
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def validator(doc: dict[str, Any], name: str) -> jsonschema.Draft202012Validator:
    """A validator for one component schema, resolving `#/components/schemas/...` inside the document."""
    registry = Registry().with_resource(
        "urn:worker-contract",
        Resource.from_contents(doc, default_specification=DRAFT202012),
    )
    return jsonschema.Draft202012Validator(
        {"$ref": f"urn:worker-contract#/components/schemas/{name}"},
        registry=registry,
    )


def test_the_recording_covers_all_three_jobs_and_the_event_kinds_that_matter(fixture: dict[str, Any]):
    jobs = {job["jobType"]: job for job in fixture["jobs"]}
    assert set(jobs) == {"eval.run", "al.score", "trace.render_artifacts"}
    types = {event["type"] for job in jobs.values() for event in job["events"]}
    # `partial` is how eval.run streams a case, `log` how it reports a skipped/failed one. A recording
    # with only `progress` would validate while proving nothing about the interesting paths.
    assert {"progress", "partial", "log"} <= types, types
    assert fixture["ingest"], "eval.run recorded no /ingest/eval-run body"


def test_every_recorded_event_stream_is_a_valid_job_events_request(doc, fixture):
    v = validator(doc, "JobEventsRequest")
    for job in fixture["jobs"]:
        v.validate({"events": job["events"]})


def test_every_recorded_result_matches_its_contract_schema(doc, fixture):
    for job in fixture["jobs"]:
        name = RESULT_SCHEMAS[job["jobType"]]
        validator(doc, name).validate(job["result"])


def test_every_recorded_ingest_body_is_a_valid_eval_run_request(doc, fixture):
    v = validator(doc, "IngestEvalRunRequest")
    for item in fixture["ingest"]:
        assert item["path"] == "/ingest/eval-run"
        v.validate(item["body"])


def test_the_recording_is_not_stale(fixture: dict[str, Any]):
    """A handler that changes shape must fail here, not at runtime on a worker."""
    assert record() == fixture, (
        "the committed recording no longer matches the handlers; review the diff from "
        "`python examples/python-worker/record_acceptance.py --check`"
    )


def test_render_dedupe_is_visible_in_the_recording(fixture: dict[str, Any]):
    """Two identical tool outputs must still produce two positions pointing at one artifact."""
    job = next(j for j in fixture["jobs"] if j["jobType"] == "trace.render_artifacts")
    artifacts = job["result"]["artifacts"]
    assert [(a["turnIdx"], a["callIdx"]) for a in artifacts] == [(0, 0), (0, 1)]
    assert len({a["artifactId"] for a in artifacts}) == 1, "the fixture stopped exercising sha256 dedupe"


# ------------------------------------------------------------------ negative controls
def test_negative_control_a_bogus_event_type_is_rejected(doc):
    bad = {"events": [{"seq": 1, "type": "definitely_not_a_job_event", "data": {}}]}
    with pytest.raises(jsonschema.ValidationError):
        validator(doc, "JobEventsRequest").validate(bad)


def test_negative_control_a_result_missing_a_required_field_is_rejected(doc):
    bad = {"runId": "44444444-4444-4444-8444-444444444444", "n": 1}  # no `summary`
    with pytest.raises(jsonschema.ValidationError):
        validator(doc, "EvalRunResult").validate(bad)


def test_negative_control_an_eval_case_with_a_missing_field_is_rejected(doc):
    case = record()["ingest"][0]["body"]
    del case["cases"][0]["fdi_f1"]
    with pytest.raises(jsonschema.ValidationError):
        validator(doc, "IngestEvalRunRequest").validate(case)
