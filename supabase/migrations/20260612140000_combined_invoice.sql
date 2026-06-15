-- Support combined Nexus Core + Shifter invoices
ALTER TABLE saas_invoices ADD COLUMN IF NOT EXISTS line_items jsonb;
ALTER TABLE saas_invoices ADD COLUMN IF NOT EXISTS shifter_org_id uuid;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS linked_shifter_org_id uuid;
