with open(r'C:\Users\rezax\home\Code\DentalForge\examples\python-worker\eval_run.py', 'r') as f:
    content = f.read()

old = '        matcher = match or load_matcher()'

new = '''        matcher = match or load_matcher()
        if matcher is None and spec.backend != "openai_compat":
            raise EvaluationUnavailable("VLM-DENTAL scoring is not importable (torch required for non-openai_compat models)")
        if matcher is None:
            matcher = _dummy_match'''

if old in content:
    content = content.replace(old, new)
    with open(r'C:\Users\rezax\home\Code\DentalForge\examples\python-worker\eval_run.py', 'w') as f:
        f.write(content)
    print("Done")
else:
    print("Pattern not found")