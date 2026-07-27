/**
 * The shell every email shares.
 *
 * Three rules hold across all ten templates:
 *
 * 1. **State the fact, the number, and the one action.** No preamble, no "we noticed", no
 *    encouragement. The reader is being interrupted about their money; the interruption should be
 *    readable in the notification preview and finished in two lines.
 * 2. **Money is monospace with tabular numerals.** Figures in these emails get compared —
 *    was/now, per charge/per year — and proportional digits make two aligned numbers look
 *    different lengths. `font-variant-numeric: tabular-nums` degrades to a plain monospace face in
 *    clients that ignore it, which is still the right answer.
 * 3. **No legal claims.** Nothing in this directory says what anyone is entitled to, required to
 *    do, or guaranteed to get. See docs/legal-notes.md — the product tells you what to do and
 *    tracks whether it worked.
 */

import type { ReactNode } from 'react';
import { Body, Container, Head, Heading, Html, Link, Preview, Section, Text } from '@react-email/components';
import { type Accent, accentColor, theme } from './theme';

export interface LayoutProps {
  /** The line the mail client shows next to the subject. Carry the number, not a teaser. */
  readonly preview: string;
  readonly children: ReactNode;
}

export function Layout({ preview, children }: LayoutProps): ReactNode {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body
        style={{
          margin: 0,
          padding: '24px 12px',
          backgroundColor: theme.page,
          color: theme.text,
          fontFamily: theme.fontSans,
          fontSize: '15px',
          lineHeight: '1.5',
        }}
      >
        <Container
          style={{
            maxWidth: '520px',
            margin: '0 auto',
            padding: '20px',
            backgroundColor: theme.panel,
            border: `1px solid ${theme.line}`,
            borderRadius: '10px',
          }}
        >
          {children}
        </Container>
        <Container style={{ maxWidth: '520px', margin: '0 auto', padding: '12px 20px' }}>
          <Text style={{ margin: 0, fontSize: '12px', color: theme.text3 }}>
            Ledger sends this because of a setting you control. Change what you hear about in
            notification settings.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export function Eyebrow({ children, accent }: { children: ReactNode; accent: Accent }): ReactNode {
  return (
    <Text
      style={{
        margin: '0 0 6px',
        fontSize: '11px',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: accentColor(accent),
      }}
    >
      {children}
    </Text>
  );
}

export function Headline({ children }: { children: ReactNode }): ReactNode {
  return (
    <Heading
      as="h1"
      style={{ margin: '0 0 12px', fontSize: '20px', lineHeight: '1.25', color: theme.text }}
    >
      {children}
    </Heading>
  );
}

export function Lede({ children }: { children: ReactNode }): ReactNode {
  return <Text style={{ margin: '0 0 16px', color: theme.text2 }}>{children}</Text>;
}

/** A monospace, tabular figure. Every amount and every date in a fact row goes through this. */
export function Figure({
  children,
  accent,
}: {
  children: ReactNode;
  accent?: Accent | undefined;
}): ReactNode {
  return (
    <span
      style={{
        fontFamily: theme.fontMono,
        fontVariantNumeric: 'tabular-nums',
        color: accent === undefined ? theme.text : accentColor(accent),
      }}
    >
      {children}
    </span>
  );
}

export function Facts({ children }: { children: ReactNode }): ReactNode {
  return (
    <Section
      style={{
        margin: '0 0 18px',
        padding: '2px 14px',
        backgroundColor: theme.raised,
        border: `1px solid ${theme.line}`,
        borderRadius: '6px',
      }}
    >
      {children}
    </Section>
  );
}

export function Fact({
  label,
  value,
  accent,
}: {
  label: string;
  value: ReactNode;
  accent?: Accent | undefined;
}): ReactNode {
  return (
    <Text style={{ margin: '10px 0', fontSize: '14px', color: theme.text2 }}>
      <span style={{ color: theme.text3 }}>{label}</span>
      {'  '}
      <Figure accent={accent}>{value}</Figure>
    </Text>
  );
}

/**
 * The one action. Rendered as a link rather than a table-button because a single, obvious link is
 * what survives every client, and because an email with two buttons has no primary action.
 */
export function Action({ href, label }: { href: string; label: string }): ReactNode {
  return (
    <Section style={{ margin: '0 0 4px' }}>
      <Link
        href={href}
        style={{
          display: 'inline-block',
          padding: '10px 16px',
          backgroundColor: theme.control,
          color: '#ffffff',
          borderRadius: '6px',
          fontSize: '14px',
          fontWeight: 600,
          textDecoration: 'none',
        }}
      >
        {label}
      </Link>
    </Section>
  );
}

export function Footnote({ children }: { children: ReactNode }): ReactNode {
  return (
    <Text style={{ margin: '16px 0 0', fontSize: '13px', color: theme.text3 }}>{children}</Text>
  );
}
