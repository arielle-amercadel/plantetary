"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import AppShell, { FigmaIcon } from "../../app-shell";
import CategoryPicker, { CUSTOM_CATEGORY_VALUE } from "../../category-picker";
import { getCustomCategoryError, getQuestXp, useQuestStore } from "../../quest-store";
import type {
  Difficulty,
  Quest,
  QuestListKey,
  RepeatSchedule,
  Weekday,
} from "../../quest-store";

const weekdays: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function formatDueDate(value: string) {
  if (!value) return "No due date";

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return `Due ${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

export default function CreateQuestPage() {
  const router = useRouter();
  const { addQuest, addCategory, categoryLists } = useQuestStore();
  const [title, setTitle] = useState("");
  const [questType, setQuestType] = useState<QuestListKey | "">("");
  const [categorySelection, setCategorySelection] = useState("");
  const [customCategoryName, setCustomCategoryName] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty | "">("");
  const [repeatSchedule, setRepeatSchedule] = useState<RepeatSchedule | "">("");
  const [selectedDays, setSelectedDays] = useState<Weekday[]>([]);
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const categoryOptions = questType ? categoryLists[questType] : [];
  const categoryValue = categorySelection === CUSTOM_CATEGORY_VALUE
    ? customCategoryName.trim()
    : categorySelection;
  const categoryError = questType && categorySelection === CUSTOM_CATEGORY_VALUE
    ? getCustomCategoryError(categoryOptions, customCategoryName)
    : "";

  const scheduleLabel = questType === "daily"
    ? repeatSchedule === "Every day"
      ? "Every day"
      : repeatSchedule === "Selected days"
        ? selectedDays.length > 0 ? selectedDays.join(", ") : "Choose days"
        : "Choose a repeat schedule"
    : formatDueDate(dueDate);
  const hasValidSchedule = questType === "daily"
    ? Boolean(repeatSchedule) && (repeatSchedule !== "Selected days" || selectedDays.length > 0)
    : questType === "personal";
  const canSave = Boolean(
    title.trim() && questType && categoryValue && !categoryError && difficulty && hasValidSchedule,
  );

  function selectQuestType(type: QuestListKey) {
    setQuestType(type);
    setCategorySelection("");
    setCustomCategoryName("");
    setRepeatSchedule("");
    setSelectedDays([]);
    setDueDate("");
  }

  function saveQuest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave || !questType || !categoryValue || !difficulty) return;
    if (questType === "daily" && !repeatSchedule) return;
    if (categorySelection === CUSTOM_CATEGORY_VALUE && !addCategory(questType, categoryValue)) return;

    const schedule = questType === "daily"
      ? repeatSchedule === "Every day" ? "Every day" : selectedDays.join(", ")
      : formatDueDate(dueDate);
    const dailyRepeatSchedule = questType === "daily" && repeatSchedule
      ? repeatSchedule
      : undefined;
    const quest: Quest = {
      id: `${questType}-${Date.now()}`,
      title: title.trim(),
      category: categoryValue,
      schedule,
      difficulty,
      completed: false,
      notes: notes.trim(),
      ...(dailyRepeatSchedule
        ? {
            repeatSchedule: dailyRepeatSchedule,
            selectedDays: dailyRepeatSchedule === "Every day" ? weekdays : selectedDays,
          }
        : { dueDate: dueDate || undefined }),
    };

    addQuest(questType, quest);
    router.push("/");
  }

  function toggleDay(day: Weekday) {
    setSelectedDays((current) =>
      current.includes(day) ? current.filter((selectedDay) => selectedDay !== day) : [...current, day],
    );
  }

  return (
    <AppShell page="create">
      <main className="create-quest-content">
        <header className="create-quest-heading">
          <div>
            <span className="create-quest-eyebrow">A NEW ADVENTURE</span>
            <h1>Create a quest</h1>
            <p>Give a small step a place in your garden.</p>
          </div>
          <FigmaIcon src="/icon-sprout.svg" size={28} />
        </header>

        <form className="create-quest-layout" onSubmit={saveQuest}>
          <div className="create-form-panel">
            <div className="create-form-contents">
              <section className="create-form-section">
                <fieldset className="create-fieldset create-type-field">
                  <legend>Quest type</legend>
                  <div className="create-type-options">
                    <button
                      className={`create-type-option${questType === "daily" ? " is-selected" : ""}`}
                      type="button"
                      aria-pressed={questType === "daily"}
                      onClick={() => selectQuestType("daily")}
                    >
                      <span className="create-type-option-heading">
                        <span className="create-type-option-label">
                          <FigmaIcon src="/icon-sun.svg" size={17} />
                          <span>Daily Quest</span>
                        </span>
                        <span className="create-type-indicator" aria-hidden="true" />
                      </span>
                      <span className="create-type-option-description">
                        A recurring, customizable habit.
                      </span>
                    </button>
                    <button
                      className={`create-type-option${questType === "personal" ? " is-selected" : ""}`}
                      type="button"
                      aria-pressed={questType === "personal"}
                      onClick={() => selectQuestType("personal")}
                    >
                      <span className="create-type-option-heading">
                        <span className="create-type-option-label">
                          <FigmaIcon src="/icon-scroll-text.svg" size={17} />
                          <span>Personal Quest</span>
                        </span>
                        <span className="create-type-indicator" aria-hidden="true" />
                      </span>
                      <span className="create-type-option-description">
                        A one-time task or personal goal.
                      </span>
                    </button>
                  </div>
                </fieldset>

                <div className="create-field">
                  <label htmlFor="quest-title">Quest title *</label>
                  <input
                    autoFocus
                    id="quest-title"
                    name="title"
                    placeholder="Name your quest"
                    maxLength={80}
                    required
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                  <span className="create-field-hint">
                    Keep it small and specific. You can always grow from here.
                  </span>
                </div>

                <div className="create-field">
                  <label htmlFor="quest-category">Category</label>
                  <CategoryPicker
                    id="quest-category"
                    label="Category"
                    options={categoryOptions}
                    disabled={!questType}
                    selection={categorySelection}
                    onSelectionChange={(selection) => {
                      setCategorySelection(selection);
                      if (selection !== CUSTOM_CATEGORY_VALUE) setCustomCategoryName("");
                    }}
                    customName={customCategoryName}
                    onCustomNameChange={setCustomCategoryName}
                    customNameError={categoryError}
                  />
                </div>
              </section>

              {questType === "daily" && (
                <section className="create-form-section">
                <div className="create-field">
                    <label htmlFor="repeat-schedule">Repeat</label>
                  <select
                    id="repeat-schedule"
                    name="repeatSchedule"
                    required
                    value={repeatSchedule}
                    onChange={(event) => {
                      const value = event.target.value as RepeatSchedule | "";
                      setRepeatSchedule(value);
                      setSelectedDays(value === "Every day" ? weekdays : []);
                    }}
                  >
                    <option value="" disabled>Choose a schedule</option>
                    <option value="Every day">Every day</option>
                    <option value="Selected days">Selected days</option>
                  </select>
                </div>
                {repeatSchedule === "Selected days" && (
                  <fieldset className="create-fieldset create-days-field">
                    <legend>Choose days</legend>
                    <div className="weekday-options">
                      {weekdays.map((day) => (
                        <button
                          className={`weekday-option${selectedDays.includes(day) ? " is-selected" : ""}`}
                          key={day}
                          type="button"
                          aria-label={day}
                          aria-pressed={selectedDays.includes(day)}
                          onClick={() => toggleDay(day)}
                        >
                          {day}
                        </button>
                      ))}
                    </div>
                    <span className="create-field-hint">
                      {selectedDays.length > 0 ? selectedDays.join(", ") : "Select at least one day."}
                    </span>
                  </fieldset>
                )}
                </section>
              )}

              {questType === "personal" && (
                <section className="create-form-section">
                <div className="create-field">
                    <label htmlFor="quest-due-date">Due date <span>· optional</span></label>
                  <input
                    id="quest-due-date"
                    name="dueDate"
                    type="date"
                    value={dueDate}
                    onChange={(event) => setDueDate(event.target.value)}
                  />
                </div>
                </section>
              )}

              {questType === "daily" && (
                <aside className="daily-reset-reminder" role="note">
                  <Image src="/icon-refresh.svg" alt="" aria-hidden="true" width={17} height={17} />
                  <p>
                    Daily quests reset at midnight on scheduled days. Your past completions and earned
                    XP are always preserved, even when you edit a quest.
                  </p>
                </aside>
              )}

              <section className="create-form-section">
                <div className="create-field">
                  <label htmlFor="quest-difficulty">Difficulty</label>
                  <select
                    id="quest-difficulty"
                    name="difficulty"
                    required
                    value={difficulty}
                    onChange={(event) => setDifficulty(event.target.value as Difficulty | "")}
                  >
                    <option value="" disabled>Choose difficulty</option>
                    <option value="Easy">Easy · 5 XP</option>
                    <option value="Medium">Medium · 10 XP</option>
                    <option value="Hard">Hard · 20 XP</option>
                  </select>
                </div>
              </section>

              <section className="create-form-section">
                <div className="create-field">
                  <label htmlFor="quest-notes">Notes <span>· optional</span></label>
                  <textarea
                    id="quest-notes"
                    name="notes"
                    placeholder="Add a little context or a reminder..."
                    rows={3}
                    maxLength={280}
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                  />
                </div>
              </section>
            </div>

            <footer className="create-form-actions">
              <Link className="create-cancel-button" href="/">Cancel</Link>
              <button className="create-save-button" type="submit" disabled={!canSave}>
                <Image src="/icon-check.svg" alt="" aria-hidden="true" width={15} height={15} />
                <span>Save quest</span>
              </button>
            </footer>
          </div>

          <aside className="quest-guidance">
            <section className="quest-preview" aria-label="Quest preview">
              <div className="quest-preview-heading">
                <h2>YOUR QUEST AT A GLANCE</h2>
                <FigmaIcon src="/icon-sparkles.svg" size={16} />
              </div>
              <div className="quest-preview-plant-frame">
                <Image
                  className="quest-preview-plant pixel-art"
                  src="/plant-daisy.png"
                  alt=""
                  width={112}
                  height={112}
                  unoptimized
                />
              </div>
              <h3 className="quest-preview-title">{title.trim() || "Your quest title"}</h3>
              <div className="quest-preview-tags">
                <span className="quest-preview-tag">
                  {questType === "daily" ? "Daily" : questType === "personal" ? "Personal" : "Quest type"}
                </span>
                <span className="quest-preview-tag">{categoryValue || "Choose a category"}</span>
              </div>
              <div className="quest-preview-schedule">
                <FigmaIcon
                  src={questType === "personal" ? "/icon-flag.svg" : "/icon-refresh.svg"}
                  size={15}
                />
                <span>
                  {questType === "daily" ? `${scheduleLabel} · resets at midnight` : scheduleLabel}
                </span>
              </div>
              <div className="quest-preview-reward">
                <div className="quest-preview-reward-copy">
                  <span>Each completion earns</span>
                  <span className="quest-preview-difficulty">
                    {difficulty || "Choose difficulty"}
                  </span>
                </div>
                <strong>{difficulty ? `+${getQuestXp(difficulty)} XP` : "XP reward"}</strong>
              </div>
              <div className="quest-preview-note">
                <span>NOTES</span>
                <p>{notes.trim() || "Your notes will appear here."}</p>
              </div>
            </section>
            <section className="quest-type-guide">
              <h2>A rhythm or a milestone?</h2>
              <p>
                Daily Quests are for habits like drinking water or morning skincare. Choose the days
                that work for you.
              </p>
              <p>
                Personal Quests are for studying, chores, projects, and goals. Add a due date if it
                helps, or leave it open.
              </p>
            </section>
            <aside className="quest-gentle-encouragement">
              <FigmaIcon src="/icon-heart.svg" size={16} />
              <p>A kind routine starts with a manageable step.</p>
            </aside>
          </aside>
        </form>
      </main>
    </AppShell>
  );
}