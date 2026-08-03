import OnboardingDocumentSelectPanel from './OnboardingDocumentSelectPanel.jsx';

/**
 * Modal wrapper around OnboardingDocumentSelectPanel for list/onboarding pages.
 */
export default function OnboardingDocumentSelectModal({
  open,
  mode,
  staffId = null,
  participantId = null,
  recipientEmail,
  recipientName,
  defaultContextValue = 'all',
  onClose,
  onSend,
  extraPdfCount = null
}) {
  if (!open) return null;

  const isParticipant = mode === 'participant';

  const handleSend = async (payload) => {
    await onSend(payload);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 680 }}>
        <h3 style={{ marginTop: 0 }}>
          {isParticipant ? 'Send participant onboarding documents' : 'Send staff onboarding documents'}
        </h3>
        <OnboardingDocumentSelectPanel
          mode={mode}
          staffId={staffId}
          participantId={participantId}
          recipientEmail={recipientEmail}
          recipientName={recipientName}
          defaultContextValue={defaultContextValue}
          extraPdfCount={extraPdfCount}
          active={open}
          onCancel={onClose}
          onSend={handleSend}
        />
      </div>
    </div>
  );
}
