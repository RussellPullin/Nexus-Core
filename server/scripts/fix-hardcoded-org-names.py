#!/usr/bin/env python3
"""
Audit and fix hardcoded vendor branding in document-library templates.

Scans server/templates/library/<slug>/template.docx (and template.docx.prebrand)
for Spring 2 Health / Pristine Lifestyle Solutions / hardcoded ABNs / stray mustache
tags, replaces with org-fillable tokens, and writes a machine-readable audit report.

Usage (from server/):
  python3 scripts/fix-hardcoded-org-names.py --audit          # audit only
  python3 scripts/fix-hardcoded-org-names.py --fix            # audit + fix templates
  python3 scripts/fix-hardcoded-org-names.py --fix --slug X   # single slug
"""
from __future__ import annotations

import argparse
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SERVER_ROOT = SCRIPT_DIR.parent
LIBRARY_DIR = SERVER_ROOT / "templates" / "library"
AUDIT_PATH = SCRIPT_DIR / "diagnostics" / "hardcoded-org-audit.json"

XML_PART_RE = re.compile(
    r"word/(document\.xml|header\d+\.xml|footer\d+\.xml|footnotes\.xml|endnotes\.xml)$"
)
W_T_RE = re.compile(r"<w:t[^>]*>([^<]*)</w:t>")

# [pattern_id, regex, replacement, context_hint]
# Order matters — longer / more specific patterns first.
REPLACEMENT_RULES: list[tuple[str, re.Pattern[str], str, str]] = [
    (
        "spring_2_health_pty",
        re.compile(r"Spring\s*2\s*Health\s+Pty\s+Ltd", re.I),
        "{org.legal_name}",
        "legal entity in contracts",
    ),
    (
        "spring_2_health",
        re.compile(r"Spring\s*2\s*Health", re.I),
        "{org.name}",
        "trading name",
    ),
    (
        "spring2health",
        re.compile(r"spring2health", re.I),
        "{org.name}",
        "trading name",
    ),
    (
        "spring2",
        re.compile(r"\bSpring2\b", re.I),
        "{org.name}",
        "trading name",
    ),
    (
        "s2h",
        re.compile(r"\bS2H\b"),
        "{org.name}",
        "trading name",
    ),
    (
        "pristine_lifestyle_solutions_pty",
        re.compile(r"Pristine\s+Lifestyle\s+Solutions\s+Pty\s+Ltd", re.I),
        "{org.legal_name}",
        "legal entity",
    ),
    (
        "pristine_lifestyle_solutions",
        re.compile(r"Pristine\s+Lifestyle\s+Solutions", re.I),
        "{org.legal_name}",
        "legal entity",
    ),
    (
        "pristine_lifestyle",
        re.compile(r"Pristine\s+Lifestyle(?!\s+Solutions)", re.I),
        "{org.name}",
        "trading name",
    ),
    (
        "abn_label_spring",
        re.compile(r"ABN\s+15\s*639\s*893\s*477", re.I),
        "ABN {org.abn}",
        "header/footer ABN",
    ),
    (
        "abn_label_s2h",
        re.compile(r"ABN\s+71\s*665\s*820\s*986", re.I),
        "ABN {org.abn}",
        "header/footer ABN",
    ),
    (
        "abn_label_truncated",
        re.compile(r"ABN\s+67\s*643\s*217\s*8?", re.I),
        "ABN {org.abn}",
        "body ABN",
    ),
    (
        "abn_label_generic",
        re.compile(r"ABN\s+12\s*345\s*678\s*901", re.I),
        "ABN {org.abn}",
        "test ABN literal",
    ),
    (
        "abn_digits_spring",
        re.compile(r"15\s*639\s*893\s*477"),
        "{org.abn}",
        "bare ABN digits",
    ),
    (
        "abn_digits_s2h",
        re.compile(r"71\s*665\s*820\s*986"),
        "{org.abn}",
        "bare ABN digits",
    ),
    (
        "abn_digits_truncated",
        re.compile(r"67\s*643\s*217\s*8?"),
        "{org.abn}",
        "bare ABN digits",
    ),
    (
        "kathleen_hayes",
        re.compile(r"Kathleen\s+Hayes", re.I),
        "{org.primary_contact.name}",
        "named contact",
    ),
    (
        "russell_pullin",
        re.compile(r"Russell\s+Pullin", re.I),
        "{org.signatory.name}",
        "named signatory",
    ),
    (
        "info_pristine_email",
        re.compile(r"info@pristinelifestylesolutions\.com\.au", re.I),
        "{org.email}",
        "vendor email",
    ),
    (
        "russell_email",
        re.compile(r"Russellpullin@gmail\.com", re.I),
        "{org.email}",
        "vendor email",
    ),
    (
        "phone_0481838570",
        re.compile(r"0481\s*838\s*570"),
        "{org.phone}",
        "vendor phone",
    ),
    (
        "phone_0468404845",
        re.compile(r"0468\s*404\s*845"),
        "{org.phone}",
        "vendor phone",
    ),
]

# Literal mustache remnants (from fix-broken-templates.mjs)
LITERAL_REPLACEMENTS: list[tuple[str, str, str]] = [
    ("mustache_business_name", "{{Business_Name}} &amp; {{Employee_Name}}", "{org.name}"),
    ("mustache_business_name_amp", "{{Business_Name}} & {{Employee_Name}}", "{org.name}"),
    ("broken_business_name", "Business_Name}} &amp; Employee_Name}}", "{org.name}"),
    ("broken_business_name_amp", "Business_Name}} & Employee_Name}}", "{org.name}"),
    ("mustache_entity_name", "{{Entity_Name}}", " The Board of {org.legal_name}"),
    ("broken_entity_name", "Entity_Name}}", " The Board of {org.legal_name}"),
    ("mustache_approver", "{{Approver_Name}}", "………………………………"),
    ("broken_approver", "Approver_Name}}", "………………………………"),
    ("stray_brace_after_legal", "{org.legal_name}{", "{org.legal_name}"),
]

AUDIT_PATTERNS: list[tuple[str, re.Pattern[str], str]] = [
    (pid, pat, hint) for pid, pat, _repl, hint in REPLACEMENT_RULES
] + [
    ("mustache_double_brace", re.compile(r"\{\{[^}]+\}\}"), "broken mustache tag"),
    (
        "broken_mustache_remnant",
        re.compile(r"(?:Business_Name|Entity_Name|Approver_Name|Employee_Name)\}\}"),
        "broken mustache remnant",
    ),
]


def part_location(xml_part: str) -> str:
    if xml_part == "word/document.xml":
        return "body"
    if "header" in xml_part:
        return "header"
    if "footer" in xml_part:
        return "footer"
    if "footnotes" in xml_part:
        return "footnote"
    if "endnotes" in xml_part:
        return "endnote"
    return "other"


def extract_visible_text(xml: str) -> str:
    return " ".join(W_T_RE.findall(xml))


def audit_docx(path: Path) -> list[dict]:
    hits: list[dict] = []
    if not path.exists():
        return hits
    with zipfile.ZipFile(path) as zf:
        for name in zf.namelist():
            if not XML_PART_RE.search(name):
                continue
            xml = zf.read(name).decode("utf-8", errors="replace")
            text = extract_visible_text(xml)
            loc = part_location(name)
            for pid, pat, hint in AUDIT_PATTERNS:
                for m in pat.finditer(text):
                    hits.append(
                        {
                            "file": path.name,
                            "location": loc,
                            "xml_part": name,
                            "pattern_id": pid,
                            "matched_text": m.group(),
                            "suggested_token": hint,
                            "context": text[max(0, m.start() - 30) : min(len(text), m.end() + 30)],
                        }
                    )
            # Also scan raw XML for split-run branding
            raw = xml
            for pid, pat, hint in AUDIT_PATTERNS:
                if pid.startswith("mustache") or pid.startswith("broken"):
                    continue
                for m in pat.finditer(raw):
                    if any(h["matched_text"] == m.group() and h["xml_part"] == name for h in hits):
                        continue
                    hits.append(
                        {
                            "file": path.name,
                            "location": loc,
                            "xml_part": name,
                            "pattern_id": f"{pid}_raw_xml",
                            "matched_text": m.group(),
                            "suggested_token": hint,
                            "context": "(raw XML match — may span runs)",
                        }
                    )
    return hits


def apply_replacements_to_xml(xml: str) -> tuple[str, list[dict]]:
    changes: list[dict] = []
    for pid, pat, repl, hint in REPLACEMENT_RULES:
        if not pat.search(xml):
            continue
        count = len(pat.findall(xml))
        xml = pat.sub(repl, xml)
        changes.append({"pattern_id": pid, "count": count, "replacement": repl, "hint": hint})
    for pid, find, repl in LITERAL_REPLACEMENTS:
        if find not in xml:
            continue
        count = xml.count(find)
        xml = xml.replace(find, repl)
        changes.append({"pattern_id": pid, "count": count, "replacement": repl, "hint": "mustache fix"})
    return xml, changes


def fix_docx(path: Path, dry_run: bool = False) -> dict:
    result = {"path": str(path), "exists": path.exists(), "fixed": False, "changes": []}
    if not path.exists():
        return result
    with zipfile.ZipFile(path) as zf:
        parts = {name: zf.read(name) for name in zf.namelist()}
        meta = {name: zf.getinfo(name) for name in zf.namelist()}

    total_changes = 0
    for name, data in list(parts.items()):
        if not XML_PART_RE.search(name):
            continue
        xml = data.decode("utf-8", errors="replace")
        new_xml, part_changes = apply_replacements_to_xml(xml)
        if part_changes:
            total_changes += sum(c["count"] for c in part_changes)
            result["changes"].append({"xml_part": name, "details": part_changes})
            parts[name] = new_xml.encode("utf-8")

    if total_changes and not dry_run:
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for name, data in parts.items():
                zi = zipfile.ZipInfo(name)
                src = meta.get(name)
                if src:
                    zi.date_time = src.date_time
                    zi.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(zi, data)
        result["fixed"] = True
    elif total_changes:
        result["fixed"] = True  # would fix
    return result


def collect_slugs(library: Path, slug_filter: list[str] | None) -> list[str]:
    slugs = sorted(
        d.name
        for d in library.iterdir()
        if d.is_dir() and not d.name.startswith("_") and (d / "template.docx").exists()
    )
    if slug_filter:
        slugs = [s for s in slugs if s in slug_filter]
    return slugs


def run_audit(library: Path, slugs: list[str]) -> dict:
    documents = []
    before_total = 0
    for slug in slugs:
        slug_dir = library / slug
        hits: list[dict] = []
        for fname in ("template.docx", "template.docx.prebrand"):
            hits.extend(audit_docx(slug_dir / fname))
        if hits:
            before_total += len(hits)
            documents.append({"slug": slug, "hit_count": len(hits), "hits": hits})
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "phase": "before",
        "summary": {
            "total_documents_scanned": len(slugs),
            "documents_with_hits": len(documents),
            "total_hits": before_total,
            "hits_by_pattern": _count_by_pattern(documents),
            "slugs_with_hits": [d["slug"] for d in documents],
        },
        "documents": documents,
    }


def _count_by_pattern(documents: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for doc in documents:
        for h in doc.get("hits", []):
            pid = h["pattern_id"]
            counts[pid] = counts.get(pid, 0) + 1
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description="Audit/fix hardcoded org branding in library templates")
    parser.add_argument("--audit", action="store_true", help="Audit only (default if neither flag)")
    parser.add_argument("--fix", action="store_true", help="Apply fixes to template.docx and .prebrand")
    parser.add_argument("--slug", action="append", dest="slugs", help="Limit to slug(s)")
    args = parser.parse_args()

    if not args.audit and not args.fix:
        args.audit = True

    slugs = collect_slugs(LIBRARY_DIR, args.slugs)
    before = run_audit(LIBRARY_DIR, slugs)

    fix_results = []
    if args.fix:
        for slug in slugs:
            slug_dir = LIBRARY_DIR / slug
            for fname in ("template.docx", "template.docx.prebrand"):
                fix_results.append({"slug": slug, **fix_docx(slug_dir / fname)})

    after = run_audit(LIBRARY_DIR, slugs) if args.fix else None

    report = {
        **before,
        "fix_applied": bool(args.fix),
        "fix_results": fix_results if args.fix else None,
        "after_summary": after["summary"] if after else None,
    }
    AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
    AUDIT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(json.dumps(before["summary"], indent=2))
    if args.fix:
        fixed_files = sum(1 for r in fix_results if r.get("fixed"))
        print(f"\nFixed {fixed_files} file(s).")
        print("After:", json.dumps(after["summary"], indent=2))
    print(f"\nAudit → {AUDIT_PATH}")


if __name__ == "__main__":
    main()
