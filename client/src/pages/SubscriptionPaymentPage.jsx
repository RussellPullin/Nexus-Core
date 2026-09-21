import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

function money(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}

export default function SubscriptionPaymentPage({ account, onRefresh }) {
  const { logout } = useAuth();
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState('');
  const invoices = account?.invoices || [];
  const bank = account?.bank;

  async function checkAgain() {
    setChecking(true);
    setCheckNote('');
    try {
      const next = await onRefresh();
      if (next?.locked) {
        setCheckNote('Still unpaid. Access opens after the invoice is marked paid.');
      }
    } catch {
      setCheckNote('Could not check the invoice just now. Try again in a moment.');
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="sub-pay">
      <div className="sub-pay-card">
        <p className="sub-pay-kicker">Nexus Core subscription</p>
        <h1>Payment required</h1>
        <p className="sub-pay-lead">
          {account?.organization_name ? `${account.organization_name} is` : 'This organisation is'} paused
          until the Nexus Core invoice is paid. Shifter is part of that invoice, so there is no separate Shifter bill.
        </p>

        {invoices.length === 0 ? (
          <p>No open invoice was found. Use Check again after the payment has been recorded.</p>
        ) : (
          invoices.map((inv) => (
            <section key={inv.id || inv.invoice_number} className="sub-pay-invoice">
              <div className="sub-pay-row">
                <span>Invoice</span>
                <strong>{inv.invoice_number || '—'}</strong>
              </div>
              <div className="sub-pay-row">
                <span>Period</span>
                <strong>{inv.period_label || '—'}</strong>
              </div>
              <div className="sub-pay-row">
                <span>Amount</span>
                <strong>{money(inv.total)} AUD</strong>
              </div>
              <div className="sub-pay-row">
                <span>Due</span>
                <strong>{formatDate(inv.due_at)}</strong>
              </div>
              {inv.covers_shifter ? <p className="sub-pay-note">Includes Shifter.</p> : null}
            </section>
          ))
        )}

        {bank ? (
          <section className="sub-pay-bank">
            <h2>Pay by transfer</h2>
            <div className="sub-pay-row"><span>Account name</span><strong>{bank.account_name}</strong></div>
            <div className="sub-pay-row"><span>BSB</span><strong>{bank.bsb}</strong></div>
            <div className="sub-pay-row"><span>Account</span><strong>{bank.account}</strong></div>
            <div className="sub-pay-row">
              <span>Reference</span>
              <strong>{invoices[0]?.invoice_number || 'The invoice number'}</strong>
            </div>
            <p className="sub-pay-note">Use the invoice number as the transfer reference.</p>
          </section>
        ) : null}

        <p className="sub-pay-lead">
          After the transfer arrives, it is marked paid on the Nexus Core billing dashboard. Then press Check again.
        </p>
        {checkNote ? <p className="sub-pay-note">{checkNote}</p> : null}

        <div className="sub-pay-actions">
          <button type="button" className="btn btn-primary" onClick={checkAgain} disabled={checking}>
            {checking ? 'Checking…' : 'Check again'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => logout()}>
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}
