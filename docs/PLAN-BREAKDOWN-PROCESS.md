# Support Coordinator: Plan Breakdown & Budget Process

This process helps support coordinators take an NDIS participant plan (PDF or other format) and turn it into a structured budget in the app, so you can track utilisation and hours per support type.

---

## Overview

**Goal:** Break down the participant’s NDIS plan into support categories and budgets, then enter them into the app so you can:
- See budget vs used vs remaining per category
- Estimate hours per support type
- Track utilisation over time

---

## Step 1: Obtain the Plan

Plans usually come in one of two forms:

| Format | Source | What you’ll see |
|--------|--------|-----------------|
| **Legacy** | Printed plan, older PDF | Support categories (01–15), budget amounts, sometimes line item numbers |
| **PACE** | myGov participant portal, newer PDF | Support categories (01–21), budget amounts, different layout |

Both formats can be turned into the same budget breakdown.

---

## Step 2: Extract the Budget Breakdown

From the plan document, pull out for each support category:

1. **Support category** (e.g. 01, 07, 09)
2. **Category name** (e.g. Assistance with Daily Life, Support Coordination)
3. **Budget amount** (e.g. $5,000)
4. **Line items** (optional but useful) – NDIS support item numbers (e.g. 01_011_0107_1_1)

### Where to find these in the plan

- **Budget table** – usually shows category, name, and amount
- **Line items** – may be in the same table or in a separate “Support Items” section
- **Support item numbers** – look like `01_011_0107_1_1` (category_registration_item_group_type)

### If line items aren’t listed

You can:
- Use the NDIS Support Catalogue to find typical items for that category
- Leave line items blank and add them later in the app
- Use the app’s NDIS line item picker when adding budgets

---

## Step 3: Create a CSV (for upload)

Create a CSV file with these columns:

**Format 1 (Legacy-style):**
```csv
Support Category,Category Name,Budget Amount,Line Items (e.g. 01_011_0107_1_1)
01,Assistance with Daily Life,5000,"01_011_0107_1_1, 01_012_0107_1_1"
07,Support Coordination,2500,"07_001_0107_7_1"
09,Increased Social and Community Participation,3000,"09_001_0116_9_1"
```

**Format 2 (PACE-style):**
```csv
Category ID,Support Category Name,Budget ($),Support Item Numbers
01,Assistance with Daily Life (Includes SIL),5000.00,01_011_0107_1_1; 01_012_0107_1_1
07,Support Coordination,2500.00,07_001_0107_7_1
09,Social and Community Participation,3000.00,09_001_0116_9_1
```

**Rules:**
- First row = headers
- Support category = 2 digits (01–15 or 01–21 for PACE)
- Budget amount = number only (no $ or commas)
- Line items = comma- or semicolon-separated support item numbers; use quotes if there are commas inside

Sample files are in `sample-plans/`:
- `plan-format-1-legacy.csv`
- `plan-format-2-pace.csv`

---

## Step 4: Add Plan & Upload in the App

1. Open the participant’s profile.
2. Go to the **NDIS Plans & Budget** tab.
3. Click **Add Plan** and enter:
   - Start date
   - End date
   - PACE plan (if applicable)
4. Click **Upload plan CSV** (or equivalent) and select your CSV.
5. The app will:
   - Parse the file
   - Match line items to the NDIS Support Catalogue
   - Show a preview with budget amounts and estimated hours
6. Review the preview and click **Apply** to create all budgets in one go.

---

## Step 5: Review & Adjust

After upload:

- Check each category’s budget and line items.
- Edit any category if amounts or line items are wrong.
- Add line items manually if they weren’t in the CSV or didn’t match.

---

## Step 6: Use the Budget View

- Go to the **Overview** tab to see:
  - Budget vs used vs remaining per category
  - Progress bars for utilisation
  - Alerts when budgets are high (e.g. 70%+, 90%+)
- Use this to:
  - Plan supports
  - Spot categories running low
  - Report to participants and families

---

## Quick Reference: Support Categories (01–15)

| ID | Category |
|----|----------|
| 01 | Assistance with Daily Life |
| 02 | Transport |
| 03 | Consumables |
| 04 | Assistance with Social, Economic and Community Participation |
| 05 | Assistive Technology |
| 06 | Home Modifications and SDA |
| 07 | Support Coordination |
| 08 | Improved Living Arrangements |
| 09 | Increased Social and Community Participation |
| 10 | Finding and Keeping a Job |
| 11 | Improved Relationships |
| 12 | Improved Health and Wellbeing |
| 13 | Improved Learning |
| 14 | Improved Life Choices |
| 15 | Improved Daily Living Skills |

---

## Troubleshooting

| Issue | What to do |
|-------|------------|
| Line items not matching | Ensure NDIS Support Catalogue is imported. Check support item format (e.g. 01_011_0107_1_1). |
| Wrong budget amounts | Edit the budget in the app after upload. |
| CSV won’t parse | Check headers match Format 1 or 2. Ensure no extra blank rows at the top. |
| No line items in plan | Create the CSV with category, name, and amount only. Add line items later in the app. |
