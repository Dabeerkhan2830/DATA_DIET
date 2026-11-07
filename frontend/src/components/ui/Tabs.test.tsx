import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Tabs, type TabItem } from "./Tabs";

const ITEMS: TabItem[] = [
  { id: "assessment", label: "Assessment" },
  { id: "history", label: "History" },
  { id: "holds", label: "Holds", disabled: true },
];

function Demo({ activeId, onChange }: { activeId?: string; onChange?: (id: string) => void } = {}) {
  return (
    <Tabs
      items={ITEMS}
      ariaLabel="Asset detail sections"
      activeId={activeId}
      onChange={onChange}
    >
      {(id) => <p>Panel for {id}</p>}
    </Tabs>
  );
}

describe("Tabs", () => {
  it("opens on the first enabled tab and names the panel after it", () => {
    render(<Demo />);

    const selected = screen.getByRole("tab", { name: "Assessment" });
    expect(selected).toHaveAttribute("aria-selected", "true");
    expect(selected).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("tabindex", "-1");

    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAccessibleName("Assessment");
    expect(panel).toHaveTextContent("Panel for assessment");
    expect(selected.getAttribute("aria-controls")).toBe(panel.id);
  });

  it("labels the tab list itself", () => {
    render(<Demo />);
    expect(screen.getByRole("tablist", { name: "Asset detail sections" })).toBeInTheDocument();
  });

  it("switches on click", async () => {
    const user = userEvent.setup();
    render(<Demo />);

    await user.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Panel for history");
  });

  it("moves with the arrow keys and activates what it lands on", async () => {
    const user = userEvent.setup();
    render(<Demo />);

    screen.getByRole("tab", { name: "Assessment" }).focus();
    await user.keyboard("{ArrowRight}");

    const history = screen.getByRole("tab", { name: "History" });
    expect(history).toHaveAttribute("aria-selected", "true");
    expect(history).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Panel for history");
  });

  it("skips a disabled tab and wraps around", async () => {
    const user = userEvent.setup();
    render(<Demo />);

    await user.click(screen.getByRole("tab", { name: "History" }));
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Assessment" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
  });

  it("jumps to the ends with Home and End", async () => {
    const user = userEvent.setup();
    render(<Demo />);

    screen.getByRole("tab", { name: "Assessment" }).focus();
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Assessment" })).toHaveAttribute("aria-selected", "true");
  });

  it("stays where the caller put it while controlled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Demo activeId="history" onChange={onChange} />);

    await user.click(screen.getByRole("tab", { name: "Assessment" }));

    expect(onChange).toHaveBeenCalledWith("assessment");
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
  });

  it("starts on the tab the caller names as default", () => {
    render(
      <Tabs items={ITEMS} ariaLabel="Asset detail sections" defaultId="history">
        {(id) => <p>Panel for {id}</p>}
      </Tabs>,
    );

    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Panel for history");
  });

  it("renders nothing selectable when every tab is disabled", () => {
    render(
      <Tabs items={[{ id: "x", label: "X", disabled: true }]} ariaLabel="Empty">
        {(id) => <p>{id}</p>}
      </Tabs>,
    );

    expect(screen.getByRole("tab", { name: "X" })).toBeDisabled();
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
  });
});
