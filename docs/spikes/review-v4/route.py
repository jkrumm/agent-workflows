#!/usr/bin/env python3
"""Deterministic review router (review v4 spike): the change sets the tier, not the author.

  route.py <repo> <base> <head> <review_md> [--min light|standard|deep]

Prints JSON: tier (none|light|standard|deep), seat (model, effort), the rule that decided, and the counts.
A caller may raise the tier with --min, never lower it.
"""
import fnmatch, json, re, subprocess, sys

TIERS = ["none", "light", "standard", "deep"]
SEATS = {
    "none": None,
    "light": {"model": "sonnet", "effort": "low"},
    "standard": {"model": "sonnet", "effort": "medium"},
    "deep": {"model": "sonnet", "effort": "high", "vote": 3},
}
DEEP_CODE_LINES = 800
DEEP_PACKAGES = 3
LIGHT_CODE_LINES = 40
LIGHT_FILES = 3
DOC = re.compile(r"(\.md$|^docs/)")
TEST = re.compile(r"(^|/)(test|tests|__tests__)/|\.test\.[a-z]+$|\.spec\.[a-z]+$")


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True).stdout


def frontmatter(path):
    text = open(path).read()
    m = re.match(r"---\n(.*?)\n---", text, re.S)
    out = {}
    for key, body in re.findall(r"^(\w+):\s*\[(.*?)\]", m.group(1) if m else "", re.S | re.M):
        out[key] = [g.strip().strip('"') for g in body.replace("\n", " ").split(",") if g.strip()]
    return out


def match(path, globs):
    for g in globs:
        if fnmatch.fnmatch(path, g) or (g.startswith("**/") and fnmatch.fnmatch(path, g[3:])):
            return g
    return None


def route(repo, base, head, review_md, minimum="none"):
    cfg = frontmatter(review_md)
    files = []
    for line in git(repo, "diff", "--numstat", "-M", f"{base}..{head}").splitlines():
        add, rem, path = line.split("\t", 2)
        path = path.split(" => ")[-1].rstrip("}") if "=>" in path else path
        files.append((path, 0 if add == "-" else int(add), 0 if rem == "-" else int(rem)))
    counted = [f for f in files if f[1] + f[2] > 0]
    code = [f for f in counted if not DOC.search(f[0])]
    code_lines = sum(a + r for _, a, r in code)
    prod_lines = sum(a + r for p, a, r in code if not TEST.search(p))
    packages = {f[0].split("/")[1] for f in code if f[0].startswith("packages/")}
    facts = {"files": len(counted), "codeFiles": len(code), "codeLines": code_lines, "prodLines": prod_lines, "packages": sorted(packages)}

    def out(tier, rule):
        tier = max(tier, minimum, key=TIERS.index)
        return {"tier": tier, "seat": SEATS[tier], "rule": rule, **facts}

    if not counted or not git(repo, "diff", "-w", "--ignore-blank-lines", f"{base}..{head}").strip():
        return out("none", "no content change (renames or whitespace only)")
    if all(match(f[0], cfg.get("none", [])) for f in counted):
        return out("none", "every file matches REVIEW.md none")
    if not code:
        return out("light", "docs only")
    if all(TEST.search(f[0]) for f in code):
        return out("light", "tests only")
    hit = [f[0] for f in code if not TEST.search(f[0]) and match(f[0], cfg.get("sensitive", []))]
    if hit:
        return out("deep", f"sensitive path: {hit[0]}" + (f" (+{len(hit) - 1})" if len(hit) > 1 else ""))
    if prod_lines > DEEP_CODE_LINES:
        return out("deep", f"{prod_lines} changed non-test code lines > {DEEP_CODE_LINES}")
    if len(packages) > DEEP_PACKAGES:
        return out("deep", f"{len(packages)} packages > {DEEP_PACKAGES}: a cross-package change")
    if any(f[0].endswith("package.json") for f in code):
        return out("standard", "a manifest changed (dependencies)")
    if code_lines <= LIGHT_CODE_LINES and len(code) <= LIGHT_FILES:
        return out("light", f"small: {code_lines} code lines in {len(code)} files")
    return out("standard", "default")


if __name__ == "__main__":
    args = sys.argv[1:]
    minimum = "none"
    if "--min" in args:
        i = args.index("--min")
        minimum = args[i + 1]
        del args[i : i + 2]
    print(json.dumps(route(*args, minimum=minimum)))
