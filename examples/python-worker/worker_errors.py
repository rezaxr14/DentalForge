"""Exception types shared by worker.py and its handler modules.

Kept in their own module on purpose: `python worker.py` runs the file as `__main__`, so a handler
module doing `from worker import NonRetryable` would load a SECOND copy of worker.py, and its
`NonRetryable` would not be the class `run_job` checks (non-retryable failures would silently be
reported as retryable).
"""
from __future__ import annotations


class ContractError(Exception):
    def __init__(self, status: int, code: str, message: str, retry_after: float | None = None):
        super().__init__(message)
        self.status, self.code, self.retry_after = status, code, retry_after

    @property
    def lost_job(self) -> bool:
        return self.status == 409


class NonRetryable(Exception):
    """Bad input: failing again will not help (reported as retryable=false)."""
