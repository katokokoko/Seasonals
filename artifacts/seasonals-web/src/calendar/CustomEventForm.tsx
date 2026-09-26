/**
 * CustomEventForm — 日付を選んで自分の予定 (TGE / airdrop / unlock 等) を入れるフォーム。
 * 絵文字 marker + 予定の内容 + 任意のメモ。保存先はこのブラウザだけ (state/customEvents.ts)。
 * Calendar の DayPanel と、Home で日付を押した時の詳細ダイアログで共有する。
 */
import { useId, useState, type FormEvent } from "react";
import type { CustomPlanInput } from "../state/customEvents";
import "./plan.css";

export const EMOJI_PRESETS = [
  { emoji: "🚀", label: "TGE / launch" },
  { emoji: "🪂", label: "Airdrop" },
  { emoji: "🔓", label: "Unlock" },
  { emoji: "🗳️", label: "Vote" },
  { emoji: "💰", label: "Payout" },
  { emoji: "🎉", label: "Event" },
  { emoji: "📅", label: "Reminder" },
  { emoji: "🔔", label: "Alert" },
  { emoji: "⚠️", label: "Deadline" },
  { emoji: "📝", label: "Note" },
] as const;

const DEFAULT_EMOJI = "📅";

/** 自由入力から先頭の 1 grapheme (ZWJ 合成 / 異体字セレクタ込みの絵文字 1 個) を取る */
export function firstGrapheme(s: string): string {
  const t = s.trim();
  if (!t) return "";
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const it = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(t)[Symbol.iterator]().next();
    return it.done ? "" : it.value.segment;
  }
  return Array.from(t)[0] ?? "";
}

export function CustomEventForm({
  day,
  initial,
  onSave,
  onCancel,
  onDelete,
}: {
  day: string;
  initial?: CustomPlanInput;
  onSave: (input: CustomPlanInput) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const id = useId();
  const [emoji, setEmoji] = useState(initial?.emoji ?? DEFAULT_EMOJI);
  const [custom, setCustom] = useState(() => (initial && !EMOJI_PRESETS.some((p) => p.emoji === initial.emoji) ? initial.emoji : ""));
  const [title, setTitle] = useState(initial?.title ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [date, setDate] = useState(initial?.date ?? day);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const valid = title.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date) && emoji.length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onSave({ date, title, emoji, note });
  };

  return (
    <form className="plan-form" onSubmit={submit} aria-label={initial ? "Edit plan" : "Add plan"}>
      <fieldset className="plan-emoji">
        <legend>Icon</legend>
        <div className="plan-emoji-grid" role="radiogroup" aria-label="Icon">
          {EMOJI_PRESETS.map((p) => (
            <button
              key={p.emoji}
              type="button"
              role="radio"
              aria-checked={emoji === p.emoji}
              aria-label={p.label}
              title={p.label}
              className="plan-emoji-option"
              onClick={() => {
                setEmoji(p.emoji);
                setCustom("");
              }}
            >
              {p.emoji}
            </button>
          ))}
          <label className="plan-emoji-custom" title="Any emoji">
            <span className="sr-only">Other emoji</span>
            <input
              className="input"
              value={custom}
              placeholder="＋"
              inputMode="text"
              aria-label="Other emoji"
              onChange={(e) => {
                const g = firstGrapheme(e.target.value);
                setCustom(g);
                if (g) setEmoji(g);
              }}
            />
          </label>
        </div>
      </fieldset>
      <label className="plan-field" htmlFor={`${id}-title`}>
        <span>What's happening</span>
        <input
          id={`${id}-title`}
          className="input"
          value={title}
          maxLength={80}
          required
          placeholder="e.g. Jupiter TGE"
          onChange={(e) => setTitle(e.target.value)}
          data-autofocus
          autoFocus
        />
      </label>
      <label className="plan-field" htmlFor={`${id}-date`}>
        <span>Date</span>
        <input id={`${id}-date`} className="input" type="date" value={date} required onChange={(e) => setDate(e.target.value)} />
      </label>
      <label className="plan-field" htmlFor={`${id}-note`}>
        <span>
          Note <span className="muted">(optional)</span>
        </span>
        <textarea id={`${id}-note`} className="input" rows={2} maxLength={280} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="plan-form-actions">
        <button type="submit" className="btn btn-primary" disabled={!valid}>
          {initial ? "Save changes" : "Add plan"}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          Cancel
        </button>
        {onDelete &&
          (confirmDelete ? (
            <button type="button" className="btn btn-danger" onClick={onDelete}>
              Confirm delete
            </button>
          ) : (
            <button type="button" className="btn btn-quiet plan-delete" onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          ))}
      </div>
      <p className="small muted plan-privacy">Saved in this browser only. Agents can't see your plans yet.</p>
    </form>
  );
}
