import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";

export interface TableProps {
  /** The accessible name of the table. */
  caption: string;
  children: ReactNode;
  className?: string;
}

const ALIGN_CLASSES = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
} as const;

export type TableCellAlign = keyof typeof ALIGN_CLASSES;

/**
 * A real `<table>` with a scroll container, never a grid of divs: the row/column
 * relationship is the information, and only the element conveys it.
 *
 * The caption is visually hidden because a table in this app already sits under
 * a `CardHeader` title — rendering the same words twice would make a screen
 * reader announce them twice, while an unnamed table would be unidentifiable.
 */
export function Table({ caption, children, className }: TableProps) {
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface">
      <table className={`w-full border-collapse text-left ${className ?? ""}`}>
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export function TableHead({ children }: { children: ReactNode }) {
  return <thead className="border-b border-line bg-surface-sunken">{children}</thead>;
}

export function TableBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-line">{children}</tbody>;
}

export function TableRow({ children, className }: { children: ReactNode; className?: string }) {
  return <tr className={`hover:bg-surface-hover ${className ?? ""}`}>{children}</tr>;
}

export interface TableHeaderCellProps extends ThHTMLAttributes<HTMLTableCellElement> {
  /** `row` for a header that labels its row rather than its column. */
  scope?: "col" | "row";
  align?: TableCellAlign;
}

export function TableHeaderCell({
  scope = "col",
  align = "left",
  className,
  children,
  ...rest
}: TableHeaderCellProps) {
  return (
    <th
      scope={scope}
      className={`px-control-x py-row-y text-meta font-semibold whitespace-nowrap text-ink-muted ${ALIGN_CLASSES[align]} ${
        className ?? ""
      }`}
      {...rest}
    >
      {children}
    </th>
  );
}

export interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  align?: TableCellAlign;
}

export function TableCell({ align = "left", className, children, ...rest }: TableCellProps) {
  return (
    <td
      className={`px-control-x py-row-y text-body align-top text-ink-secondary ${ALIGN_CLASSES[align]} ${
        className ?? ""
      }`}
      {...rest}
    >
      {children}
    </td>
  );
}
