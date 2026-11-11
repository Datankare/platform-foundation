#!/usr/bin/env python3
"""scripts/semgrep-rules.py — the Semgrep rules CI blocks on, from a pinned commit (TASK-204, N-9)

    python3 scripts/semgrep-rules.py <semgrep-rules checkout> <out.yml>

The registry packs (`--config p/owasp-top-ten --config p/typescript`) were downloaded on every
run, so the rules that block a merge changed without a commit even with the binary pinned (audit
H-12). The rules now come from github.com/semgrep/semgrep-rules at the commit pinned in
.semgrep/rules.json — never redistributed here (they carry their own licence) — and this script
selects, deterministically, the ones that block:

  - the languages and areas this repository has (.semgrep/rules.json "dirs"): JavaScript,
    TypeScript, GitHub Actions workflows, Dockerfiles, secrets;
  - security rules (`metadata.category: security`) that report a vulnerability, not an audit
    point (`subcategory` without "audit") at confidence MEDIUM or HIGH.

It writes them as one config, sorted by id, and prints how many; fewer than "min_rules" (a
checkout that is not the pinned tree, or a moved layout) exits 1 rather than scanning with nothing.
Raising the pin is a commit: change .semgrep/rules.json, run the scan, triage what is new.
"""
import json
import os
import sys

import yaml  # PyYAML, pinned in the workflow


def selected(root, dirs):
    rules = {}
    for d in dirs:
        base = os.path.join(root, d)
        if not os.path.isdir(base):
            raise SystemExit(f"semgrep-rules: {d} is not in the checkout")
        for dirpath, _, files in os.walk(base):
            for name in sorted(files):
                if not name.endswith((".yaml", ".yml")) or ".test." in name or ".fixed." in name:
                    continue
                try:
                    with open(os.path.join(dirpath, name), encoding="utf-8") as fh:
                        doc = yaml.safe_load(fh)
                except yaml.YAMLError:
                    continue
                for rule in (doc or {}).get("rules") or []:
                    md = rule.get("metadata") or {}
                    sub = md.get("subcategory") or []
                    sub = [sub] if isinstance(sub, str) else sub
                    if md.get("category") != "security" or "audit" in sub:
                        continue
                    if str(md.get("confidence", "")).upper() not in ("MEDIUM", "HIGH"):
                        continue
                    rules[rule["id"]] = rule
    return [rules[k] for k in sorted(rules)]


def main(argv):
    if len(argv) != 3:
        raise SystemExit("usage: semgrep-rules.py <semgrep-rules checkout> <out.yml>")
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "..", ".semgrep", "rules.json"), encoding="utf-8") as fh:
        spec = json.load(fh)
    rules = selected(argv[1], spec["dirs"])
    if len(rules) < spec["min_rules"]:
        raise SystemExit(f"semgrep-rules: only {len(rules)} rules selected (at least {spec['min_rules']})")
    with open(argv[2], "w", encoding="utf-8") as fh:
        yaml.safe_dump({"rules": rules}, fh, sort_keys=False)
    print(f"{len(rules)} blocking rules from semgrep-rules@{spec['commit'][:12]}")


if __name__ == "__main__":
    main(sys.argv)
