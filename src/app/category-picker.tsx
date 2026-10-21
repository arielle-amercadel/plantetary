"use client";

import QuestSelect from "./quests/new/quest-select";

export const CUSTOM_CATEGORY_VALUE = "__create_custom_category__";

type CategoryPickerProps = {
  id: string;
  label: string;
  options: string[];
  disabled?: boolean;
  selection: string;
  onSelectionChange: (selection: string) => void;
  customName: string;
  onCustomNameChange: (name: string) => void;
  customNameError: string;
  useCustomDropdown?: boolean;
};

export default function CategoryPicker({
  id,
  label,
  options,
  disabled = false,
  selection,
  onSelectionChange,
  customName,
  onCustomNameChange,
  customNameError,
  useCustomDropdown = false,
}: CategoryPickerProps) {
  const customNameId = `${id}-custom-name`;
  const errorId = `${id}-custom-error`;

  return (
    <div className="category-picker">
      {useCustomDropdown ? (
        <QuestSelect
          id={id}
          label={label}
          disabled={disabled}
          required
          value={selection}
          placeholder="Choose a category"
          options={[
            { value: "", label: "Choose a category", disabled: true },
            ...options.map((option) => ({ value: option, label: option })),
            { value: CUSTOM_CATEGORY_VALUE, label: "Create custom category..." },
          ]}
          onValueChange={onSelectionChange}
        />
      ) : (
        <select
          id={id}
          aria-label={label}
          disabled={disabled}
          value={selection}
          required
          onChange={(event) => onSelectionChange(event.target.value)}
        >
          <option value="" disabled>Choose a category</option>
          {options.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
          <option value={CUSTOM_CATEGORY_VALUE}>Create custom category...</option>
        </select>
      )}
      {selection === CUSTOM_CATEGORY_VALUE && (
        <div className="category-custom-entry">
          <input
            id={customNameId}
            aria-label={`${label} name`}
            aria-invalid={Boolean(customNameError)}
            aria-describedby={customNameError ? errorId : undefined}
            placeholder="Enter a category name"
            maxLength={32}
            required
            value={customName}
            onChange={(event) => onCustomNameChange(event.target.value)}
          />
          {customNameError && (
            <span className="category-field-error" id={errorId} role="alert">
              {customNameError}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
