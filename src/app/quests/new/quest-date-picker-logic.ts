import { addCalendarDays, dateFromKey, getLocalDateKey, localNoonDate } from "../../quest-logic";

export type CalendarGridDay = {
  dateKey: string;
  dayOfMonth: number;
  isCurrentMonth: boolean;
};

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
  return getLocalDateKey(addCalendarDays(dateFromKey(dateKey), amount));
}

export function shiftCalendarDateByMonths(dateKey: string, amount: number): string {
  const date = dateFromKey(dateKey);
  const targetMonth = localNoonDate(date.getFullYear(), date.getMonth() + amount, 1);
  const lastDay = localNoonDate(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0).getDate();
  return getLocalDateKey(localNoonDate(
    targetMonth.getFullYear(),
    targetMonth.getMonth(),
    Math.min(date.getDate(), lastDay),
  ));
}
