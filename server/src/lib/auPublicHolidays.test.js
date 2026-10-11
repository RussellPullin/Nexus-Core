import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAuPublicHoliday,
  isAuPublicHoliday,
  isBrisbaneShowArea,
  joinServiceLocation,
  resolveAuStateFromLocation,
  resolveShiftLocationState,
  splitServiceLocation,
} from '../../../shared/auPublicHolidays.js';
import { getShiftDayType } from './ndisDay.js';
import { computeHoursFromShifts } from '../services/shiftHours.service.js';

const QLD_GOLD_COAST = '11 Crest View Key, Broadbeach Waters, QLD, 4218';
const QLD_BRISBANE = 'unit 6/77 Carselgrove Avenue, Fitzgibbon, QLD, 4018';
const NSW_ADDRESS = '4 Coolabah Court, Banora Point, NSW, 2486';
const VIC_ADDRESS = '14 Wattle Lane, Richmond VIC 3121';

describe('Australian public holidays by state', () => {
  test('5 October 2026 is the Queensland King\'s Birthday', () => {
    const holiday = getAuPublicHoliday('2026-10-05', 'QLD');
    assert.equal(holiday?.name, "King's Birthday");
    assert.equal(getShiftDayType('2026-10-05T09:00:00', 'QLD'), 'public_holiday');
    assert.equal(getShiftDayType('2026-10-05T09:00:00', QLD_GOLD_COAST), 'public_holiday');
  });

  test('5 October 2026 is Labour Day in NSW, SA and the ACT, and a normal Monday elsewhere', () => {
    assert.equal(getAuPublicHoliday('2026-10-05', 'NSW')?.name, 'Labour Day');
    assert.equal(getAuPublicHoliday('2026-10-05', 'SA')?.name, 'Labour Day');
    assert.equal(getAuPublicHoliday('2026-10-05', 'ACT')?.name, 'Labour Day');
    assert.equal(getAuPublicHoliday('2026-10-05', 'VIC'), null);
    assert.equal(getAuPublicHoliday('2026-10-05', 'WA'), null);
    assert.equal(getAuPublicHoliday('2026-10-05', 'TAS'), null);
    assert.equal(getAuPublicHoliday('2026-10-05', 'NT'), null);
    assert.equal(getShiftDayType('2026-10-05T09:00:00', VIC_ADDRESS), 'weekday');
    assert.equal(getShiftDayType('2026-10-05T09:00:00', NSW_ADDRESS), 'public_holiday');
  });

  test('June King\'s Birthday is not a Queensland holiday', () => {
    assert.equal(getAuPublicHoliday('2026-06-08', 'NSW')?.name, "King's Birthday");
    assert.equal(getAuPublicHoliday('2026-06-08', 'QLD'), null);
    assert.equal(getShiftDayType('2026-06-08T09:00:00', 'QLD'), 'weekday');
  });

  test('Western Australia King\'s Birthday is the last Monday in September', () => {
    assert.equal(getAuPublicHoliday('2026-09-28', 'WA')?.name, "King's Birthday");
    assert.equal(getAuPublicHoliday('2026-09-28', 'QLD'), null);
  });

  test('a Saturday public holiday stays a public holiday rather than Saturday', () => {
    assert.equal(getShiftDayType('2026-04-25T09:00:00', 'QLD'), 'public_holiday');
  });

  test('part-day Christmas Eve applies only from the holiday start time', () => {
    assert.equal(isAuPublicHoliday('2026-12-24', 'QLD', { startMinutes: 17 * 60 }), false);
    assert.equal(isAuPublicHoliday('2026-12-24', 'QLD', { startMinutes: 18 * 60 }), true);
    assert.equal(getShiftDayType('2026-12-24T14:00:00', 'QLD'), 'weekday');
    assert.equal(getShiftDayType('2026-12-24T18:30:00', 'QLD'), 'public_holiday');
  });

  test('Ekka applies in Brisbane and not on the Gold Coast', () => {
    assert.equal(isBrisbaneShowArea(QLD_BRISBANE), true);
    assert.equal(isBrisbaneShowArea(QLD_GOLD_COAST), false);
    assert.equal(isBrisbaneShowArea('39/45 Shore Street East, Cleveland, QLD, 4163'), false);
    assert.equal(getShiftDayType('2026-08-12T09:00:00', QLD_BRISBANE), 'public_holiday');
    assert.equal(getShiftDayType('2026-08-12T09:00:00', QLD_GOLD_COAST), 'weekday');
  });

  test('reads the state from an address or a postcode when the state is not written out', () => {
    assert.equal(resolveAuStateFromLocation(VIC_ADDRESS), 'VIC');
    assert.equal(resolveAuStateFromLocation('Po Box 460, Sanctuary cove, 4212'), 'QLD');
    assert.equal(resolveAuStateFromLocation('Level 2, 100 Harbour Street, Melbourne VIC 3000'), 'VIC');
    assert.equal(resolveShiftLocationState({
      participant_address: '',
      org_address: 'Po Box 460, Sanctuary cove, 4212',
    }), 'QLD');
    assert.equal(joinServiceLocation('Capalaba', 'QLD'), 'Capalaba, QLD');
    assert.deepEqual(splitServiceLocation('Capalaba, QLD'), { place: 'Capalaba', state: 'QLD' });
  });

  test('without a state, only holidays observed in every state count', () => {
    assert.equal(isAuPublicHoliday('2026-12-25', null), true);
    assert.equal(isAuPublicHoliday('2026-10-05', null), false);
  });
});

describe('completed shift hours use the client address', () => {
  test('Queensland client on 5 October 2026 is public holiday time', () => {
    const rows = computeHoursFromShifts([
      {
        start_time: '2026-10-05T09:00:00',
        end_time: '2026-10-05T13:00:00',
        participant_address: QLD_GOLD_COAST,
      },
    ], { payPeriodStart: '2026-09-28' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].holidayHours, 4);
    assert.equal(rows[0].weekdayHours, 0);
  });

  test('the client address wins over a shift location in another state', () => {
    const rows = computeHoursFromShifts([
      {
        start_time: '2026-10-05T09:00:00',
        end_time: '2026-10-05T13:00:00',
        participant_address: QLD_GOLD_COAST,
        service_location: VIC_ADDRESS,
      },
    ], { payPeriodStart: '2026-09-28' });
    assert.equal(rows[0].holidayHours, 4);
    assert.equal(rows[0].weekdayHours, 0);
  });

  test('a shift location alone does not set the public holiday state', () => {
    const rows = computeHoursFromShifts([
      {
        start_time: '2026-10-05T09:00:00',
        end_time: '2026-10-05T13:00:00',
        service_location: QLD_GOLD_COAST,
      },
    ], { payPeriodStart: '2026-09-28' });
    assert.equal(rows[0].holidayHours, 0);
    assert.equal(rows[0].weekdayHours, 4);
  });

  test('Victoria client on 5 October 2026 stays weekday time', () => {
    const rows = computeHoursFromShifts([
      {
        start_time: '2026-10-05T09:00:00',
        end_time: '2026-10-05T13:00:00',
        participant_address: VIC_ADDRESS,
      },
    ], { payPeriodStart: '2026-09-28' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].holidayHours, 0);
    assert.equal(rows[0].weekdayHours, 4);
  });
});
