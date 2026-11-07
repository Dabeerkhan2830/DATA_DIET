import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field } from "./Field";
import { Input } from "./Input";
import { Select } from "./Select";
import { Textarea } from "./Textarea";

describe("Field", () => {
  it("associates the label with the control it renders", () => {
    render(
      <Field label="Institution id">
        {(control) => <Input {...control} defaultValue="1" />}
      </Field>,
    );

    const input = screen.getByLabelText("Institution id");
    const label = screen.getByText("Institution id");
    expect(input.tagName).toBe("INPUT");
    expect(label.tagName).toBe("LABEL");
    expect(label.getAttribute("for")).toBe(input.id);
  });

  it("refers the control at the hint", () => {
    render(
      <Field label="Hold reason" hint="Visible to reviewers only.">
        {(control) => <Textarea {...control} />}
      </Field>,
    );

    const control = screen.getByLabelText("Hold reason");
    const hint = screen.getByText("Visible to reviewers only.");
    expect(control.getAttribute("aria-describedby")).toBe(hint.id);
    expect(hint.id).toBeTruthy();
  });

  it("marks the control invalid and points at the error message", () => {
    render(
      <Field label="Policy name" hint="Letters and digits." error="A name is required.">
        {(control) => <Input {...control} />}
      </Field>,
    );

    const input = screen.getByLabelText("Policy name");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.className).toContain("border-critical");

    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("A name is required.");
    expect(input.getAttribute("aria-describedby")).toContain(error.id);
  });

  it("keeps the hint and the error both reachable when a value fails", () => {
    render(
      <Field label="Search" hint="Matches permitted metadata." error="Too short.">
        {(control) => <Input {...control} />}
      </Field>,
    );

    const describedBy = screen.getByLabelText("Search").getAttribute("aria-describedby") ?? "";
    expect(describedBy).toContain(screen.getByText("Matches permitted metadata.").id);
    expect(describedBy).toContain(screen.getByRole("alert").id);
  });

  it("conveys a required control without adding the marker to its name", () => {
    const { container } = render(
      <Field label="Hold reason" required>
        {(control) => <Input {...control} />}
      </Field>,
    );

    const input = screen.getByLabelText(/hold reason/i);
    expect(input).toHaveAttribute("required");
    // The star is decoration: the announced name is the label, not "Hold reason *".
    expect(input).toHaveAccessibleName("Hold reason");

    const marker = container.querySelector("label span");
    expect(marker).toHaveAttribute("aria-hidden", "true");
    expect(marker?.textContent).toBe("*");
  });

  it("works with a select, which carries its own chevron", () => {
    render(
      <Field label="Review status">
        {(control) => (
          <Select {...control} defaultValue="open">
            <option value="open">open</option>
            <option value="decided">decided</option>
          </Select>
        )}
      </Field>,
    );

    const select = screen.getByLabelText("Review status");
    expect(select.tagName).toBe("SELECT");
    expect(select.id).toBe(screen.getByText("Review status").getAttribute("for"));
  });

  it("generates a different id for every field on the page", () => {
    render(
      <>
        <Field label="First">{(control) => <Input {...control} />}</Field>
        <Field label="Second">{(control) => <Input {...control} />}</Field>
      </>,
    );

    const ids = ["First", "Second"].map((label) => screen.getByLabelText(label).id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("Input and Textarea states", () => {
  it("shows the invalid treatment from the aria state alone", () => {
    render(<Input aria-invalid="true" />);
    expect(screen.getByRole("textbox").className).toContain("border-critical");
  });

  it("stays neutral when only the prop says so", () => {
    render(<Input invalid={false} />);
    expect(screen.getByRole("textbox").className).toContain("border-line-strong");
  });

  it("grows a textarea but never horizontally", () => {
    render(<Textarea />);
    const control = screen.getByRole("textbox");
    expect(control.className).toContain("resize-y");
    expect(control).toHaveAttribute("rows", "4");
  });
});
