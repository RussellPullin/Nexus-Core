import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { formTemplates, participants } from '../lib/api';
import { composeParticipantLegalName } from '@nexus-shared/onboardingFieldRegistry.js';

/**
 * Nexus structured Service Agreement — generate from onboarding intake / participant profile.
 */
export default function ServiceAgreementOnboardingBlock({
  participantId,
  intake,
  pathPrefix,
  working,
  setWorking,
  intakeSavedAt
}) {
  const [orgTemplateId, setOrgTemplateId] = useState('');
  const [signerType, setSignerType] = useState('participant');
  const [saGaps, setSaGaps] = useState(null);
  const [saPreflightLoading, setSaPreflightLoading] = useState(false);
  const [saGenerated, setSaGenerated] = useState([]);
  const [saMessage, setSaMessage] = useState('');
  const [lastGeneratedIntakeKey, setLastGeneratedIntakeKey] = useState(null);

  const intakeKey = useMemo(() => JSON.stringify(intake || {}), [intake]);
  const participantName = composeParticipantLegalName(intake) || '';

  const loadTemplate = useCallback(async () => {
    try {
      const { instances } = await formTemplates.instances();
      const inst = (instances || []).find((i) => i.template_key === 'service_agreement_standard_v3') || instances?.[0];
      if (inst) setOrgTemplateId(inst.id);
    } catch {
      setOrgTemplateId('');
    }
  }, []);

  const loadGenerated = useCallback(async () => {
    if (!participantId) return;
    try {
      const { items } = await participants.listServiceAgreements(participantId);
      setSaGenerated(items || []);
    } catch {
      setSaGenerated([]);
    }
  }, [participantId]);

  const runPreflight = useCallback(async () => {
    if (!participantId || !orgTemplateId) return;
    setSaPreflightLoading(true);
    try {
      const result = await participants.preflightServiceAgreement(participantId, {
        org_template_id: orgTemplateId,
        instance_overrides: { signer_type: signerType }
      });
      setSaGaps(result);
    } catch (e) {
      setSaGaps({ gaps: [], blocking_count: 0, warning_count: 0, can_generate: false, error: e.message });
    } finally {
      setSaPreflightLoading(false);
    }
  }, [participantId, orgTemplateId, signerType]);

  useEffect(() => {
    loadTemplate();
    loadGenerated();
  }, [loadTemplate, loadGenerated]);

  useEffect(() => {
    if (orgTemplateId && participantId) runPreflight();
  }, [orgTemplateId, participantId, intakeKey, intakeSavedAt, signerType, runPreflight]);

  const intakeChangedSinceGenerate =
    lastGeneratedIntakeKey != null && lastGeneratedIntakeKey !== intakeKey && saGenerated.length > 0;

  const handleGenerate = async () => {
    if (!orgTemplateId) {
      setSaMessage('Set up your organisation template under Forms first.');
      return;
    }
    if (!participantName?.trim()) {
      setSaMessage('Save the intake form with the participant’s name first.');
      return;
    }
    setWorking(true);
    setSaMessage('');
    try {
      const result = await participants.generateServiceAgreement(participantId, {
        org_template_id: orgTemplateId,
        instance_overrides: { signer_type: signerType }
      });
      setLastGeneratedIntakeKey(intakeKey);
      setSaMessage('Service agreement PDF generated.');
      await loadGenerated();
      if (result?.download_url) {
        window.open(result.download_url, '_blank', 'noopener,noreferrer');
      }
    } catch (e) {
      const gaps = e.gaps || (typeof e.message === 'string' && e.message.includes('required') ? saGaps?.gaps : null);
      if (gaps?.length) setSaGaps((prev) => ({ ...prev, gaps, can_generate: false }));
      setSaMessage(e.message || 'Could not generate service agreement');
    } finally {
      setWorking(false);
    }
  };

  if (!orgTemplateId) {
    return (
      <div style={{ marginTop: '1rem', padding: '1rem', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
        <h4 style={{ margin: '0 0 0.35rem 0', fontSize: '1rem' }}>Service Agreement (participant)</h4>
        <p className="forms-muted" style={{ margin: 0, fontSize: '0.9rem' }}>
          Configure your organisation’s agreement template under <Link to={`${pathPrefix}/forms`}>Forms</Link> before generating for this participant.
        </p>
      </div>
    );
  }

  return (
    <div style={{ marginTop: '1rem', padding: '1rem', background: '#f0f9ff', borderRadius: 8, border: '1px solid #bae6fd' }}>
      <h4 style={{ margin: '0 0 0.35rem 0', fontSize: '1rem' }}>Service Agreement (participant)</h4>
      <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.9rem', color: '#0369a1' }}>
        The participant is the <strong>client</strong> on this agreement. Fields come from the intake form above and the participant profile.
        After you change intake or profile details, generate again so the PDF matches.
      </p>

      <div style={{ marginBottom: '0.75rem' }}>
        <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.25rem' }}>
          Who is completing and signing this agreement?
        </label>
        <select
          className="form-input"
          style={{ maxWidth: 280 }}
          value={signerType}
          disabled={working || saPreflightLoading}
          onChange={(e) => setSignerType(e.target.value)}
        >
          <option value="participant">Participant signs</option>
          <option value="guardian">Guardian/representative signs</option>
        </select>
      </div>

      {intakeChangedSinceGenerate ? (
        <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.88rem', color: '#b45309', background: '#fffbeb', padding: '0.5rem 0.65rem', borderRadius: 6 }}>
          Intake data has changed since the last agreement was generated. Generate a new PDF before signing or sending.
        </p>
      ) : null}

      {saMessage ? (
        <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.88rem', color: saMessage.includes('generated') ? '#166534' : '#b91c1c' }}>{saMessage}</p>
      ) : null}

      {saPreflightLoading ? (
        <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.88rem', color: '#64748b' }}>Checking required fields…</p>
      ) : (saGaps?.blocking_count ?? 0) > 0 ? (
        <div style={{ marginBottom: '0.75rem', fontSize: '0.88rem' }}>
          <p style={{ margin: '0 0 0.35rem 0', fontWeight: 600, color: '#991b1b' }}>
            Complete these before generating ({saGaps.blocking_count} required):
          </p>
          <ul style={{ margin: 0, paddingLeft: '1.2rem', color: '#450a0a' }}>
            {(saGaps.gaps || [])
              .filter((g) => g.severity === 'blocking')
              .map((g) => (
                <li key={g.id}>{g.title}</li>
              ))}
          </ul>
        </div>
      ) : null}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', marginBottom: saGenerated.length ? '0.75rem' : 0 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={working || saPreflightLoading || !saGaps?.can_generate}
          onClick={handleGenerate}
        >
          {working ? 'Generating…' : saGenerated.length ? 'Regenerate service agreement PDF' : 'Generate service agreement PDF'}
        </button>
        <button type="button" className="btn btn-secondary" disabled={working || saPreflightLoading} onClick={runPreflight}>
          Re-check fields
        </button>
      </div>

      {saGenerated.length > 0 ? (
        <div style={{ fontSize: '0.88rem' }}>
          <p style={{ margin: '0 0 0.35rem 0', fontWeight: 600 }}>Generated copies</p>
          <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
            {saGenerated.map((g) => (
              <li key={g.id} style={{ marginBottom: '0.25rem' }}>
                {g.generated_at ? new Date(g.generated_at).toLocaleString() : 'Generated'}{' '}
                <a
                  className="btn btn-secondary btn-sm"
                  style={{ marginLeft: '0.35rem', fontSize: '0.78rem', padding: '0.15rem 0.45rem' }}
                  href={`/api/generated-forms/${g.id}/pdf`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Download PDF
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
