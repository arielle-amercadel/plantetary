import { addCalendarDays, dateFromKey, getLocalDateKey, isCompletionDateKey, localNoonDate } from "../../quest-logic";

export type CalendarGridDay = {
  dateKey: string;
  dayOfMonth: number;
  isCurrentMonth: boolean;
};

const FIRST_SUPPORTED_DATE_KEY = "0001-01-01";
const LAST_SUPPORTED_DATE_KEY = "9999-12-31";

function supportedDateKey(date: Date): string {
  if (date.getFullYear() < 1) return FIRST_SUPPORTED_DATE_KEY;
  if (date.getFullYear() > 9999) return LAST_SUPPORTED_DATE_KEY;
  return getLocalDateKey(date);
}

export function canTurnCalendarMonth(year: number, monthIndex: number, amount: number): boolean {
  return isCompletionDateKey(getLocalDateKey(localNoonDate(year, monthIndex + amount, 1)));
}

/** An empty due date is allowed. Anything else must be a real date in the supported range. */
export function isSavableDueDate(dueDate: string): boolean {
  return dueDate === "" || isCompletionDateKey(dueDate);
}

export function getCalendarGridDays(year: number, monthIndex: number): CalendarGridDay[] {
  const firstOfMonth = localNoonDate(year, monthIndex, 1);
  const mondayFirstOffset = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = localNoonDate(year, monthIndex + 1, 0).getDate();
  const cellCount = Math.ceil((mondayFirstOffset + daysInMonth) / 7) * 7;

  return Array.from({ length: cellCount }, (_, index) => {
    const date = localNoonDate(year, monthIndex, 1 - mondayFirstOffset + index);
    return {
      dateKey: getLocalDateKey(date),
      dayOfMonth: date.getDate(),
      isCurrentMonth: date.getMonth() === monthIndex,
    };
  });
}

export function shiftCalendarDateByDays(dateKey: string, amount: number): string {
  return supportedDateKey(addCalendarDays(dateFromKey(dateKey), amount));
}

export function shiftCalendarDateByMonths(dateKey: string, amount: number): string {
  const date = dateFromKey(dateKey);
  const targetMonth = localNoonDate(date.getFullYear(), date.getMonth() + amount, 1);
  const lastDay = localNoonDate(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0).getDate();
  return supportedDateKey(localNoonDate(
    targetMonth.getFullYear(),
    targetMonth.getMonth(),
    Math.min(date.getDate(), lastDay),
  ));
}
