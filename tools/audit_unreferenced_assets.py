#!/usr/bin/env python3
"""
tools/audit_unreferenced_assets.py

Lists committed files in client/assets that nothing loads, split by why.

Most of client/assets is generated art, and a lot of it is intermediates that
were committed by accident: the magenta-keyed sources the pipeline consumes, the
timestamped duplicates of the same sprite, and a loose warrior.jpg sitting in
client/ rather than in client/assets. None of it is loaded, because the client
reads exactly one name per sprite from SPRITE_FILES.

This reports rather than deletes. Deleting 15 MB of art is a decision, and the
provenance of some of it is not recorded anywhere -- these files are the only
copy. The report is the safe half: it tells you the size of the problem and which
files are provably unused, so the removal can be chosen rather than stumbled into.

Run:  python tools/audit_unreferenced_assets.py [--list]
"""
import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "client", "assets")
RENDERER = os.path.join(ROOT, "client", "js", "renderer.js")


def referenced_names():
    """Every literal filename mentioned in the client, not just SPRITE_FILES."""
    names = set()
    for rel in ("client/js/renderer.js", "client/js/engine.js", "client/js/ui.js",
                "client/test_client.html"):
        p = os.path.join(ROOT, rel)
        if not os.path.exists(p):
            continue
        src = open(p, encoding="utf-8", errors="replace").read()
        for m in re.finditer(r'["\']([\w\-. ]+\.(?:png|jpg|jpeg|gif|webp))["\']', src):
            names.add(m.group(1))
    return names


def classify(fname):
    """Why is this on disk but not loaded? Best guess, from the name alone."""
    base = fname.lower()
    if "_magenta_" in base:
        return "magenta source (the pipeline's input)"
    if re.search(r"_\d{10,}\.", base):
        return "timestamped intermediate or duplicate"
    if base.endswith(".py") or base.endswith(".psd"):
        return "tool or source-file artefact"
    return "duplicate or superseded"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="print every file, not just a summary")
    args = ap.parse_args()

    if not os.path.isdir(ASSETS):
        print(f"no asset directory at {ASSETS}", file=sys.stderr)
        return 2

    referenced = referenced_names()
    files = sorted(f for f in os.listdir(ASSETS) if os.path.isfile(os.path.join(ASSETS, f)))

    groups = {}
    unused_bytes = 0
    for f in files:
        if f in referenced:
            continue
        reason = classify(f)
        groups.setdefault(reason, []).append((f, os.path.getsize(os.path.join(ASSETS, f))))
        unused_bytes += os.path.getsize(os.path.join(ASSETS, f))

    used_bytes = sum(os.path.getsize(os.path.join(ASSETS, f))
                     for f in files if f in referenced)
    total = used_bytes + unused_bytes

    print(f"client/assets: {len(files)} files, {total / 1024 / 1024:.1f} MB")
    print(f"  referenced by the client : {len(files) - sum(len(v) for v in groups.values())} files, "
          f"{used_bytes / 1024 / 1024:.1f} MB")
    print(f"  referenced by nothing    : {sum(len(v) for v in groups.values())} files, "
          f"{unused_bytes / 1024 / 1024:.1f} MB\n")

    if not groups:
        print("  nothing unused")
        return 0

    for reason in sorted(groups):
        items = groups[reason]
        size = sum(s for _, s in items)
        print(f"  {reason}")
        print(f"    {len(items)} files, {size / 1024 / 1024:.1f} MB")
        if args.list:
            for f, s in sorted(items, key=lambda x: -x[1]):
                print(f"      {f:<44} {s / 1024:8.0f} KB")

    print("\n  Nothing here is loaded. None of it is provably disposable from a file")
    print("  listing though: these are generated art, and for some of them this")
    print("  directory is the only copy. This reports rather than deleting so the")
    print("  decision stays yours.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
