#!/usr/bin/env python3
"""Import tokenised fillable PDF masters into the Nexus Core document library.

Reads the Policy Product Build "Masters (fillable - CRM)" set — these PDFs are
already built with proper AcroForm fields: shared-name provider slots
(PROVIDER_SHORT, ABN, EFFECTIVE_DATE, org_logo, …) that the CRM fills from an
org's business details, plus per-recipient client/staff/signature fields. This
script just copies each PDF to server/templates/library/<slug>/template.pdf,
writes a manifest.json describing it, and removes legacy DOCX/prebrand files.

It no longer stamps fields over ⟨ chip ⟩ text — that produced misaligned,
duplicated widgets. The fields now come from the upstream build
(_pipeline/build.py, profile "_fillable").
"""
from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

import fitz

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
LIBRARY_OUT = PROJECT_ROOT / "server" / "templates" / "library"
CATALOGUE_PATH = LIBRARY_OUT / "_catalogue.json"

SOURCE_DIR = Path(
    "/Users/pristinelifestylesolutions/Library/CloudStorage"
    "/OneDrive-PristineLifestyleSolutions/Spring 2 health"
    "/Policy Product Build/Masters (fillable - CRM)"
)
CATEGORY_DIR = Path(
    "/Users/pristinelifestylesolutions/Library/CloudStorage"
    "/OneDrive-PristineLifestyleSolutions/Spring 2 health"
    "/Policy Product Build/Masters (fillable - CRM) (by category)"
)


FIELD_TO_TOKEN = {
    "org_logo": "org.branding.logo_path",
    "logo": "org.branding.logo_path",
    "PROVIDER_NAME": "org.legal_name",
    "PROVIDER_SHORT": "org.name",
    "ABN": "org.abn",
    "NDIS_REG_NO": "org.ndis_provider_number",
    "PHONE": "org.phone",
    "EMAIL": "org.email",
    "COMPLAINTS_EMAIL": "org.email",
    "WEBSITE": "org.website",
    "STREET_ADDRESS": "org.street_address",
    "POSTAL_ADDRESS": "org.postal_address",
    "GOVERNING_BODY": "org.legal_name",
    "KMP": "org.signatory.name",
    "PRINCIPAL": "org.signatory.name",
    "DOC_OWNER": "org.signatory.role",
    "APPROVED_BY": "org.signatory.name",
    "EFFECTIVE_DATE": "today_long",
    "REVIEW_DATE": "today_long",
}

SKIP_NAMES = {"client intake form copy.pdf"}

CATEGORY_RULES = [
    (re.compile(r"register", re.I), "register"),
    (re.compile(r"(services?\s+agreement|agreement|contract|engagement|declaration|consent)", re.I), "contract"),
    (re.compile(r"(policy$|policy\s+and|and\s+policy|procedures)", re.I), "policy"),
    (re.compile(r"(procedure|plan$|checklist|report|record|survey|booklet|letter)", re.I), "procedure"),
    (re.compile(r"(form$|form\s+copy)", re.I), "form"),
    (re.compile(r"position\s+description", re.I), "guide"),
]

PACK_NAME_RULES = [
    (re.compile(r"(services?\s+agreement|client\s+intake|privacy\s+consent|client\s+induction|service\s+schedule|support\s+coordination\s+services|change\s+of\s+supports|exit\s+and\s+transition|advocacy|client\s+information|sda.*sil)", re.I), "participant_onboarding"),
    (re.compile(r"(staff\s+induction|worker\s+declaration|letter\s+of\s+engagement|contractor\s+agreement|position\s+description|reference\s+check|pre.?employment|interview\s+report|staff\s+file|staff\s+exit|exit\s+interview)", re.I), "staff_onboarding"),
    (re.compile(r"register", re.I), "compliance_register"),
    (re.compile(r"policy", re.I), "policy_library"),
]

FOLDER_PACK = {
    "01": "staff_onboarding",
    "02": "staff_onboarding",
    "03": "participant_onboarding",
    "04": "participant_onboarding",
    "09": "participant_onboarding",
}


def slugify(name: str) -> str:
    name = re.sub(r"\.pdf$", "", name, flags=re.I)
    name = re.sub(r"[_\s]+", "-", name.strip())
    name = re.sub(r"[^a-zA-Z0-9\-]", "", name)
    return re.sub(r"-+", "-", name).strip("-").lower()


def display_name(filename: str) -> str:
    return re.sub(r"\.pdf$", "", filename, flags=re.I).replace("_", " ").strip()


def classify_category(title: str) -> str:
    for pat, cat in CATEGORY_RULES:
        if pat.search(title):
            return cat
    return "procedure"


def classify_pack(title: str, folder_name: str, category: str) -> str:
    for pat, pack in PACK_NAME_RULES:
        if pat.search(title):
            return pack
    if category == "register":
        return "compliance_register"
    if category == "policy":
        return "policy_library"
    prefix = folder_name[:2] if folder_name else ""
    if prefix in FOLDER_PACK:
        if category == "policy":
            return "policy_library"
        if category == "register":
            return "compliance_register"
        return FOLDER_PACK[prefix]
    if category in ("contract", "form"):
        return "participant_onboarding" if prefix in {"03", "04", "09"} else "staff_onboarding"
    return "policy_library"


def service_types(title: str, slug: str) -> list[str]:
    t = f"{title} {slug}".lower()
    types = []
    if re.search(r"\bsil\b|supported independent", t):
        types.append("sil")
    if re.search(r"\bsda\b", t):
        types.append("sda")
    if "support coordination" in t or "specialised support" in t:
        types.append("support_coordination")
    return types or ["all"]


def staff_roles(title: str, slug: str) -> list[str]:
    t = f"{title} {slug}".lower()
    if "support coordinator" in t or "specialist support coordinator" in t:
        return ["support_coordinator"]
    if "administration" in t or "business development" in t or "director" in t:
        return ["admin"]
    if "disability support worker" in t:
        return ["disability_support_worker"]
    return ["all"]


def required_signer(pack: str, sig_count: int, category: str) -> str | None:
    if sig_count <= 0:
        return None
    if pack == "staff_onboarding":
        return "staff"
    if pack == "participant_onboarding" or category == "contract":
        return "participant"
    return None


def is_sig_name(name: str) -> bool:
    n = (name or "").lower()
    return bool(re.search(r"(^|_)sig($|_)", n) or "signature" in n)


def import_pdf(src: Path, dest: Path) -> dict:
    """Copy a fillable master into the library and read back its field inventory.

    The PDF already carries every AcroForm field it needs (shared-name provider
    slots, per-recipient client/staff fields, signature widgets) from the
    upstream build, so nothing is added or removed here."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dest)

    doc = fitz.open(dest)
    field_names: list[str] = []
    provider_fields: list[str] = []
    sig_count = 0
    for page in doc:
        for w in page.widgets() or []:
            name = w.field_name
            if not name:
                continue
            field_names.append(name)
            if is_sig_name(name):
                sig_count += 1
            base = re.sub(r"_\d+$", "", name)
            if base in FIELD_TO_TOKEN and base not in provider_fields:
                provider_fields.append(base)
    doc.close()
    return {
        "provider_fields": provider_fields,
        "signature_count": sig_count,
        "field_names": field_names,
    }


def load_previous_catalogue() -> dict[str, dict]:
    if not CATALOGUE_PATH.exists():
        return {}
    try:
        rows = json.loads(CATALOGUE_PATH.read_text())
    except json.JSONDecodeError:
        return {}
    return {row["slug"]: row for row in rows if row.get("slug")}


def build_category_map() -> dict[str, str]:
    mapping = {}
    if not CATEGORY_DIR.is_dir():
        return mapping
    for folder in CATEGORY_DIR.iterdir():
        if not folder.is_dir():
            continue
        for pdf in folder.glob("*.pdf"):
            mapping[slugify(pdf.name)] = folder.name
    return mapping


def build_manifest(slug: str, filename: str, folder: str, meta: dict, previous: dict | None) -> dict:
    title = display_name(filename)
    prev = previous or {}
    category = prev.get("category") or classify_category(title)
    pack = None
    packs = prev.get("packs")
    if isinstance(packs, list) and packs:
        pack = packs[0]
    elif prev.get("pack"):
        pack = prev["pack"]
    else:
        pack = classify_pack(title, folder, category)

    sig_count = int(meta.get("signature_count") or 0)
    placeholders = []
    for base in meta.get("provider_fields") or []:
        token = FIELD_TO_TOKEN.get(base)
        if token and token not in placeholders:
            placeholders.append(token)
    if "org.branding.logo_path" not in placeholders:
        placeholders.insert(0, "org.branding.logo_path")

    manifest = {
        "slug": slug,
        "display_name": prev.get("display_name") or title,
        "category": category,
        "form_type": prev.get("form_type") or category,
        "engine": "pdf-acroform",
        "version": "2.0.0",
        "template_file": "template.pdf",
        "placeholders": placeholders,
        "packs": [pack],
        "pack": pack,
        "required_signer_role": prev.get("required_signer_role") or required_signer(pack, sig_count, category),
        "signature_count": sig_count,
        "renewal_days": prev.get("renewal_days"),
        "is_active": True if prev.get("is_active") is None else bool(prev.get("is_active")),
        "source_pdf": filename,
        "source_category": folder,
    }
    if pack == "participant_onboarding":
        manifest["participant_service_types"] = prev.get("participant_service_types") or service_types(title, slug)
    if pack == "staff_onboarding":
        manifest["staff_roles"] = prev.get("staff_roles") or staff_roles(title, slug)
    if prev.get("admin_fields"):
        manifest["admin_fields"] = prev["admin_fields"]
    return manifest


def wipe_legacy_in_folder(folder: Path) -> None:
    for pattern in ("template.docx", "template.docx.prebrand", "template.pdf.prebrand", "preview.png"):
        p = folder / pattern
        if p.exists():
            p.unlink()


def main() -> int:
    if not SOURCE_DIR.is_dir():
        print(f"ERROR: source folder missing: {SOURCE_DIR}", file=sys.stderr)
        return 1

    previous = load_previous_catalogue()
    cat_map = build_category_map()
    pdfs = sorted(
        p for p in SOURCE_DIR.glob("*.pdf")
        if p.name.lower() not in SKIP_NAMES
    )

    LIBRARY_OUT.mkdir(parents=True, exist_ok=True)
    kept_slugs = set()
    catalogue = []
    stats = {"imported": 0, "chips": 0, "signatures": 0}

    for pdf in pdfs:
        slug = slugify(pdf.name)
        if not slug:
            print(f"  skip unslugable: {pdf.name}")
            continue
        dest_dir = LIBRARY_OUT / slug
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_pdf = dest_dir / "template.pdf"
        print(f"  {pdf.name} -> {slug}/")
        meta = import_pdf(pdf, dest_pdf)
        folder = cat_map.get(slug, "")
        manifest = build_manifest(slug, pdf.name, folder, meta, previous.get(slug))
        (dest_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        wipe_legacy_in_folder(dest_dir)
        kept_slugs.add(slug)
        catalogue.append(manifest)
        stats["imported"] += 1
        stats["chips"] += len(meta.get("provider_fields") or [])
        stats["signatures"] += manifest["signature_count"]

    # Remove old library slugs that are no longer in the master set.
    for child in list(LIBRARY_OUT.iterdir()):
        if not child.is_dir():
            continue
        if child.name not in kept_slugs:
            print(f"  remove obsolete slug: {child.name}")
            shutil.rmtree(child)

    catalogue.sort(key=lambda m: m["slug"])
    CATALOGUE_PATH.write_text(json.dumps(catalogue, indent=2) + "\n")
    print(
        f"\nImported {stats['imported']} masters, "
        f"{stats['chips']} provider fields wired, "
        f"{stats['signatures']} signature widgets."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
