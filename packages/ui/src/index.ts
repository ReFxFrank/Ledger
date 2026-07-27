/**
 * @ledger/ui — the design system.
 *
 * shadcn/Radix extended, never used raw. Every component reads the frozen tokens in
 * `tokens.css`; none of them hardcodes a colour, and the palette's meanings are enforced here
 * rather than left to whoever writes the next screen: amber is money leaving, green is money
 * reclaimed and belongs to one counter, red is a problem and nothing else.
 *
 * Import from the package root. Deep imports into `src/` are blocked by lint.
 */

export { cn, focusRing, hoverLift } from './lib/cn';
export { motion, useReducedMotion, type MotionProps, type Transition } from './motion';

// ── primitives ─────────────────────────────────────────────────────────────────────────
export { Button, type ButtonProps, type ButtonVariant } from './button';
export { Panel, PanelBody, PanelHeader, type PanelHeaderProps } from './panel';
export { Card, CardMeta, CardTitle, type CardProps } from './card';
export { Badge, type BadgeProps, type BadgeTone } from './badge';
export { StatusPill, type StatusPillProps } from './status-pill';
export { DifficultyMeter, type DifficultyMeterProps } from './difficulty-meter';

export { Input, type InputProps } from './input';
export { Textarea } from './textarea';
export { Label, type LabelProps } from './label';
export { Checkbox } from './checkbox';
export { Switch } from './switch';
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './select';

// ── overlays and structure ─────────────────────────────────────────────────────────────
export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogTitle,
  DialogTrigger,
  type DialogContentProps,
} from './dialog';
export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandMeta,
  CommandSeparator,
  useCommandState,
} from './command';
export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  type DropdownMenuItemProps,
} from './dropdown-menu';
export { Popover, PopoverAnchor, PopoverClose, PopoverContent, PopoverTrigger } from './popover';
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';
export { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
export { ScrollArea, ScrollBar } from './scroll-area';
export { Separator } from './separator';

// ── states ─────────────────────────────────────────────────────────────────────────────
export { EmptyState, type EmptyStateProps } from './empty-state';
export { Skeleton, SkeletonText, type SkeletonTextProps } from './skeleton';
export { Spinner, type SpinnerProps } from './spinner';
export { Toaster, toast } from './toast';

// ── signature components ───────────────────────────────────────────────────────────────
export {
  Money,
  MoneyDelta,
  type MoneyDeltaProps,
  type MoneyLike,
  type MoneyProps,
  type MoneySize,
  type MoneyTone,
} from './money';
export {
  DescriptorDecoder,
  DescriptorLegend,
  type DescriptorDecoderProps,
  type DescriptorSpan,
  type DescriptorStrippedSpan,
} from './descriptor-decoder';
