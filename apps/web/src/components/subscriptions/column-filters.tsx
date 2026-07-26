'use client';

/**
 * Per-column filter controls, rendered inside the column header.
 *
 * A filter belongs next to the column it filters. Putting them all in a toolbar means a user
 * looking at a suspiciously short list has to hunt for which of six controls is hiding rows;
 * a lit funnel icon in the header answers that question without being asked.
 */

import * as React from 'react';
import { Filter } from 'lucide-react';
import { Button, Checkbox, Input, Popover, PopoverContent, PopoverTrigger, cn, focusRing } from '@ledger/ui';

interface FilterTriggerProps extends React.ComponentPropsWithoutRef<'button'> {
  readonly active: boolean;
  readonly label: string;
}

/**
 * Forwards its ref and spreads its props so it can be the Popover trigger directly — wrapping a
 * button in a span to satisfy `asChild` would leave the real control without the popover's aria
 * wiring, which is how a keyboard user ends up unable to tell the filter menu exists.
 */
const FilterTrigger = React.forwardRef<HTMLButtonElement, FilterTriggerProps>(function FilterTrigger(
  { active, label, className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Filter by ${label}`}
      className={cn(
        'grid size-5 shrink-0 place-items-center rounded-sm text-text-3',
        'transition-colors duration-[var(--duration-fast)] ease-standard hover:bg-ink-600 hover:text-text',
        active && 'bg-control-dim text-control-2',
        focusRing,
        className,
      )}
      {...props}
    >
      <Filter className="size-3" aria-hidden />
    </button>
  );
});

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export interface OptionFilterProps {
  readonly label: string;
  readonly options: readonly FilterOption[];
  readonly selected: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
}

/** Multi-select filter for the enum columns: status, category, billing channel, cadence unit. */
export function OptionFilter({
  label,
  options,
  selected,
  onChange,
}: OptionFilterProps): React.ReactElement {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <FilterTrigger active={selected.length > 0} label={label} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-0">
        <p className="eyebrow border-b border-line px-[var(--pad-card)] py-2">{label}</p>
        <div className="max-h-64 overflow-y-auto p-1">
          {options.map((option) => {
            const checked = selected.includes(option.value);
            return (
              <label
                key={option.value}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-text',
                  'transition-colors duration-[var(--duration-fast)] ease-standard hover:bg-ink-600',
                )}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(value) => {
                    const next = value === true
                      ? [...selected, option.value]
                      : selected.filter((item) => item !== option.value);
                    onChange(next);
                  }}
                />
                <span className="truncate">{option.label}</span>
              </label>
            );
          })}
        </div>
        {selected.length > 0 ? (
          <div className="border-t border-line p-1">
            <Button
              size="sm"
              variant="ghost"
              className="w-full"
              onClick={() => {
                onChange([]);
              }}
            >
              Clear
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export interface TextFilterProps {
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly onChange: (next: string) => void;
}

export function TextFilter({ label, value, placeholder, onChange }: TextFilterProps): React.ReactElement {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <FilterTrigger active={value !== ''} label={label} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60">
        <p className="eyebrow mb-1.5">{label} contains</p>
        <Input
          value={value}
          autoFocus
          placeholder={placeholder}
          aria-label={`${label} contains`}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
