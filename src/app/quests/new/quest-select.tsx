"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

export type QuestSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type QuestSelectProps = {
  id: string;
  label: string;
  value: string;
  options: QuestSelectOption[];
  placeholder: string;
  disabled?: boolean;
  required?: boolean;
  onValueChange: (value: string) => void;
};

type MenuPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

export default function QuestSelect({
  id,
  label,
  value,
  options,
  placeholder,
  disabled = false,
  required = false,
  onValueChange,
}: QuestSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = `${id}-options`;
  const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const findEnabledIndex = useCallback((start: number, direction: 1 | -1) => {
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (start + direction * offset + options.length * 2) % options.length;
      if (!options[index].disabled) return index;
    }
    return -1;
  }, [options]);

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const maxHeight = Math.max(120, Math.min(280, window.innerHeight - 24));
    const estimatedHeight = Math.min(options.length * 42 + 12, maxHeight);
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const placeAbove = below < estimatedHeight && above > below;
    const width = Math.min(rect.width, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const top = placeAbove
      ? Math.max(12, rect.top - estimatedHeight - 6)
      : Math.min(window.innerHeight - maxHeight - 12, rect.bottom + 6);

    setMenuPosition({ top, left, width, maxHeight });
  }, [options.length]);

  useEffect(() => {
    if (!isOpen) return;

    updateMenuPosition();
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [isOpen, updateMenuPosition]);

  useEffect(() => {
    if (!isOpen || activeIndex < 0) return;
    document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, id, isOpen]);

  function openMenu(index = selectedIndex) {
    const fallback = findEnabledIndex(index >= 0 ? index : 0, 1);
    setActiveIndex(index >= 0 && !options[index]?.disabled ? index : fallback);
    setIsOpen(true);
  }

  function chooseOption(option: QuestSelectOption) {
    if (option.disabled) return;
    onValueChange(option.value);
    setIsOpen(false);
    triggerRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      if (!isOpen) {
        const start = selectedIndex >= 0
          ? selectedIndex + direction
          : direction === 1 ? 0 : options.length - 1;
        openMenu(findEnabledIndex(start, direction));
      } else {
        const start = activeIndex >= 0 ? activeIndex + direction : direction === 1 ? 0 : options.length - 1;
        setActiveIndex(findEnabledIndex(start, direction));
      }
      return;
    }

    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const direction = event.key === "Home" ? 1 : -1;
      const start = direction === 1 ? 0 : options.length - 1;
      const index = findEnabledIndex(start, direction);
      if (!isOpen) setIsOpen(true);
      setActiveIndex(index);
      return;
    }

    if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      setIsOpen(false);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!isOpen) {
        openMenu();
      } else if (activeIndex >= 0) {
        chooseOption(options[activeIndex]);
      }
      return;
    }

    if (event.key === "Tab") setIsOpen(false);
  }

  return (
    <div className="quest-select" ref={rootRef}>
      <button
        aria-activedescendant={isOpen && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        aria-controls={menuId}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={label}
        aria-required={required || undefined}
        className={`quest-select-trigger${isOpen ? " is-open" : ""}`}
        disabled={disabled}
        id={id}
        onBlur={() => setIsOpen(false)}
        onClick={() => (isOpen ? setIsOpen(false) : openMenu())}
        onKeyDown={handleKeyDown}
        ref={triggerRef}
        role="combobox"
        type="button"
      >
        <span className={selectedOption ? "" : "quest-select-placeholder"}>
          {selectedOption?.label ?? placeholder}
        </span>
        <span aria-hidden="true" className="quest-select-chevron" />
      </button>

      {isOpen && menuPosition && createPortal(
        <div
          aria-label={label}
          className="quest-select-menu"
          id={menuId}
          ref={menuRef}
          role="listbox"
          style={menuPosition}
        >
          {options.map((option, index) => (
            <div
              aria-disabled={option.disabled || undefined}
              aria-selected={value === option.value}
              className={`quest-select-option${activeIndex === index ? " is-active" : ""}${value === option.value ? " is-selected" : ""}${option.disabled ? " is-disabled" : ""}`}
              id={`${id}-option-${index}`}
              key={option.value}
              onClick={() => chooseOption(option)}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => !option.disabled && setActiveIndex(index)}
              role="option"
            >
              <span>{option.label}</span>
              {value === option.value && <span aria-hidden="true" className="quest-select-check">✓</span>}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
