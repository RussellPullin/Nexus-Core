#!/usr/bin/env python3
"""
Convert the official NDIS Support Catalogue .xlsx into the CSV schema used by
Nexus Core (server/ndis-catalogue.csv, client/public/ndis-catalogue.csv,
server/src/routes/ndis-catalogue.csv).

From 2026-27 the NDIA publishes a single "National" price column instead of the
old per-state columns (ACT, NSW, NT, QLD, SA, TAS, VIC, WA). Nexus Core's
importer keys off those state columns, so we expand the National price across
all eight of them to keep the file a drop-in replacement for the existing
28-column layout.

Usage:
    python3 scripts/convert-ndis-catalogue.py <input.xlsx> [--sheet "Current Support Items"]

Writes UTF-8 (with BOM) CSV to stdout.
"""
import argparse
import csv
import sys

import openpyxl

# Target header (must match the existing ndis-catalogue.csv byte-for-byte,
# including the surrounding spaces around the state/remote columns).
TARGET_HEADER = [
    "Support Item Number",
    "Support Item Name",
    "Registration Group Number",
    "Registration Group Name",
    "Support Category Number",
    "Support Category Number (PACE)",
    "Support Category Name",
    "Support Category Name (PACE)",
    "Unit",
    "Quote",
    "Start date",
    "End Date",
    " ACT ",
    " NSW ",
    " NT ",
    " QLD ",
    " SA ",
    " TAS ",
    " VIC ",
    " WA ",
    " Remote ",
    " Very Remote ",
    "Non-Face-to-Face Support Provision",
    "Provider Travel",
    "Short Notice Cancellations.",
    "NDIA Requested Reports",
    "Irregular SIL Supports",
    "Type",
]

# Column indexes in the official 2026-27 workbook ("Current Support Items").
SRC = {
    "support_item_number": 0,
    "support_item_name": 1,
    "reg_group_number": 2,
    "reg_group_name": 3,
    "support_category_number": 4,
    "support_category_number_pace": 5,
    "support_category_name": 6,
    "support_category_name_pace": 7,
    "unit": 8,
    "quote": 9,
    "start_date": 10,
    "end_date": 11,
    "national": 12,
    "remote": 13,
    "very_remote": 14,
    "non_face_to_face": 15,
    "provider_travel": 16,
    "short_notice": 17,
    "ndia_reports": 18,
    "irregular_sil": 19,
    "type": 20,
}


def fmt_price(val):
    """Format a numeric price as $X.XX; blank when there is no price."""
    if val is None:
        return ""
    s = str(val).strip()
    if s == "" or s.upper() in ("NA", "N/A"):
        return ""
    try:
        return f"${float(s):.2f}"
    except (TypeError, ValueError):
        return s


def cell(val):
    """Stringify a cell, preserving text (e.g. leading-zero reg groups)."""
    if val is None:
        return ""
    if isinstance(val, float) and val.is_integer():
        return str(int(val))
    return str(val).strip()


def convert(path, sheet_name):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb[sheet_name] if sheet_name else wb.worksheets[0]

    writer = csv.writer(sys.stdout, lineterminator="\n")
    # BOM to match the existing files (utf-8-sig).
    sys.stdout.write("\ufeff")
    writer.writerow(TARGET_HEADER)

    count = 0
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if i == 0:
            continue  # skip header
        if row is None:
            continue
        item_no = cell(row[SRC["support_item_number"]])
        if not item_no:
            continue
        national = fmt_price(row[SRC["national"]])
        out = [
            item_no,
            cell(row[SRC["support_item_name"]]),
            cell(row[SRC["reg_group_number"]]),
            cell(row[SRC["reg_group_name"]]),
            cell(row[SRC["support_category_number"]]),
            cell(row[SRC["support_category_number_pace"]]),
            cell(row[SRC["support_category_name"]]),
            cell(row[SRC["support_category_name_pace"]]),
            cell(row[SRC["unit"]]),
            cell(row[SRC["quote"]]),
            cell(row[SRC["start_date"]]),
            cell(row[SRC["end_date"]]),
            national,  # ACT
            national,  # NSW
            national,  # NT
            national,  # QLD
            national,  # SA
            national,  # TAS
            national,  # VIC
            national,  # WA
            fmt_price(row[SRC["remote"]]),
            fmt_price(row[SRC["very_remote"]]),
            cell(row[SRC["non_face_to_face"]]),
            cell(row[SRC["provider_travel"]]),
            cell(row[SRC["short_notice"]]),
            cell(row[SRC["ndia_reports"]]),
            cell(row[SRC["irregular_sil"]]),
            cell(row[SRC["type"]]),
        ]
        writer.writerow(out)
        count += 1

    print(f"[convert-ndis-catalogue] wrote {count} support items", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input", help="Path to the official NDIS Support Catalogue .xlsx")
    ap.add_argument("--sheet", default="Current Support Items", help="Worksheet to convert")
    args = ap.parse_args()
    convert(args.input, args.sheet)


if __name__ == "__main__":
    main()
