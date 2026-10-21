"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { dateFromKey, getLocalDateKey, isCompletionDateKey, weekdayNames } from "../../quest-logic";
import {
  getCalendarGridDays,
  shiftCalendarDateByDays,
  shiftCalendarDateByMonths,
} from "./quest-date-picker-logic";

type CalendarPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

type QuestDatePickerProps = {
  id: string;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
};

function monthStart(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1, 12);
}

function monthLabel(date: Date) {
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function dateLabel(dateKey: string) {
  return dateFromKey(dateKey).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function QuestDatePicker({ id, label, value, onValueChange }: QuestDatePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [displayedMonth, setDisplayedMonth] = useState(() => monthStart(new Date()));
  const [focusedDateKey, setFocusedDateKey] = useState(() => getLocalDateKey(new Date()));
  const [position, setPosition] = useState<CalendarPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const calendarRef = useRef<HTMLDivElement>(null);
  const todayKey = getLocalDateKey(new Date());
  const validValue = isCompletionDateKey(value);
  const calendarId = `${id}-calendar`;
  const headingId = `${id}-month-heading`;
  const gridDays = getCalendarGridDays(displayedMonth.getFullYear(), displayedMonth.getMonth());
  const gridWeeks = Array.from({ length: gridDays.length / 7 }, (_, index) =>
    gridDays.slice(index * 7, index * 7 + 7),
  );

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const maxHeight = Math.max(0, Math.min(420, window.innerHeight - 24));
    const width = Math.min(320, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const availableBelow = window.innerHeight - rect.bottom - 12;
    const availableAbove = rect.top - 12;
    const placeAbove = availableBelow < 390 && availableAbove > availableBelow;
    const top = placeAbove
      ? Math.max(12, rect.top - maxHeight - 8)
      : Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - maxHeight - 12));

    setPosition({ top, left, width, maxHeight });
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    updatePosition();
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !calendarRef.current?.contains(target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen || !position) return;
    document.getElementById(`${id}-day-${focusedDateKey}`)?.focus({ preventScroll: true });
  }, [focusedDateKey, id, isOpen, position]);

  function openCalendar() {
    const initialDateKey = validValue ? value : getLocalDateKey(new Date());
    const initialDate = dateFromKey(initialDateKey);
    setDisplayedMonth(monthStart(initialDate));
    setFocusedDateKey(initialDateKey);
    setPosition(null);
    setIsOpen(true);
  }

  function closeCalendar(returnFocus: boolean) {
    setIsOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function showMonthForDate(dateKey: string) {
    const date = dateFromKey(dateKey);
    setDisplayedMonth(monthStart(date));
    setFocusedDateKey(dateKey);
  }

  function turnMonth(amount: number) {
    showMonthForDate(shiftCalendarDateByMonths(focusedDateKey, amount));
  }

  function selectDate(dateKey: string) {
    onValueChange(dateKey);
    closeCalendar(true);
  }

  function handleCalendarKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCalendar(true);
    }
  }

  function handleCalendarBlur(event: FocusEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget;
    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
      setIsOpen(false);
    }
  }

  function handleDayKeyDown(event: KeyboardEvent<HTMLButtonElement>, dateKey: string) {
    let nextDateKey: string | undefined;
    if (event.key === "ArrowLeft") nextDateKey = shiftCalendarDateByDays(dateKey, -1);
    if (event.key === "ArrowRight") nextDateKey = shiftCalendarDateByDays(dateKey, 1);
    if (event.key === "ArrowUp") nextDateKey = shiftCalendarDateByDays(dateKey, -7);
    if (event.key === "ArrowDown") nextDateKey = shiftCalendarDateByDays(dateKey, 7);
    if (event.key === "Home" || event.key === "End") {
      const weekdayOffset = (dateFromKey(dateKey).getDay() + 6) % 7;
      nextDateKey = shiftCalendarDateByDays(dateKey, event.key === "Home" ? -weekdayOffset : 6 - weekdayOffset);
    }
    if (event.key === "PageUp") nextDateKey = shiftCalendarDateByMonths(dateKey, event.shiftKey ? -12 : -1);
    if (event.key === "PageDown") nextDateKey = shiftCalendarDateByMonths(dateKey, event.shiftKey ? 12 : 1);

    if (nextDateKey) {
      event.preventDefault();
      showMonthForDate(nextDateKey);
    }
  }

  return (
    <div className="quest-date-picker" ref={rootRef}>
      <button
        aria-label={label}
        aria-controls={calendarId}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className="quest-date-picker-trigger"
        id={id}
        onClick={() => (isOpen ? closeCalendar(false) : openCalendar())}
        ref={triggerRef}
        type="button"
      >
        <span className={validValue ? "" : "quest-date-picker-placeholder"}>
          {validValue ? dateLabel(value) : "Choose a date"}
        </span>
        <svg aria-hidden="true" className="quest-date-picker-icon" viewBox="0 0 16 16">
          <path d="M3 2v3M13 2v3M2 5h12M3 3h10a1 1 0 0 1 1 1v9H2V4a1 1 0 0 1 1-1Z" />
          <path d="M5 8h1M8 8h1M11 8h1M5 11h1M8 11h1" />
        </svg>
      </button>

      {isOpen && position && createPortal(
        <div
          aria-labelledby={headingId}
          className="quest-date-calendar"
          id={calendarId}
          onBlur={handleCalendarBlur}
          onKeyDown={handleCalendarKeyDown}
          ref={calendarRef}
          role="dialog"
          style={position}
        >
          <div className="quest-date-calendar-header">
            <button
              aria-label="Previous month"
              className="quest-date-month-button"
              onClick={() => turnMonth(-1)}
              type="button"
            >
              <span aria-hidden="true">‹</span>
            </button>
            <h2 id={headingId}>{monthLabel(displayedMonth)}</h2>
            <button
              aria-label="Next month"
              className="quest-date-month-button"
              onClick={() => turnMonth(1)}
              type="button"
            >
              <span aria-hidden="true">›</span>
            </button>
          </div>

          <div aria-label={monthLabel(displayedMonth)} className="quest-date-grid" role="grid">
            <div className="quest-date-week quest-date-weekdays" role="row">
              {weekdayNames.map((day) => (
                <span aria-label={day} key={day} role="columnheader">{day.slice(0, 2)}</span>
              ))}
            </div>
            {gridWeeks.map((week, weekIndex) => (
              <div className="quest-date-week" key={`${displayedMonth.getMonth()}-${weekIndex}`} role="row">
                {week.map((day) => {
                  const isToday = day.dateKey === todayKey;
                  const isSelected = validValue && day.dateKey === value;
                  const dayLabel = dateFromKey(day.dateKey).toLocaleDateString(undefined, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  });
                  return (
                    <div
                      aria-selected={isSelected}
                      className="quest-date-cell"
                      key={day.dateKey}
                      role="gridcell"
                    >
                      <button
                        aria-current={isToday ? "date" : undefined}
                        aria-label={dayLabel}
                        aria-pressed={isSelected}
                        className={`quest-date-day${day.isCurrentMonth ? "" : " is-outside-month"}${isToday ? " is-today" : ""}${isSelected ? " is-selected" : ""}`}
                        id={`${id}-day-${day.dateKey}`}
                        onClick={() => selectDate(day.dateKey)}
                        onKeyDown={(event) => handleDayKeyDown(event, day.dateKey)}
                        tabIndex={focusedDateKey === day.dateKey ? 0 : -1}
                        type="button"
                      >
                        {day.dayOfMonth}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="quest-date-calendar-footer">
            <span>{validValue ? `Selected: ${dateLabel(value)}` : "No due date selected"}</span>
            {value && (
              <button
                className="quest-date-clear"
                onClick={() => {
                  onValueChange("");
                  closeCalendar(true);
                }}
                type="button"
              >
                Clear date
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
