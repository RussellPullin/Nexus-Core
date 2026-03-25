/**
 * Simple Week Planner - drag worker + client onto 30-minute grid to create shifts.
 * Resize shift cards to extend duration in 30-minute increments.
 * Notes on shifts are sent to workers when roster is sent.
 */
import { useState, useCallback, useEffect } from 'react';
import { formatDate } from '../lib/dateUtils';

const SLOTS_PER_HOUR = 2; // 30-minute increments
const HOURS_DISPLAY = 24;
const TOTAL_SLOTS = HOURS_DISPLAY * SLOTS_PER_HOUR;

const ZOOM_LEVELS = [
  { value: 0.5, label: 'Week view', slotHeight: 12 },
  { value: 0.75, label: 'Compact', slotHeight: 18 },
  { value: 1, label: 'Standard', slotHeight: 28 }
];

function toLocalDateStr(day) {
  const y = day.getFullYear();
  const m = String(day.getMonth() + 1).padStart(2, '0');
  const d = String(day.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toSlotTime(dateStr, slotIndex) {
  const hours = Math.floor(slotIndex / SLOTS_PER_HOUR);
  const mins = (slotIndex % SLOTS_PER_HOUR) * 30;
  const h = String(hours).padStart(2, '0');
  const m = String(mins).padStart(2, '0');
  return `${dateStr}T${h}:${m}:00`;
}

function slotIndexFromTime(dateStr, timeStr) {
  if (!timeStr) return 0;
  const d = new Date(timeStr.replace(' ', 'T'));
  const dayStart = new Date(dateStr + 'T00:00:00');
  const diffMs = d.getTime() - dayStart.getTime();
  const slot = Math.round(diffMs / (30 * 60 * 1000));
  return Math.max(0, Math.min(slot, TOTAL_SLOTS - 1));
}

function formatSlotTime(slotIndex) {
  const hours = Math.floor(slotIndex / SLOTS_PER_HOUR);
  const mins = (slotIndex % SLOTS_PER_HOUR) * 30;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

export default function WeekPlanner({
  weekStart,
  shiftList,
  participantsList,
  staffList,
  onCreateShift,
  onUpdateShift,
  onDeleteShift,
  onEditShift
}) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });

  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [pendingDrop, setPendingDrop] = useState(null);
  const [resizing, setResizing] = useState(null);
  const [workerSearch, setWorkerSearch] = useState('');
  const [clientSearch, setClientSearch] = useState('');

  const slotHeight = ZOOM_LEVELS.find((z) => z.value === zoom)?.slotHeight ?? 28;

  const filteredWorkers = workerSearch.trim()
    ? staffList.filter((s) => s.name.toLowerCase().includes(workerSearch.toLowerCase()))
    : staffList;
  const filteredClients = clientSearch.trim()
    ? participantsList.filter((p) => p.name.toLowerCase().includes(clientSearch.toLowerCase()))
    : participantsList;

  const getShiftsForDay = useCallback((day) => {
    const dayStr = toLocalDateStr(day);
    return shiftList.filter((s) => s.start_time?.startsWith(dayStr));
  }, [shiftList]);

  const handleDragStart = (e, type, id, name) => {
    e.dataTransfer.setData('application/json', JSON.stringify({ type, id, name }));
    e.dataTransfer.effectAllowed = 'copy';
    setDragging({ type, id, name });
  };

  const handleDragEnd = () => {
    setDragging(null);
    setDropTarget(null);
  };

  const handleDragOver = (e, dateStr, slotIndex) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = dragging?.type === 'shift' ? 'move' : 'copy';
    setDropTarget({ dateStr, slotIndex });
  };

  const handleDragLeave = () => {
    setDropTarget(null);
  };

  const handleDrop = async (e, dateStr, slotIndex) => {
    e.preventDefault();
    setDropTarget(null);
    try {
      const data = JSON.parse(e.dataTransfer.getData('application/json') || '{}');
      if (!data.type) return;

      if (data.type === 'shift') {
        const { shiftId, durationSlots } = data;
        const shift = shiftList.find((s) => s.id === shiftId);
        if (!shift) return;
        const newStartTime = toSlotTime(dateStr, slotIndex);
        const newEndTime = toSlotTime(dateStr, slotIndex + durationSlots);
        await onUpdateShift(shiftId, { start_time: newStartTime, end_time: newEndTime });
        return;
      }

      if (!data.id) return;
      const startTime = toSlotTime(dateStr, slotIndex);
      const endTime = toSlotTime(dateStr, slotIndex + 2);
      const existing = pendingDrop?.dateStr === dateStr && pendingDrop?.slotIndex === slotIndex ? pendingDrop : null;

      if (data.type === 'worker') {
        const worker = staffList.find((s) => s.id === data.id);
        if (!worker) return;
        if (existing?.participant_id) {
          await onCreateShift({
            participant_id: existing.participant_id,
            staff_id: data.id,
            start_time: startTime,
            end_time: endTime,
            notes: ''
          });
          setPendingDrop(null);
        } else {
          setPendingDrop({ dateStr, slotIndex, staff_id: data.id, staff_name: worker.name, start_time: startTime, end_time: endTime });
        }
      } else if (data.type === 'client') {
        const client = participantsList.find((p) => p.id === data.id);
        if (!client) return;
        if (existing?.staff_id) {
          await onCreateShift({
            participant_id: data.id,
            staff_id: existing.staff_id,
            start_time: startTime,
            end_time: endTime,
            notes: ''
          });
          setPendingDrop(null);
        } else {
          setPendingDrop({ dateStr, slotIndex, participant_id: data.id, participant_name: client.name, start_time: startTime, end_time: endTime });
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setDragging(null);
    }
  };

  const handleResizeStart = (e, shift, direction) => {
    e.preventDefault();
    e.stopPropagation();
    setResizing({ shift, direction, startY: e.clientY, startSlot: slotIndexFromTime(shift.start_time.slice(0, 10), shift.start_time), endSlot: slotIndexFromTime(shift.start_time.slice(0, 10), shift.end_time) });
  };

  useEffect(() => {
    if (!resizing) return;
    const { shift, direction, startY, startSlot, endSlot } = resizing;
    const dateStr = shift.start_time.slice(0, 10);

    const onUp = (e) => {
      const slotH = ZOOM_LEVELS.find((z) => z.value === zoom)?.slotHeight ?? 28;
      const deltaY = e.clientY - startY;
      const slotDelta = Math.round(deltaY / slotH) * (direction === 'down' ? 1 : -1);
      let newStartSlot = startSlot;
      let newEndSlot = endSlot;
      if (direction === 'down') {
        newEndSlot = Math.min(TOTAL_SLOTS, Math.max(endSlot + slotDelta, startSlot + 1));
      } else {
        newStartSlot = Math.max(0, Math.min(startSlot - Math.abs(slotDelta), endSlot - 1));
      }
      const newStartTime = toSlotTime(dateStr, newStartSlot);
      const newEndTime = toSlotTime(dateStr, newEndSlot);
      onUpdateShift(shift.id, { start_time: newStartTime, end_time: newEndTime });
      setResizing(null);
    };

    window.addEventListener('mouseup', onUp);
    return () => window.removeEventListener('mouseup', onUp);
  }, [resizing, onUpdateShift, zoom]);

  const handleShiftDragStart = (e, shift, day) => {
    if (e.target.closest('.week-planner-resize-handle')) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (resizing && resizing.shift?.id === shift.id) {
      e.preventDefault();
      return;
    }
    e.stopPropagation();
    const dateStr = toLocalDateStr(day);
    const startSlot = slotIndexFromTime(dateStr, shift.start_time);
    const endSlot = slotIndexFromTime(dateStr, shift.end_time);
    const durationSlots = Math.max(1, endSlot - startSlot);
    e.dataTransfer.setData('application/json', JSON.stringify({ type: 'shift', shiftId: shift.id, durationSlots }));
    e.dataTransfer.effectAllowed = 'move';
    setDragging({ type: 'shift', id: shift.id });
  };

  const renderShiftCard = (shift, day) => {
    const dateStr = toLocalDateStr(day);
    const startSlot = slotIndexFromTime(dateStr, shift.start_time);
    const endSlot = slotIndexFromTime(dateStr, shift.end_time);
    const span = Math.max(1, endSlot - startSlot);
    const height = span * slotHeight - 2;

    return (
      <div
        key={shift.id}
        className={`week-planner-shift-card ${dragging?.type === 'shift' && dragging?.id === shift.id ? 'dragging' : ''} ${shift.roster_sent_at ? 'week-planner-shift-sent' : ''}`}
        style={{
          top: '2px',
          height: `${height}px`,
          minHeight: Math.max(18, slotHeight - 2)
        }}
        draggable
        onDragStart={(e) => handleShiftDragStart(e, shift, day)}
        onDragEnd={handleDragEnd}
        onClick={(e) => {
          if (e.target.closest('.week-planner-resize-handle') || e.target.closest('.week-planner-shift-remove')) return;
          onEditShift?.(shift);
        }}
      >
        <div className="week-planner-shift-card-inner">
          {shift.roster_sent_at && (
            <span className="week-planner-shift-sent-badge" title="Roster sent">✓</span>
          )}
          <span className="week-planner-shift-worker">{shift.staff_name}</span>
          <span className="week-planner-shift-client">{shift.participant_name}</span>
          {shift.notes && (
            <span className="week-planner-shift-notes" title={shift.notes}>
              {shift.notes.length > 30 ? shift.notes.slice(0, 30) + '…' : shift.notes}
            </span>
          )}
        </div>
        <button
          type="button"
          className="week-planner-shift-remove"
          onClick={(e) => { e.stopPropagation(); onDeleteShift?.(shift); }}
          title="Delete shift"
        >
          ×
        </button>
        <div
          className="week-planner-resize-handle"
          onMouseDown={(e) => handleResizeStart(e, shift, 'down')}
          title="Drag to extend shift"
        />
      </div>
    );
  };

  return (
    <div className="week-planner">
      <div className="week-planner-sidebar">
        <div className="week-planner-palette-section">
          <h4>Workers</h4>
          <input
            type="text"
            placeholder="Search workers..."
            value={workerSearch}
            onChange={(e) => setWorkerSearch(e.target.value)}
            className="week-planner-search"
          />
          {filteredWorkers.map((s) => (
            <div
              key={s.id}
              className={`week-planner-draggable worker ${dragging?.id === s.id ? 'dragging' : ''}`}
              draggable
              onDragStart={(e) => handleDragStart(e, 'worker', s.id, s.name)}
              onDragEnd={handleDragEnd}
            >
              {s.name}
            </div>
          ))}
        </div>
        <div className="week-planner-palette-section">
          <h4>Clients</h4>
          <input
            type="text"
            placeholder="Search clients..."
            value={clientSearch}
            onChange={(e) => setClientSearch(e.target.value)}
            className="week-planner-search"
          />
          {filteredClients.map((p) => (
            <div
              key={p.id}
              className={`week-planner-draggable client ${dragging?.id === p.id ? 'dragging' : ''}`}
              draggable
              onDragStart={(e) => handleDragStart(e, 'client', p.id, p.name)}
              onDragEnd={handleDragEnd}
            >
              {p.name}
            </div>
          ))}
        </div>
        <p className="week-planner-hint">Drag worker + client onto a time slot to create a shift. Drag a shift to move it. Resize handle to extend.</p>
        <div className="week-planner-zoom">
          <label>
            <span className="week-planner-zoom-label">Zoom</span>
            <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="week-planner-zoom-select">
              {ZOOM_LEVELS.map((z) => (
                <option key={z.value} value={z.value}>{z.label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="week-planner-grid-wrap">
        <div
          className={`week-planner-grid ${zoom <= 0.75 ? 'week-planner-zoom-out' : ''}`}
          style={{
            gridTemplateRows: `${zoom <= 0.75 ? 28 : 40}px repeat(${TOTAL_SLOTS}, ${slotHeight}px)`
          }}
        >
          <div className="week-planner-header-row">
            <div className="week-planner-time-col week-planner-time-header">Time</div>
            {days.map((day) => (
              <div key={day.toISOString()} className="week-planner-day-col">
                <span className="week-planner-day-name">
                  {day.toLocaleDateString('en-AU', { weekday: 'short' })}
                </span>
                <span className="week-planner-day-date">
                  {formatDate(day)}
                </span>
              </div>
            ))}
          </div>

          {Array.from({ length: TOTAL_SLOTS }, (_, slotIndex) => (
            <div key={slotIndex} className="week-planner-row">
              <div className="week-planner-time-col">
                {formatSlotTime(slotIndex)}
              </div>
              {days.map((day) => {
                const dateStr = toLocalDateStr(day);
                const shifts = getShiftsForDay(day);
                const isDropTarget =
                  dropTarget?.dateStr === dateStr && dropTarget?.slotIndex === slotIndex;

                const hasPending = pendingDrop?.dateStr === dateStr && pendingDrop?.slotIndex === slotIndex;
                const pendingHint = hasPending
                  ? (pendingDrop.staff_id ? 'Drop client' : 'Drop worker')
                  : null;

                return (
                  <div
                    key={`${dateStr}-${slotIndex}`}
                    className={`week-planner-cell ${isDropTarget ? 'drop-over' : ''} ${hasPending ? 'has-pending' : ''}`}
                    onDragOver={(e) => handleDragOver(e, dateStr, slotIndex)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, dateStr, slotIndex)}
                  >
                    {hasPending && (
                      <div className="week-planner-pending-hint">
                        {pendingDrop.staff_name || pendingDrop.participant_name}
                        <br />
                        <small>{pendingHint}</small>
                      </div>
                    )}
                    {shifts
                      .filter((s) => {
                        const sStart = slotIndexFromTime(dateStr, s.start_time);
                        const sEnd = slotIndexFromTime(dateStr, s.end_time);
                        return slotIndex >= sStart && slotIndex < sEnd && slotIndex === sStart;
                      })
                      .map((s) => renderShiftCard(s, day))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
