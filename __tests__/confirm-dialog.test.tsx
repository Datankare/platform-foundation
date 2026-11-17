/** @jest-environment jsdom */
/**
 * __tests__/confirm-dialog.test.tsx — the one confirmation dialog, shared by the console's confirm
 * step and the user's screens (TASK-224)
 *
 * components/admin/ui/ConfirmDialog.tsx: an alertdialog that takes focus and gives it back; Escape
 * is Cancel (not while working); an action that cannot be undone is said so in words and has the
 * danger button; the consequence is said before the button; the fields go between the words and
 * the buttons; the button names the action.
 *
 * hostile:role n/a: a dialog only; who may act is the route's
 * hostile:self n/a: no account is read
 * hostile:store-down n/a: no store is read
 * hostile:id-spelling n/a: no id is read
 */
import React, { useRef, useState } from "react";
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConfirmDialog } from "@/components/admin/ui/ConfirmDialog";

function Harness({ risk }: { readonly risk: "irreversible" | "consequential" }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={opener} onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <ConfirmDialog
          id="x.y"
          risk={risk}
          title="Delete the thing"
          consequence="It is gone for good."
          confirmLabel="Delete it"
          returnFocus={opener}
          fields={
            <label>
              Note <input />
            </label>
          }
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      )}
    </div>
  );
}

describe("ConfirmDialog (TASK-224)", () => {
  it("irreversible: said in words, the danger button naming the action, focus in and back", () => {
    render(<Harness risk="irreversible" />);
    const open = screen.getByRole("button", { name: "Open" });
    open.focus();
    fireEvent.click(open);
    const dialog = screen.getByRole("alertdialog", { name: "Delete the thing" });
    expect(dialog).toHaveFocus();
    expect(dialog).toHaveAttribute("data-risk", "irreversible");
    expect(dialog).toHaveTextContent("This cannot be undone.");
    expect(dialog).toHaveAccessibleDescription(/It is gone for good\./);
    expect(screen.getByRole("button", { name: "Delete it" }).className).toContain(
      "bg-red-700"
    );
    expect(screen.getByLabelText("Note")).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(open).toHaveFocus();
  });

  it("consequential: no 'cannot be undone', the primary button", () => {
    render(<Harness risk="consequential" />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("alertdialog")).not.toHaveTextContent(
      "This cannot be undone."
    );
    expect(screen.getByRole("button", { name: "Delete it" }).className).toContain(
      "bg-blue-700"
    );
  });
});
