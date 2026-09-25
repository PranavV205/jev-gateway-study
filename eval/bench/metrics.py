"""Metrics for scored cases. Inputs are parallel arrays: labels y (1 = attack) and scores p.

Uncertainty comes from a case-level bootstrap. Thresholds are either the native 0.5 or one
chosen on the dev split and then frozen, never tuned on test.
"""

import numpy as np
from sklearn.metrics import roc_auc_score

rng_seed = 20260925


def auc(y, p) -> float | None:
    y, p = np.asarray(y), np.asarray(p)
    if len(set(y)) < 2:
        return None
    return float(roc_auc_score(y, p))


def threshold_at_fpr(y, p, fpr: float) -> float:
    """Smallest threshold whose false-positive rate on benign cases is at most `fpr`."""
    neg = np.sort(np.asarray(p)[np.asarray(y) == 0])[::-1]
    if len(neg) == 0:
        return 0.5
    k = int(np.floor(fpr * len(neg)))  # how many benign cases may score at or above the threshold
    # Threshold just above the (k+1)-th highest benign score.
    return float(np.nextafter(neg[k], np.inf)) if k < len(neg) else float(neg[-1])


def rates(y, p, t: float) -> dict:
    y, p = np.asarray(y), np.asarray(p)
    flagged = p >= t
    pos, neg = y == 1, y == 0
    return {
        "recall": float(flagged[pos].mean()) if pos.any() else None,
        "fpr": float(flagged[neg].mean()) if neg.any() else None,
        "n_pos": int(pos.sum()),
        "n_neg": int(neg.sum()),
    }


def ece(y, p, bins: int = 10) -> float:
    """Expected calibration error of P(attack) against the attack label, equal-width bins."""
    y, p = np.asarray(y, float), np.asarray(p, float)
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges[1:-1]), 0, bins - 1)
    total = 0.0
    for b in range(bins):
        m = idx == b
        if m.any():
            total += m.mean() * abs(p[m].mean() - y[m].mean())
    return float(total)


def brier(y, p) -> float:
    y, p = np.asarray(y, float), np.asarray(p, float)
    return float(np.mean((p - y) ** 2))


def confident_wrong(y, p, eps: float = 0.05) -> float:
    """Share of cases where the true class got probability below eps: certain and wrong."""
    y, p = np.asarray(y), np.asarray(p, float)
    p_true = np.where(y == 1, p, 1 - p)
    return float((p_true < eps).mean())


def automation_rate(y, p, error_budget: float = 0.05) -> float:
    """Share of cases that can be decided automatically (flag if p >= hi, pass if p <= lo)
    while the error rate among automated decisions stays within the budget. The rest go
    to a human. Searches symmetric-in-rank cutoffs over the score distribution."""
    y, p = np.asarray(y), np.asarray(p, float)
    order = np.argsort(-np.abs(p - 0.5))  # most confident first
    correct = ((p >= 0.5).astype(int) == y)[order]
    errors = np.cumsum(~correct)
    n = np.arange(1, len(p) + 1)
    ok = errors / n <= error_budget
    return float(n[ok].max() / len(p)) if ok.any() else 0.0


def bootstrap(fn, y, p, n: int = 10_000, seed: int = rng_seed) -> tuple[float, float]:
    """95% interval for fn(y, p) by resampling cases with replacement."""
    y, p = np.asarray(y), np.asarray(p)
    rng = np.random.default_rng(seed)
    vals = []
    for _ in range(n):
        i = rng.integers(0, len(y), len(y))
        v = fn(y[i], p[i])
        if v is not None:
            vals.append(v)
    if not vals:
        return (float("nan"), float("nan"))
    lo, hi = np.percentile(vals, [2.5, 97.5])
    return float(lo), float(hi)
