"""The WP3 handlers' recorded wire output, validated against `docs/worker-openapi.json` (WP3).

`fixtures/worker/wp3-recorded-events.json` is captured from the reference worker's real
`JobContext.emit`/`/complete` payloads by `examples/python-worker/record_wp3_events.py`. This test is
the Python half of the acceptance check; `tests/m8-worker-recorded-events.test.ts` validates the same
bytes with the Zod contract, so a drift between the two generators is caught on both sides.

Negative controls are part of the test: an event with a type outside the enum, and a result carrying
a field the contract forbids (the `sha256` the handler used to leak) must both be rejected. A
validator that accepts everything would pass the positive cases and fail these.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "fixtures" / "worker" / "wp3-recorded-events.json"
OPENAPI = ROOT / "docs" / "worker-openapi.json"

RESULT_SCHEMA = {
    "eval.run": "EvalRunResult",
    "al.score": "AlScoreResult",
    "trace.render_artifacts": "TraceRenderArtifactsResult",
}


@pytest.fixture(scope="module")
def document() -> dict[str, Any]:
    return json.loads(OPENAPI.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def fixture() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _validator(document: dict[str, Any], name: str) -> Draft202012Validator:
    """A validator for one `components/schemas` entry, with refs resolving inside the OpenAPI doc."""
    schema = {"$ref": f"#/components/schemas/{name}", "components": document["components"]}
    return Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)


def _validate(document: dict[str, Any], name: str, value: Any) -> None:
    _validator(document, name).validate(value)


def test_the_fixture_covers_the_three_wp3_handlers(fixture: dict[str, Any]):
    assert {s["jobType"] for s in fixture["streams"]} == set(RESULT_SCHEMA)


@pytest.mark.parametrize("job_type", sorted(RESULT_SCHEMA))
def test_recorded_event_stream_matches_JobEventsRequest(document, fixture, job_type):
    stream = next(s for s in fixture["streams"] if s["jobType"] == job_type)
    assert stream["events"], f"{job_type} recorded no events"
    _validate(document, "JobEventsRequest", {"events": stream["events"]})


@pytest.mark.parametrize("job_type", sorted(RESULT_SCHEMA))
def test_recorded_result_matches_its_contract(document, fixture, job_type):
    stream = next(s for s in fixture["streams"] if s["jobType"] == job_type)
    _validate(document, RESULT_SCHEMA[job_type], stream["result"])


def test_eval_partial_events_are_real_ingest_cases(document, fixture):
    """`partial` carries the case that is posted to `/ingest/eval-run`, so check the nested schema."""
    case_schema = {
        "$ref": "#/components/schemas/IngestEvalRunRequest/properties/cases/items",
        "components": document["components"],
    }
    validator = Draft202012Validator(case_schema, format_checker=Draft202012Validator.FORMAT_CHECKER)
    stream = next(s for s in fixture["streams"] if s["jobType"] == "eval.run")
    partials = [e["data"] for e in stream["events"] if e["type"] == "partial"]
    assert len(partials) == 2
    for case in partials:
        validator.validate(case)


def test_negative_control_an_event_with_a_wrong_type_is_rejected(document, fixture):
    stream = next(s for s in fixture["streams"] if s["jobType"] == "al.score")
    bad = copy.deepcopy(stream["events"])
    bad[0]["type"] = "definitely-not-an-event-type"
    with pytest.raises(ValidationError):
        _validate(document, "JobEventsRequest", {"events": bad})


def test_negative_control_a_result_with_an_extra_field_is_rejected(document, fixture):
    """The bug this fixture found: the render handler returned the dedupe key `sha256` to /complete."""
    stream = next(s for s in fixture["streams"] if s["jobType"] == "trace.render_artifacts")
    bad = copy.deepcopy(stream["result"])
    bad["artifacts"][0]["sha256"] = "0" * 64
    with pytest.raises(ValidationError):
        _validate(document, "TraceRenderArtifactsResult", bad)
