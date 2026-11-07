import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { toneForSensitivity } from "../../lib/semantic";
import { Badge } from "./Badge";
import { Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow } from "./Table";

function InventoryTable() {
  return (
    <Table caption="Asset inventory">
      <TableHead>
        <TableRow>
          <TableHeaderCell scope="row">Record</TableHeaderCell>
          <TableHeaderCell>Sensitivity</TableHeaderCell>
          <TableHeaderCell align="right">Risk score</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        <TableRow>
          <TableCell>SYNTH-0001</TableCell>
          <TableCell>
            <Badge tone={toneForSensitivity("restricted")}>restricted</Badge>
          </TableCell>
          <TableCell align="right">91</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

describe("Table", () => {
  it("is a table whose name comes from its caption", () => {
    render(<InventoryTable />);
    expect(screen.getByRole("table", { name: "Asset inventory" })).toBeInTheDocument();
  });

  it("keeps the caption out of the visual layout but in the tree", () => {
    render(<InventoryTable />);
    const caption = screen.getByText("Asset inventory");
    expect(caption.tagName).toBe("CAPTION");
    expect(caption.className).toContain("sr-only");
  });

  it("scopes its header cells", () => {
    render(<InventoryTable />);

    expect(screen.getByRole("rowheader", { name: "Record" })).toHaveAttribute("scope", "row");
    expect(screen.getByRole("columnheader", { name: "Risk score" })).toHaveAttribute(
      "scope",
      "col",
    );
  });

  it("defaults a header cell to a column header", () => {
    render(
      <Table caption="Holds">
        <TableHead>
          <TableRow>
            <TableHeaderCell>Status</TableHeaderCell>
          </TableRow>
        </TableHead>
      </Table>,
    );

    expect(screen.getByRole("columnheader", { name: "Status" })).toHaveAttribute("scope", "col");
  });

  it("aligns numeric columns without a native align attribute", () => {
    render(<InventoryTable />);
    const score = screen.getByText("91");
    expect(score.className).toContain("text-right");
    expect(score).not.toHaveAttribute("align");
  });

  it("carries the semantic badge through a cell unchanged", () => {
    render(<InventoryTable />);
    const badge = screen.getByText("restricted");
    expect(badge.className).toContain("bg-critical-surface");
    expect(badge.className).toContain("ring-critical-line");
  });
});
