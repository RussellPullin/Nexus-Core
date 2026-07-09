/**
 * Simple Week Planner - drag worker + client onto 30-minute grid to create shifts.
 * Resize shift cards to extend duration in 30-minute increments.
 * Notes on shifts are sent to workers when roster is sent.
 */
import { useState, useEffect, useRef, useMemo } from 'react';
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

function buildShiftLayouts(shifts, dateStr) {
  const sorted = shifts
    .map((shift) => {
      const startSlot = slotIndexFromTime(dateStr, shift.start_time);
      const rawEndSlot = slotIndexFromTime(dateStr, shift.end_time);
      const endSlot = Math.min(TOTAL_SLOTS, Math.max(startSlot + 1, rawEndSlot));
      return { shift, startSlot, endSlot };
    })
    .sort((a, b) => (
      a.startSlot - b.startSlot ||
      a.endSlot - b.endSlot ||
      String(a.shift.id).localeCompare(String(b.shift.id))
    ));

  const layouts = new Map();
  let cluster = [];
  let clusterEnd = -1;

  const finishCluster = () => {
    if (!cluster.length) return;

    const laneEnds = [];
    const clusterLayouts = [];

    cluster.forEach((item) => {
      let lane = laneEnds.findIndex((end) => end <= item.startSlot);
      if (lane === -1) {
        lane = laneEnds.length;
      }
      laneEnds[lane] = item.endSlot;
      clusterLayouts.push({ ...item, lane });
    });

    const laneCount = Math.max(1, laneEnds.length);
    clusterLayouts.forEach((item) => {
      layouts.set(item.shift.id, {
        lane: item.lane,
        laneCount,
        startSlot: item.startSlot,
        endSlot: item.endSlot
      });
    });
  };

  sorted.forEach((item) => {
    if (!cluster.length || item.startSlot < clusterEnd) {
      cluster.push(item);
      clusterEnd = Math.max(clusterEnd, item.endSlot);
      return;
    }

    finishCluster();
    cluster = [item];
    clusterEnd = item.endSlot;
  });

  finishCluster();
  return layouts;
}

export default function WeekPlanner({
  weekStart,
  shiftList,
  participantsList,
  staffList,
  onCreateShift,
  onCreateOpenShift,
  onUpdateShift,
  onDeleteShift,
  onEditShift
}) {
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  }), [weekStart]);

  const [zoom, setZoom] = useState(0.75);
  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [pendingDrop, setPendingDrop] = useState(null);
  const [resizing, setResizing] = useState(null);
  const [workerSearch, setWorkerSearch] = useState('');
  const [clientSearch, setClientSearch] = useState('');
  const gridWrapRef = useRef(null);
  const sidebarScrollRef = useRef(null);

  const slotHeight = ZOOM_LEVELS.find((z) => z.value === zoom)?.slotHeight ?? 28;

  const filteredWorkers = workerSearch.trim()
    ? staffList.filter((s) => s.name.toLowerCase().includes(workerSearch.toLowerCase()))
    : staffList;
  const filteredClients = clientSearch.trim()
    ? participantsList.filter((p) => p.name.toLowerCase().includes(clientSearch.toLowerCase()))
    : participantsList;

  const shiftsByDay = useMemo(() => {
    const byDay = new Map();
    days.forEach((day) => {
      const dateStr = toLocalDateStr(day);
      byDay.set(dateStr, shiftList.filter((s) => s.start_time?.startsWith(dateStr)));
    });
    return byDay;
  }, [days, shiftList]);

  const shiftLayoutsByDay = useMemo(() => {
    const byDay = new Map();
    shiftsByDay.forEach((shifts, dateStr) => {
      byDay.set(dateStr, buildShiftLayouts(shifts, dateStr));
    });
    return byDay;
  }, [shiftsByDay]);

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

  const handleCreateOpenShiftFromPending = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!pendingDrop?.participant_id || pendingDrop.staff_id) return;
    if (!onCreateOpenShift) return;
    await onCreateOpenShift({
      participant_id: pendingDrop.participant_id,
      start_time: pendingDrop.start_time,
      end_time: pendingDrop.end_time,
      notes: ''
    });
    setPendingDrop(null);
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

  const handleShiftCardDrop = async (e, targetShift) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);

    try {
      const data = JSON.parse(e.dataTransfer.getData('application/json') || '{}');
      if (!data.type) return;

      if (data.type === 'shift') {
        const { shiftId, durationSlots } = data;
        const dateStr = targetShift.start_time?.slice(0, 10);
        if (!shiftId || !dateStr) return;
        const startSlot = slotIndexFromTime(dateStr, targetShift.start_time);
        const duration = Math.max(1, Number(durationSlots) || 1);
        await onUpdateShift(shiftId, {
          start_time: toSlotTime(dateStr, startSlot),
          end_time: toSlotTime(dateStr, startSlot + duration)
        });
        return;
      }

      if (!data.id) return;

      if (data.type === 'worker' && targetShift.participant_id) {
        if (!targetShift.staff_id || targetShift.status === 'open') {
          await onUpdateShift(targetShift.id, {
            staff_id: data.id,
            status: 'scheduled'
          });
          setPendingDrop(null);
          return;
        }
        await onCreateShift({
          participant_id: targetShift.participant_id,
          staff_id: data.id,
          start_time: targetShift.start_time,
          end_time: targetShift.end_time,
          notes: ''
        });
        setPendingDrop(null);
      } else if (data.type === 'client' && targetShift.staff_id) {
        await onCreateShift({
          participant_id: data.id,
          staff_id: targetShift.staff_id,
          start_time: targetShift.start_time,
          end_time: targetShift.end_time,
          notes: ''
        });
        setPendingDrop(null);
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

  // Auto-scroll grid (and palette) when dragging near edges — avoids long drags across the page.
  useEffect(() => {
    if (!dragging) return;
    const onDragOver = (e) => {
      const y = e.clientY;
      const margin = 72;
      const step = 14;
      const grid = gridWrapRef.current;
      if (grid) {
        const gr = grid.getBoundingClientRect();
        if (y > gr.bottom - margin) grid.scrollTop += step;
        else if (y < gr.top + margin) grid.scrollTop -= step;
      }
      const side = sidebarScrollRef.current;
      if (side) {
        const sr = side.getBoundingClientRect();
        if (y > sr.bottom - margin) side.scrollTop += step;
        else if (y < sr.top + margin) side.scrollTop -= step;
      }
    };
    document.addEventListener('dragover', onDragOver);
    return () => document.removeEventListener('dragover', onDragOver);
  }, [dragging]);

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

  const renderShiftCard = (shift, day, layout) => {
    const isOpen = shift.status === 'open' || !shift.staff_id;
    const dateStr = toLocalDateStr(day);
    const startSlot = slotIndexFromTime(dateStr, shift.start_time);
    const endSlot = slotIndexFromTime(dateStr, shift.end_time);
    const span = Math.max(1, endSlot - startSlot);
    const height = span * slotHeight - 2;
    const laneCount = layout?.laneCount || 1;
    const lane = layout?.lane || 0;
    const laneGap = laneCount > 1 ? 2 : 0;
    const width = laneCount > 1 ? `calc(${100 / laneCount}% - ${laneGap}px)` : undefined;
    const left = laneCount > 1 ? `calc(${lane * (100 / laneCount)}% + ${lane ? laneGap / 2 : 0}px)` : '2px';

    return (
      <div
        key={shift.id}
        className={`week-planner-shift-card ${isOpen ? 'week-planner-shift-open' : ''} ${dragging?.type === 'shift' && dragging?.id === shift.id ? 'dragging' : ''} ${shift.roster_sent_at ? 'week-planner-shift-sent' : ''}`}
        style={{
          left,
          right: laneCount > 1 ? 'auto' : '2px',
          width,
          top: '2px',
          height: `${height}px`,
          minHeight: Math.max(18, slotHeight - 2)
        }}
        draggable
        onDragOver={(e) => handleDragOver(e, dateStr, startSlot)}
        onDragLeave={handleDragLeave}
        onDrop={(e) => handleShiftCardDrop(e, shift)}
        onDragStart={(e) => handleShiftDragStart(e, shift, day)}
        onDragEnd={handleDragEnd}
        onClick={(e) => {
          if (e.target.closest('.week-planner-resize-handle') || e.target.closest('.week-planner-shift-remove')) return;
          onEditShift?.(shift);
        }}
      >
        <div className="week-planner-shift-card-inner">
          {shift.invoice_number && (
            <span
              className="week-planner-shift-invoice-badge"
              title={`Invoiced: ${shift.invoice_number}${shift.invoice_status ? ` (${shift.invoice_status})` : ''}`}
            >
              {shift.invoice_number.length > 10 ? `${shift.invoice_number.slice(0, 8)}…` : shift.invoice_number}
            </span>
          )}
          {shift.open_shift_broadcast_at && (
            <span className="week-planner-shift-sent-badge" title="Sent to staff as available">📢</span>
          )}
          {shift.roster_sent_at && (
            <span className="week-planner-shift-sent-badge" title="Roster sent">✓</span>
          )}
          <span className="week-planner-shift-worker">{isOpen ? 'Available shift' : shift.staff_name}</span>
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
        <div className="week-planner-sidebar-scroll" ref={sidebarScrollRef}>
          <div className="week-planner-palette-section">
            <h4>Workers</h4>
            <input
              type="text"
              placeholder="Search workers…"
              value={workerSearch}
              onChange={(e) => setWorkerSearch(e.target.value)}
              className="week-planner-search"
            />
            <div className="week-planner-palette-list">
              {filteredWorkers.map((s) => (
                <div
                  key={s.id}
                  className={`week-planner-draggable worker ${dragging?.id === s.id ? 'dragging' : ''}`}
                  draggable
                  onDragStart={(e) => handleDragStart(e, 'worker', s.id, s.name)}
                  onDragEnd={handleDragEnd}
                  title={s.name}
                >
                  {s.name}
                </div>
              ))}
            </div>
          </div>
          <div className="week-planner-palette-section week-planner-palette-section-clients">
            <h4>Clients</h4>
            <input
              type="text"
              placeholder="Search to narrow list…"
              value={clientSearch}
              onChange={(e) => setClientSearch(e.target.value)}
              className="week-planner-search"
            />
            <div className="week-planner-palette-list week-planner-palette-list-clients">
              {filteredClients.map((p) => (
                <div
                  key={p.id}
                  className={`week-planner-draggable client ${dragging?.id === p.id ? 'dragging' : ''}`}
                  draggable
                  onDragStart={(e) => handleDragStart(e, 'client', p.id, p.name)}
                  onDragEnd={handleDragEnd}
                  title={p.name}
                >
                  {p.name}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="week-planner-sidebar-footer">
          <p className="week-planner-hint">Drag worker + client onto a slot, or drop a client and post as an available shift. Move shifts by dragging; extend with the bottom handle.</p>
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
      </div>

      <div className="week-planner-grid-wrap" ref={gridWrapRef}>
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
                const shifts = shiftsByDay.get(dateStr) || [];
                const layouts = shiftLayoutsByDay.get(dateStr);
                const isDropTarget =
                  dropTarget?.dateStr === dateStr && dropTarget?.slotIndex === slotIndex;

                const hasPending = pendingDrop?.dateStr === dateStr && pendingDrop?.slotIndex === slotIndex;
                const pendingHint = hasPending
                  ? (pendingDrop.staff_id ? 'Drop client' : 'Drop worker or post below')
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
                        {!pendingDrop.staff_id && onCreateOpenShift && (
                          <button
                            type="button"
                            className="week-planner-post-open-btn"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={handleCreateOpenShiftFromPending}
                          >
                            Post as available shift
                          </button>
                        )}
                      </div>
                    )}
                    {shifts
                      .filter((s) => {
                        const sStart = slotIndexFromTime(dateStr, s.start_time);
                        const sEnd = slotIndexFromTime(dateStr, s.end_time);
                        return slotIndex >= sStart && slotIndex < sEnd && slotIndex === sStart;
                      })
                      .map((s) => renderShiftCard(s, day, layouts?.get(s.id)))}
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
