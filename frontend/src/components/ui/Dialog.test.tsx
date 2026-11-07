import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Input } from "./Input";

/** A dialog the trigger opens and closes, so focus restoration can be observed. */
function Controlled() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open hold form
      </button>
      <Dialog
        open={open}
        title="Create hold"
        description="Holds stop lifecycle work until they are released."
        onClose={() => setOpen(false)}
        footer={<Button>Save hold</Button>}
      >
        <Input placeholder="Reason" />
      </Dialog>
    </>
  );
}

function Standalone({
  onClose,
  dismissOnBackdrop,
  children,
}: {
  onClose: () => void;
  dismissOnBackdrop?: boolean;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open
      title="Create hold"
      description="Holds stop lifecycle work until they are released."
      onClose={onClose}
      dismissOnBackdrop={dismissOnBackdrop}
    >
      {children ?? <Input placeholder="Reason" />}
    </Dialog>
  );
}

describe("Dialog", () => {
  it("renders nothing until it is open", () => {
    render(<Controlled />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("names the dialog from its title and describes it from its description", () => {
    render(<Standalone onClose={() => {}} />);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("Create hold");
    expect(dialog).toHaveAccessibleDescription("Holds stop lifecycle work until they are released.");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("shows its body content", () => {
    render(
      <Standalone onClose={() => {}}>
        <p>Synthetic asset 3 only.</p>
      </Standalone>,
    );

    expect(screen.getByText("Synthetic asset 3 only.")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Standalone onClose={onClose} />);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes from the header control", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Standalone onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus in on open and back to the trigger on close", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    const trigger = screen.getByRole("button", { name: "Open hold form" });
    trigger.focus();
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toContainElement(document.activeElement as HTMLElement | null);

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps Tab inside the panel and wraps at both ends", async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    await user.click(screen.getByRole("button", { name: "Open hold form" }));

    const close = screen.getByRole("button", { name: "Close" });
    const save = screen.getByRole("button", { name: "Save hold" });
    const reason = screen.getByPlaceholderText("Reason");

    save.focus();
    await user.tab();
    expect(document.activeElement).toBe(close);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(save);

    // From the middle of the panel the normal order still applies.
    reason.focus();
    await user.tab();
    expect(document.activeElement).toBe(save);

    save.focus();
    await user.tab();
    expect(document.activeElement).toBe(close);
  });

  it("clicking the backdrop closes it", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Standalone onClose={onClose} />);

    await user.click(document.querySelector(".bg-overlay") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves the backdrop inert when the caller forbids dismissing", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Standalone onClose={onClose} dismissOnBackdrop={false} />);

    await user.click(document.querySelector(".bg-overlay") as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("honours an initial focus target the caller points at", () => {
    function WithRef() {
      const ref = useRef<HTMLInputElement>(null);
      return (
        <Dialog open title="Create hold" onClose={() => {}} initialFocusRef={ref}>
          <Input ref={ref} placeholder="Reason" />
        </Dialog>
      );
    }

    render(<WithRef />);
    expect(screen.getByPlaceholderText("Reason")).toBe(document.activeElement);
  });

  it("locks and restores background scrolling while it is open", async () => {
    const user = userEvent.setup();
    document.body.style.overflow = "auto";
    render(<Controlled />);

    await user.click(screen.getByRole("button", { name: "Open hold form" }));
    await screen.findByRole("dialog");
    expect(document.body.style.overflow).toBe("hidden");

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.body.style.overflow).toBe("auto"));
  });
});
