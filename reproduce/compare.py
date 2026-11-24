"""Outcome changes per operation and profile between two sweeps (before and after a fix).

Usage: python3 -I compare.py <before.jsonl> <after.jsonl>
A degradation is any worse outcome: a lower rank, a row that disappears, or a newly invalid input.
"""
import json
import sys
from collections import Counter

RANK = {"match": 0, "encoding": 1, "unsure": 2, "wrong": 3, "encode-failure": 4, "run-failure": 4}


def outcomes(path: str) -> dict:
    rows = (json.loads(line) for line in open(path))
    return {
        (r["app"], r["op"], r["profile"]): (r["result"], r.get("exact"))
        for r in rows
        if r["stage"] == "op" and "profile" in r
    }


def worse(old: str, new: str | None) -> bool:
    if new is None or (old in RANK and new not in RANK):
        return True
    return old in RANK and RANK[new] > RANK[old]


def main() -> None:
    before, after = outcomes(sys.argv[1]), outcomes(sys.argv[2])
    attempted = [k for k in before if before[k][0] in RANK]
    print(f"pairs {len(before)}, attempted {len(attempted)}, no valid input {len(before) - len(attempted)}, "
          f"same keys {set(before) == set(after)}")
    for profile in ("plain", "required", "reserved"):
        keys = [k for k in attempted if k[2] == profile]
        moved = Counter((before[k][0], after.get(k, ("absent",))[0]) for k in keys)
        exact = Counter((before[k][1], after.get(k, (None, None))[1]) for k in keys)
        print(f"== {profile} ({len(keys)} attempted)")
        for (old, new), n in sorted(moved.items(), key=lambda kv: -kv[1]):
            print(f"  {old:15} -> {new:15} {n}")
        print("  exact query (before -> after): " + ", ".join(f"{o}->{n}: {c}" for (o, n), c in sorted(exact.items(), key=str)))
    degraded = [k for k in attempted if worse(before[k][0], after.get(k, (None,))[0])]
    exact_lost = [k for k in attempted if before[k][1] is True and after.get(k, (None, None))[1] is not True]
    print(f"\ndegradations: {len(degraded)} {degraded[:5]}")
    print(f"exact query lost: {len(exact_lost)} {exact_lost[:5]}")


if __name__ == "__main__":
    main()
