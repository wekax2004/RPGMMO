"""
Measures committed assets against what the client actually loads.

The figures reported earlier for client/assets -- 82 files, 41.4 MB, 24.8 MB
unused -- were wrong, and wrong because the counting command did not recurse.
Get-ChildItem -File lists one directory; the 67 files under rpg-import/ were
simply not in that count. The real figures are 149 files and 97.7 MB committed,
of which 81.1 MB -- 83% -- is loaded by nothing.

That is worth more than a corrected number. client/assets/rpg-import/ alone is
56.3 MB, tracked and committed, and referenced by no line of client or server
code. It is the single largest thing in the repository and it is dead weight.

So this tool counts from git rather than the filesystem, and reports committed
versus present separately. If a tracked file is ever missing from the working
tree it says so -- a clean checkout has everything HEAD tracks -- but as of this
writing the two counts agree, and the discrepancy I first reported was a
counting error rather than a broken tree.

Run:  python tools/audit_unreferenced_assets.py [--list]

Reports rather than deletes. These are generated art, and for some of them the
working tree is the only copy.
"""
import argparse
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = "client/assets"
CLIENT_SOURCES = [
    "client/js/renderer.js", "client/js/engine.js", "client/js/ui.js",
    "client/test_client.html",
]


def git(*args):
    return subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout


def tracked_files():
    return [f for f in git("ls-files", ASSETS).split("\n") if f.strip()]


def committed_bytes(files):
    total = 0
    for f in files:
        try:
            total += int(git("cat-file", "-s", "HEAD:" + f).strip())
        except subprocess.CalledProcessError:
            pass
    return total


def referenced_names():
    """Every image filename any client source names."""
    names = set()
    for rel in CLIENT_SOURCES:
        p = os.path.join(ROOT, rel)
        if not os.path.exists(p):
            continue
        src = open(p, encoding="utf-8", errors="replace").read()
        for m in re.finditer(r'["\']([\w\-. ]+\.(?:png|jpg|jpeg|gif|webp))["\']', src):
            names.add(m.group(1))
    return names


def classify(fname):
    base = fname.lower()
    if "rpg-import" in base:
        return "rpg-import (third-party import, loaded by nothing)"
    if "_magenta_" in base:
        return "magenta source (the pipeline's input)"
    if re.search(r"_\d{10,}\.", base):
        return "timestamped intermediate or duplicate"
    return "duplicate or superseded"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="print every file, not just a summary")
    args = ap.parse_args()

    tracked = tracked_files()
    if not tracked:
        print("no tracked files under " + ASSETS, file=sys.stderr)
        return 2

    present = [f for f in tracked if os.path.exists(os.path.join(ROOT, f))]
    missing = [f for f in tracked if f not in present]
    referenced = referenced_names()

    used = [f for f in tracked if os.path.basename(f) in referenced]
    unused = [f for f in tracked if os.path.basename(f) not in referenced]

    tbytes = committed_bytes(tracked)
    pbytes = sum(os.path.getsize(os.path.join(ROOT, f)) for f in present)

    print(ASSETS)
    print("  committed : {:4d} files, {:6.1f} MB".format(len(tracked), tbytes / 1048576))
    print("  on disk   : {:4d} files, {:6.1f} MB".format(len(present), pbytes / 1048576))
    print("  loaded    : {:4d} files, {:6.1f} MB".format(len(used), committed_bytes(used) / 1048576))
    print("  unused    : {:4d} files, {:6.1f} MB  ({}% of what is committed)".format(
        len(unused), committed_bytes(unused) / 1048576, round(committed_bytes(unused) / tbytes * 100)))
    print()

    if missing:
        print("  {} tracked file(s) are MISSING from this working tree:".format(len(missing)))
        for f in missing[:5]:
            print("    " + f)
        if len(missing) > 5:
            print("    ... and {} more".format(len(missing) - 5))
        print("  A clean checkout has everything HEAD tracks, so this tree has been")
        print("  selectively deleted or partially synchronised. It is not a clone.")
        print()

    groups = {}
    for f in unused:
        groups.setdefault(classify(f), []).append(f)

    for reason in sorted(groups):
        items = groups[reason]
        print("  " + reason)
        print("    {} files, {:.1f} MB".format(len(items), committed_bytes(items) / 1048576))
        if args.list:
            for s, f in sorted(((committed_bytes([f]), f) for f in items), reverse=True):
                print("      {:<52} {:8.0f} KB".format(f, s / 1024))

    print()
    print("  None of the unused files is loaded. None is provably disposable from a")
    print("  listing either: these are generated art, and for some the working tree")
    print("  is the only copy. This reports rather than deletes, because removing")
    print("  tens of megabytes of assets is the owner's decision, not a cleanup.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
