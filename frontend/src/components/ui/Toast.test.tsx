import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { ToastProvider, useToast, type ToastInput } from "./Toast";

function Trigger({ input }: { input?: ToastInput }) {
  const { show } = useToast();
  return (
    <Button onClick={() => show(input ?? { title: "Hold created", message: "Asset 3 is blocked." })}>
      Notify
    </Button>
  );
}

function region(): HTMLElement {
  return screen.getByRole("region", { name: "Notifications" });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ToastProvider", () => {
  it("mounts the live region before any message exists", () => {
    render(
      <ToastProvider>
        <p>Page content</p>
      </ToastProvider>,
    );

    expect(region()).toHaveAttribute("aria-live", "polite");
    expect(region()).toBeEmptyDOMElement();
  });

  it("announces the title and message inside that region", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Notify" }));

    expect(region()).toHaveTextContent("Hold created");
    expect(region()).toHaveTextContent("Asset 3 is blocked.");
  });

  it("dismisses on request and stops the timer", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );

    act(() => {
      screen.getByRole("button", { name: "Notify" }).click();
    });
    expect(region()).toHaveTextContent("Hold created");

    act(() => {
      screen.getByRole("button", { name: "Dismiss notification" }).click();
    });
    expect(region()).toBeEmptyDOMElement();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(region()).toBeEmptyDOMElement();
  });

  it("removes a toast by itself after its duration", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger input={{ title: "Decision recorded", durationMs: 2000 }} />
      </ToastProvider>,
    );

    act(() => {
      screen.getByRole("button", { name: "Notify" }).click();
    });
    expect(region()).toHaveTextContent("Decision recorded");

    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(region()).toHaveTextContent("Decision recorded");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(region()).toBeEmptyDOMElement();
  });

  it("keeps a sticky toast until the user acts", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger input={{ title: "Session expired", durationMs: null }} />
      </ToastProvider>,
    );

    act(() => {
      screen.getByRole("button", { name: "Notify" }).click();
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(region()).toHaveTextContent("Session expired");
    expect(screen.getByRole("button", { name: "Dismiss notification" })).toBeInTheDocument();
  });

  it("paints the status surface from the semantic role", () => {
    const { container } = render(
      <ToastProvider>
        <Trigger input={{ title: "Hold blocked", tone: "critical" }} />
      </ToastProvider>,
    );

    act(() => {
      screen.getByRole("button", { name: "Notify" }).click();
    });

    const item = container.querySelector(".bg-critical-surface");
    expect(item).not.toBeNull();
    expect(item?.className).toContain("ring-critical-line");
    expect(item?.className).toContain("text-critical-ink");
  });

  it("resolves a legacy palette name and a brand accent onto a status", () => {
    const { container, rerender } = render(
      <ToastProvider>
        <Trigger input={{ title: "Legacy", tone: "rose" }} />
      </ToastProvider>,
    );
    act(() => {
      screen.getByRole("button", { name: "Notify" }).click();
    });
    expect(container.querySelector(".bg-critical-surface")).not.toBeNull();

    rerender(
      <ToastProvider>
        <Trigger input={{ title: "Brand", tone: "accent" }} />
      </ToastProvider>,
    );
    act(() => {
      screen.getByRole("button", { name: "Notify" }).click();
    });
    expect(container.querySelector(".bg-neutral-surface")).not.toBeNull();
  });

  it("drops the oldest message once the cap is reached", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider maxVisible={3}>
        <Burst count={5} />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Burst" }));

    expect(screen.getAllByRole("button", { name: "Dismiss notification" })).toHaveLength(3);
    expect(region()).not.toHaveTextContent("message 0");
    expect(region()).toHaveTextContent("message 4");
  });

  it("refuses to run without the provider above it", () => {
    expect(() => render(<Trigger />)).toThrow(/ToastProvider/);
  });
});

/** Shows `count` messages in one click, so the visible cap can be observed. */
function Burst({ count }: { count: number }) {
  const { show } = useToast();
  return (
    <Button
      onClick={() => {
        for (let index = 0; index < count; index += 1) {
          show({ title: `message ${index}` });
        }
      }}
    >
      Burst
    </Button>
  );
}
