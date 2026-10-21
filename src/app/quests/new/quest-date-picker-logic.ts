import { addCalendarDays, dateFromKey, getLocalDateKey } from "../../quest-logic";

export type CalendarGridDay = {
  dateKey: string;
  dayOfMonth: number;
  isCurrentMonth: boolean;
};

export function getCalendarGridDays(year: number, monthIndex: number): CalendarGridDay[] {
  const firstOfMonth = new Date(year, monthIndex, 1, 12);
  const mondayFirstOffset = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(year, monthIndex + 1, 0, 12).getDate();
  const cellCount = Math.ceil((mondayFirstOffset + daysInMonth) / 7) * 7;

  return Array.from({ length: cellCount }, (_, index) => {
    const date = new Date(year, monthIndex, 1 - mondayFirstOffset + index, 12);
    return {
      dateKey: getLocalDateKey(date),
      dayOfMonth: date.getDate(),
      isCurrentMonth: date.getMonth() === monthIndex,
    };
  });
}

export function shiftCalendarDateByDays(dateKey: string, amount: number): string {
  return getLocalDateKey(addCalendarDays(dateFromKey(dateKey), amount));
}

export function shiftCalendarDateByMonths(dateKey: string, amount: number): string {
  const date = dateFromKey(dateKey);
  const targetMonth = new Date(date.getFullYear(), date.getMonth() + amount, 1, 12);
  const lastDay = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0, 12).getDate();
  return getLocalDateKey(new Date(
    targetMonth.getFullYear(),
    targetMonth.getMonth(),
    Math.min(date.getDate(), lastDay),
    12,
  ));
}
