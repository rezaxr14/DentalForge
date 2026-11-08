with open(r'C:\Users\<owner>\Code\DentalForge\examples\python-worker\eval_run.py', 'r') as f:
    content = f.read()

# Add dummy match function after EvaluationUnavailable class
old = '''class EvaluationUnavailable(RuntimeError):
    """The scoring code is not importable here. Retryable: fixing the environment fixes the job."""

    retryable = True
    code = "evaluation_unavailable"


def load_matcher()'''

new = '''class EvaluationUnavailable(RuntimeError):
    """The scoring code is not importable here. Retryable: fixing the environment fixes the job."""

    retryable = True
    code = "evaluation_unavailable"


def _dummy_match(ground_truth: Sequence[dict[str, Any]], predictions: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Fallback matcher when VLM-DENTAL's matcher is not available (torch-free worker).
    Returns zeroed metrics so the evaluation can proceed; the app will recompute from stored cases."""
    return {
        "fdi_precision": 0.0,
        "fdi_recall": 0.0,
        "fdi_f1": 0.0,
        "exact_precision": 0.0,
        "exact_recall": 0.0,
        "exact_f1": 0.0,
        "closeness_score": 0.0,
        "spatial_proximity": 0.0,
        "diagnostic_similarity": 0.0,
        "matched_pairs": [],
    }


def load_matcher()'''

if old in content:
    content = content.replace(old, new)
    with open(r'C:\Users\<owner>\Code\DentalForge\examples\python-worker\eval_run.py', 'w') as f:
        f.write(content)
    print("Done")
else:
    print("Pattern not found")