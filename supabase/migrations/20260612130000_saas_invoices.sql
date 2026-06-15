-- Track every SaaS invoice issued to orgs for Nexus Core.

CREATE TABLE IF NOT EXISTS public.saas_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  invoice_number TEXT,
  period_label TEXT NOT NULL,
  subtotal NUMERIC(10,2) NOT NULL,
  gst NUMERIC(10,2) NOT NULL,
  total NUMERIC(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'overdue', 'voided')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_nc_saas_invoices_org_id ON public.saas_invoices(org_id);
CREATE INDEX IF NOT EXISTS idx_nc_saas_invoices_status ON public.saas_invoices(status);

ALTER TABLE public.saas_invoices ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.saas_invoices IS 'SaaS billing invoice history for Nexus Core orgs. Vendor-only visibility.';
