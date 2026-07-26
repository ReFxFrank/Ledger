'use client';

import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@ledger/ui';

export interface CodeInputProps {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Fired the moment the last box is filled, so the common case needs no button press. */
  readonly onComplete?: (value: string) => void;
  readonly length?: number;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly label: string;
  readonly describedBy?: string | undefined;
  readonly autoFocus?: boolean;
}

const DIGITS = /\d/u;

/**
 * Whether every box is filled.
 *
 * The value keeps a space for a skipped box — someone can type into box 4 first — so length
 * alone is not the test. Callers use this to gate the submit button.
 */
export function isCodeComplete(value: string, length = 6): boolean {
  return value.length === length && !value.includes(' ');
}

/**
 * A one-time code, one box per digit.
 *
 * Boxes rather than a single field because a six-digit code copied off a phone screen is read in
 * pairs, and the gaps are what let someone check their work halfway through. Everything a
 * keyboard user expects works: typing advances, Backspace on an empty box steps back and clears
 * the one before it, the arrows move without editing, and a pasted code fills the row from
 * wherever the caret happens to be.
 *
 * `autocomplete="one-time-code"` sits on the first box only — browsers fill the whole row from
 * it, and repeating it makes iOS offer the same suggestion six times.
 */
export function CodeInput({
  id,
  value,
  onChange,
  onComplete,
  length = 6,
  disabled = false,
  invalid = false,
  label,
  describedBy,
  autoFocus = false,
}: CodeInputProps): ReactNode {
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (autoFocus) inputs.current[0]?.focus();
  }, [autoFocus]);

  function focusAt(index: number): void {
    const clamped = Math.max(0, Math.min(length - 1, index));
    const target = inputs.current[clamped];
    target?.focus();
    target?.select();
  }

  function commit(next: string, caret: number): void {
    const trimmed = next.slice(0, length);
    onChange(trimmed);
    focusAt(caret);
    if (isCodeComplete(trimmed, length) && onComplete !== undefined) onComplete(trimmed);
  }

  function setDigit(index: number, digit: string): void {
    // Padded so typing into box 4 of an empty row does not silently land at position 0.
    const chars = value.padEnd(length, ' ').split('');
    chars[index] = digit;
    commit(chars.join('').trimEnd(), index + 1);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>, index: number): void {
    if (event.key === 'Backspace') {
      event.preventDefault();
      const chars = value.padEnd(length, ' ').split('');
      // Backspace in an already-empty box clears the one before it, which is what a single
      // long press feels like it should do when a code has been mistyped.
      const target = (chars[index] ?? ' ').trim() === '' ? index - 1 : index;
      if (target < 0) return;
      chars[target] = ' ';
      commit(chars.join('').trimEnd(), target);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusAt(index - 1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusAt(index + 1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      focusAt(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      focusAt(value.length);
    }
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>, index: number): void {
    const pasted = event.clipboardData.getData('text').replace(/\D/gu, '');
    if (pasted === '') return;
    event.preventDefault();
    const chars = value.padEnd(length, ' ').split('');
    for (let offset = 0; offset < pasted.length && index + offset < length; offset += 1) {
      chars[index + offset] = pasted[offset] ?? ' ';
    }
    const filled = chars.join('').trimEnd();
    commit(filled, Math.min(index + pasted.length, length - 1));
  }

  return (
    <div
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      className="flex items-center gap-1.5"
      id={id}
    >
      {Array.from({ length }, (_, index) => {
        const char = (value[index] ?? '').trim();
        return (
          <input
            key={index}
            ref={(node) => {
              inputs.current[index] = node;
            }}
            value={char}
            disabled={disabled}
            aria-invalid={invalid ? true : undefined}
            aria-label={`Digit ${index + 1} of ${length}`}
            inputMode="numeric"
            // `text` and not `number`: number renders spinners, accepts `e` and `-`, and drops
            // a leading zero on some browsers — every one of which is wrong for a TOTP code.
            type="text"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            maxLength={1}
            onChange={(event) => {
              const digit = event.target.value.replace(/\D/gu, '').slice(-1);
              if (digit === '') return;
              setDigit(index, digit);
            }}
            onKeyDown={(event) => {
              onKeyDown(event, index);
            }}
            onPaste={(event) => {
              onPaste(event, index);
            }}
            onFocus={(event) => {
              event.target.select();
            }}
            onBeforeInput={(event) => {
              // Blocks non-digits before they reach the value, so the box never flashes a letter.
              const data = event.nativeEvent.data;
              if (data !== null && !DIGITS.test(data)) event.preventDefault();
            }}
            className={cn(
              'h-11 w-full min-w-0 rounded-md border bg-ink-900 text-center font-mono text-base tabular-nums text-text',
              'outline-none transition-[border-color] duration-[var(--duration-fast)] ease-standard',
              'hover:border-line-hot focus-visible:[box-shadow:var(--focus-ring)]',
              'disabled:cursor-not-allowed disabled:opacity-50',
              invalid ? 'border-alert' : 'border-line-strong',
            )}
          />
        );
      })}
    </div>
  );
}
