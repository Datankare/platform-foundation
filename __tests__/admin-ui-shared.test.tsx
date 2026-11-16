/**
 * @jest-environment jsdom
 */
/**
 * TASK-216 — the admin console's shared parts (components/admin/ui): the one table, the panel
 * state, the outcome display, the confirmation step and its registry's reason rule, the
 * permission gate, the labels, the call helper, the detail panel and the field. Each is tested
 * here once, for what every screen relies on it to do; the screens' own tests show them in use.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { renderMessage } from "@/platform/errors/messages";
import { messageKey } from "@/platform/errors/registry";
import { AdminTable, pageRange, type Column } from "@/components/admin/ui/AdminTable";
import { PanelState, usePanelRead } from "@/components/admin/ui/PanelState";
import {
  OutcomeList,
  outcome,
  refusedOutcome,
  type OutcomeEntry,
} from "@/components/admin/ui/Outcome";
import { ConfirmStep } from "@/components/admin/ui/ConfirmStep";
import { GatedButton, needsPermission } from "@/components/admin/ui/PermissionGate";
import {
  columnLabel,
  featureLabel,
  filterLabel,
  jobKindLabel,
  permissionLabel,
  readableCode,
  roleLabel,
  settingLabel,
  tableLabel,
  toolLabel,
} from "@/components/admin/ui/labels";
import { adminCall, refusalFrom } from "@/components/admin/ui/admin-call";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";
import { DetailLayout, DetailPanel } from "@/components/admin/ui/DetailPanel";
import { Field, TextInput } from "@/components/admin/ui/Field";
import { IdDetail, PersonRef } from "@/components/admin/ui/Ref";
import { SESSION_END_EVENT } from "@/platform/errors/refusal";
import { fullTimestamp } from "@/components/admin/admin-format";

const ui = (key: string, values?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.ui.${key}`, values);
const confirmWords = (key: string, values?: Record<string, string | number>) =>
  renderMessage(`screens.admin_console.confirm.${key}`, values);

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

// ── the table ────────────────────────────────────────────────────────────────────────────
interface Row {
  id: string;
  name: string;
  made: string | null;
  note: string;
  size: number;
}
const ROWS: Row[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Beta",
    made: "2026-10-26T12:00:00.000Z",
    note: "x".repeat(200),
    size: 2,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "alpha",
    made: null,
    note: "",
    size: 10,
  },
];
const COLUMNS: Column<Row>[] = [
  { id: "id", header: "Id", kind: "id", value: (r) => r.id },
  {
    id: "name",
    header: "Name",
    value: (r) => r.name,
    sortBy: (r) => r.name.toLowerCase(),
  },
  { id: "made", header: "Made", kind: "date", value: (r) => r.made, secondary: true },
  { id: "note", header: "Note", value: (r) => r.note },
  { id: "size", header: "Size", value: (r) => String(r.size), sortBy: (r) => r.size },
];
const table = (props: Partial<React.ComponentProps<typeof AdminTable<Row>>> = {}) =>
  render(
    <AdminTable
      caption="Things"
      columns={COLUMNS}
      rows={ROWS}
      rowKey={(r) => r.id}
      {...props}
    />
  );

describe("AdminTable", () => {
  it("scrolls inside its own card and never widens the page; captioned, headers scoped", () => {
    table();
    const grid = screen.getByRole("table", { name: "Things" });
    const card = grid.closest('[role="region"]')!;
    expect(card).toHaveAccessibleName("Things");
    expect(card.className).toMatch(/\bmax-w-full\b/);
    expect(card.className).toMatch(/\boverflow-x-auto\b/);
    expect(card).toHaveAttribute("tabindex", "0");
    expect(grid.closest("[data-admin-table]")!.className).toMatch(/\bmin-w-0\b/);
    for (const th of within(grid).getAllByRole("columnheader"))
      expect(th).toHaveAttribute("scope", "col");
    // Every cell wraps at words.
    for (const td of within(grid).getAllByRole("cell"))
      expect(td.className).toMatch(/\bbreak-words\b/);
  });

  it("dates the console's one way; none is 'Never'; an empty value a dash", () => {
    table();
    const date = screen.getByText("26 Oct 2026");
    expect(date).toHaveAttribute("title", fullTimestamp(ROWS[0]!.made!));
    expect(screen.queryByText(ROWS[0]!.made!)).toBeNull();
    expect(screen.getByText(ui("table.never"))).toBeDefined();
    expect(screen.getByText(ui("table.none"))).toBeDefined();
  });

  it("a long value is cut to its column, with a button that shows all of it", () => {
    table();
    expect(screen.queryByText(ROWS[0]!.note)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show the whole Note" }));
    expect(screen.getByText(new RegExp(`^${ROWS[0]!.note}`))).toBeDefined();
  });

  it("an id column is not rendered at all unless details are shown", () => {
    const { rerender } = table();
    expect(screen.queryByRole("columnheader", { name: "Id" })).toBeNull();
    expect(screen.queryByText(ROWS[0]!.id)).toBeNull();
    rerender(
      <AdminTable
        caption="Things"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        showIds
      />
    );
    expect(screen.getByRole("columnheader", { name: "Id" })).toBeDefined();
    expect(screen.getByText(ROWS[0]!.id)).toBeDefined();
  });

  it("a list read whole sorts by a header: by text, by number, both ways, said by aria-sort", () => {
    table();
    const names = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((r) => within(r).getAllByRole("cell")[0]!.textContent);
    expect(names()).toEqual(["Beta", "alpha"]);
    const header = screen.getByRole("columnheader", { name: /Name/ });
    expect(header).toHaveAttribute("aria-sort", "none");
    fireEvent.click(within(header).getByRole("button"));
    expect(names()).toEqual(["alpha", "Beta"]);
    expect(header).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(within(header).getByRole("button"));
    expect(names()).toEqual(["Beta", "alpha"]);
    expect(header).toHaveAttribute("aria-sort", "descending");
    // 2 before 10: numbers as numbers.
    fireEvent.click(
      within(screen.getByRole("columnheader", { name: /Size/ })).getByRole("button")
    );
    expect(names()).toEqual(["Beta", "alpha"]);
    // A column with no order of its own has no sort control.
    expect(screen.getByRole("columnheader", { name: "Note" })).not.toHaveAttribute(
      "aria-sort"
    );
  });

  it("where the route sorts and pages, the choice and the page go to the caller", () => {
    const onChange = jest.fn();
    const onPage = jest.fn();
    table({
      sort: {
        label: "Sort by",
        value: "new",
        options: [
          { id: "new", label: "Newest" },
          { id: "old", label: "Oldest" },
        ],
        onChange,
      },
      page: { offset: 25, size: 25, shown: 2, hasMore: true, total: 312, onPage },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), {
      target: { value: "old" },
    });
    expect(onChange).toHaveBeenCalledWith("old");
    expect(screen.getByText("26–27 of 312")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: ui("table.next") }));
    expect(onPage).toHaveBeenLastCalledWith(50);
    fireEvent.click(screen.getByRole("button", { name: ui("table.previous") }));
    expect(onPage).toHaveBeenLastCalledWith(0);
    expect(screen.getByRole("navigation", { name: "Pages of Things" })).toBeDefined();
  });

  it("the range: with a count, without one, capped, and for an empty page", () => {
    expect(pageRange({ offset: 0, shown: 25, total: 312 })).toBe("1–25 of 312");
    expect(pageRange({ offset: 50, shown: 3 })).toBe("51–53");
    expect(pageRange({ offset: 0, shown: 25, total: 10000, totalCapped: true })).toBe(
      "1–25 of more than 10000"
    );
    expect(pageRange({ offset: 0, shown: 0, total: 0 })).toBe("0–0 of 0");
  });

  it("no rows: its own sentence inside the card; busy: neither page button acts", () => {
    table({
      rows: [],
      empty: "Nothing here.",
      page: {
        offset: 25,
        size: 25,
        shown: 0,
        hasMore: true,
        busy: true,
        onPage: jest.fn(),
      },
    });
    expect(
      screen.getByText("Nothing here.").closest('[role="region"]')
    ).toHaveAccessibleName("Things");
    expect(screen.getByRole("button", { name: ui("table.next") })).toBeDisabled();
    expect(screen.getByRole("button", { name: ui("table.previous") })).toBeDisabled();
  });

  it("compact (a detail open beside it) leaves out the secondary columns; a row's open detail is current", () => {
    table({ compact: true, selectedKey: ROWS[1]!.id });
    expect(screen.queryByRole("columnheader", { name: "Made" })).toBeNull();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[1]).toHaveAttribute("aria-current", "true");
    expect(rows[0]).not.toHaveAttribute("aria-current");
  });
});

// ── the panel state ──────────────────────────────────────────────────────────────────────
// Every reply is the Users route's own (__tests__/fixtures/route-responses.json).
const LIST: RouteFixtureName =
  "POST /api/admin/users/search — Ann and a super admin who never signed in";
const ALONE: RouteFixtureName = "POST /api/admin/users/search — Ann alone";
const NONE: RouteFixtureName = "POST /api/admin/users/search — no accounts";
const reply = (name: RouteFixtureName) => {
  const [status, body] = routeAnswer(name);
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};
const messageOf = (name: RouteFixtureName) =>
  (routeAnswer(name)[1] as { message: string }).message;

function Panel({
  url = "/api/admin/users",
  again = 0,
}: {
  url?: string;
  again?: number;
}) {
  const { read, reload } = usePanelRead(url, again);
  return (
    <PanelState
      read={read}
      panel="Things"
      onReload={reload}
      empty={(body) =>
        Array.isArray(body.users) && body.users.length ? null : "No things."
      }
    >
      {(body) => (
        <ul>
          {(body.users as { id: string; displayName: string | null }[]).map((u) => (
            <li key={u.id}>{u.displayName || "no name"}</li>
          ))}
        </ul>
      )}
    </PanelState>
  );
}

describe("PanelState and usePanelRead", () => {
  it("reading: a status; then the panel, with when it was read and Refresh", async () => {
    fetchMock.mockResolvedValue(reply(ALONE));
    render(<Panel />);
    expect(screen.getByRole("status")).toHaveTextContent(
      ui("reading", { panel: "Things" })
    );
    expect(await screen.findByText("Ann")).toBeDefined();
    expect(screen.queryByText("no name")).toBeNull();
    expect(screen.getByText(/^Read at \d\d:\d\d$/)).toBeDefined();
    fetchMock.mockResolvedValue(reply(LIST));
    fireEvent.click(
      screen.getByRole("button", { name: ui("refresh_label", { panel: "Things" }) })
    );
    expect(await screen.findByText("no name")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a read that succeeded with nothing: the panel's own 'nothing here'", async () => {
    fetchMock.mockResolvedValue(reply(NONE));
    render(<Panel />);
    expect(await screen.findByText("No things.")).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // E-4: only a 503 was said; every other refusal was "not read yet" — "No items" or
  // "Loading…" for ever — and no answer at all rejected unhandled.
  it.each([
    [401, "POST /api/admin/users/search — refused (signed out)"],
    [403, "POST /api/admin/users/search — refused (no permission)"],
    [403, "POST /api/admin/users/search — refused (a suspended staff account)"],
    [403, "POST /api/admin/users/search — refused (no second factor)"],
    [429, "POST /api/admin/users/search — refused (rate limited)"],
    [500, "POST /api/admin/users/search — the store failing"],
    [503, "POST /api/admin/users/search — refused (the permissions store down)"],
  ] as [number, RouteFixtureName][])(
    "a read refused %i (%s) is said as a failed read — never empty, never loading",
    async (status, name) => {
      expect(routeAnswer(name)[0]).toBe(status);
      fetchMock.mockResolvedValue(reply(name));
      render(<Panel />);
      const failed = await screen.findByRole("alert");
      expect(failed).toHaveTextContent(messageOf(name));
      expect(failed).toHaveTextContent(
        renderMessage("screens.admin_console.unavailable_body", { panel: "Things" })
      );
      expect(failed).toHaveTextContent(
        status === 503
          ? renderMessage("screens.admin_console.unavailable_title")
          : ui("read_failed_title", { panel: "Things" })
      );
      // What the refusal's kind needs besides its sentence: when to try again.
      if (status === 429)
        expect(failed).toHaveTextContent(/You can try again in \d+ seconds?/);
      expect(screen.queryByText("No things.")).toBeNull();
      expect(screen.queryByText(ui("reading", { panel: "Things" }))).toBeNull();
      // Try again reads again, and a good answer replaces the failure.
      fetchMock.mockResolvedValue(reply(ALONE));
      fireEvent.click(
        within(failed).getByRole("button", { name: "Try reading Things again" })
      );
      expect(await screen.findByText("Ann")).toBeDefined();
      expect(screen.queryByRole("alert")).toBeNull();
    }
  );

  it("[hostile] no answer at all, and an answer that is not JSON: both said, neither thrown", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { unmount } = render(<Panel />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      renderMessage("screens.refusal.network")
    );
    unmount();
    // Not a route's answer: a gateway's page where JSON was expected.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    render(<Panel />);
    const failed = await screen.findByRole("alert");
    expect(failed).toHaveTextContent(renderMessage("screens.refusal.generic"));
    expect(failed).not.toHaveTextContent("Unexpected token");
  });

  it("read again: the last answer stays, said to be read again; a failed re-read replaces it whole", async () => {
    fetchMock.mockResolvedValueOnce(reply(ALONE));
    const { rerender } = render(<Panel again={0} />);
    await screen.findByText("Ann");
    let release: (value: unknown) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    rerender(<Panel again={1} />);
    expect(
      await screen.findByText(ui("reading_again", { panel: "Things" }))
    ).toBeDefined();
    expect(screen.getByText("Ann")).toBeDefined();
    expect(screen.getByRole("button", { name: /Read Things again/ })).toBeDisabled();
    await act(async () =>
      release(reply("POST /api/admin/users/search — the store failing"))
    );
    expect(await screen.findByRole("alert")).toBeDefined();
    // Never the earlier data under a failure, as if it were current.
    expect(screen.queryByText("Ann")).toBeNull();
  });

  it("an answer for a read since left is dropped", async () => {
    let first: (value: unknown) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => (first = resolve)));
    fetchMock.mockResolvedValueOnce(reply(NONE));
    const { rerender } = render(<Panel url="/api/admin/users?a" />);
    rerender(<Panel url="/api/admin/users?b" />);
    await screen.findByText("No things.");
    await act(async () => first(reply(ALONE)));
    expect(screen.queryByText("Ann")).toBeNull();
  });
});

// ── the outcome display ──────────────────────────────────────────────────────────────────
function Outcomes({ start }: { start: OutcomeEntry[] }) {
  const [list, setList] = React.useState(start);
  return (
    <>
      <button
        onClick={() =>
          setList((l) => [...l, outcome("held", "Later change", { next: "Wait." })])
        }
      >
        add
      </button>
      <OutcomeList
        outcomes={list}
        label="What happened"
        onDismiss={(id) => setList((l) => l.filter((o) => o.id !== id))}
      />
    </>
  );
}

describe("OutcomeList", () => {
  it("the region is there before anything is in it, and is a polite live region", () => {
    render(<Outcomes start={[]} />);
    const region = screen.getByRole("status", { name: "What happened" });
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();
  });

  it("says what changed, for whom and what happens next; its standing in words, each tone", () => {
    render(
      <Outcomes
        start={[
          outcome("applied", "Role changed.", {
            who: "ann@example.test",
            next: "They sign in again.",
          }),
          outcome("held", "The change waits.", {
            next: "A second administrator decides.",
          }),
          outcome("unrecorded", "The setting changed."),
          outcome("refused", "Not allowed."),
        ]}
      />
    );
    const [applied, held, unrecorded, refused] = [
      ...document.querySelectorAll<HTMLElement>("[data-outcome]"),
    ];
    expect(applied).toHaveTextContent("Done");
    expect(applied).toHaveTextContent("For: ann@example.test");
    expect(applied).toHaveTextContent("Next: They sign in again.");
    expect(held).toHaveAttribute("data-outcome", "held");
    expect(held).toHaveTextContent("Held for approval");
    expect(held).toHaveTextContent("Next: A second administrator decides.");
    expect(unrecorded).toHaveTextContent("Done, but not recorded");
    expect(refused).toHaveTextContent("Not done");
    // Held is not the failure colour (SF-admin-022): three tones, three colours.
    const colour = (el: HTMLElement) => /border-(\w+)-\d+/.exec(el.className)![1];
    expect(
      new Set([applied, held, unrecorded, refused].map((el) => colour(el!))).size
    ).toBe(4);
  });

  it("stays until its own Dismiss; a later outcome adds to the list and takes focus", async () => {
    render(<Outcomes start={[outcome("applied", "First change")]} />);
    const first = screen
      .getByText("First change")
      .closest<HTMLElement>("[data-outcome]")!;
    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "add" }));
    const later = screen
      .getByText("Later change")
      .closest<HTMLElement>("[data-outcome]")!;
    await waitFor(() => expect(later).toHaveFocus());
    expect(first).toBeInTheDocument();
    const dismiss = within(first).getByRole("button", { name: ui("outcome.dismiss") });
    // Which outcome the button dismisses is said (its description is the outcome).
    expect(dismiss).toHaveAccessibleDescription(/First change/);
    fireEvent.click(dismiss);
    expect(screen.queryByText("First change")).toBeNull();
    expect(later).toBeInTheDocument();
  });

  it("a refusal's sentence once, with what its kind needs besides", () => {
    const limited = refusedOutcome({
      kind: "retry-after",
      code: "rate.limited",
      message: "Too many requests.",
      retryAfterSeconds: 30,
      params: {},
    });
    render(<OutcomeList outcomes={[limited]} label="x" onDismiss={jest.fn()} />);
    expect(screen.getAllByText("Too many requests.")).toHaveLength(1);
    expect(screen.getByText(/30 seconds/)).toBeDefined();
  });
});

// ── the confirmation step ────────────────────────────────────────────────────────────────
describe("ConfirmStep", () => {
  function Opener(props: Partial<React.ComponentProps<typeof ConfirmStep>> = {}) {
    const [open, setOpen] = React.useState(false);
    const button = React.useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={button} onClick={() => setOpen(true)}>
          open
        </button>
        {open && (
          <ConfirmStep
            action="users.change_role"
            title="Change the role of Ann"
            confirmLabel="Change the role"
            returnFocus={button}
            onConfirm={jest.fn()}
            onCancel={() => setOpen(false)}
            {...props}
          />
        )}
      </>
    );
  }

  it("takes focus when it opens; Cancel and Escape give it back to what opened it", async () => {
    render(<Opener />);
    const open = screen.getByRole("button", { name: "open" });
    fireEvent.click(open);
    const dialog = screen.getByRole("alertdialog", { name: "Change the role of Ann" });
    await waitFor(() => expect(dialog).toHaveFocus());
    fireEvent.click(within(dialog).getByRole("button", { name: confirmWords("cancel") }));
    await waitFor(() => expect(open).toHaveFocus());
    fireEvent.click(open);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    await waitFor(() => expect(open).toHaveFocus());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("an irreversible action is marked so in words, says what will be lost, and its button is the danger button", () => {
    render(<Opener action="users.erase" confirmLabel="Ask for erasure" />);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAttribute("data-risk", "irreversible");
    expect(dialog).toHaveAccessibleDescription(
      new RegExp(confirmWords("irreversible").replace(".", "\\."))
    );
    expect(dialog).toHaveTextContent(confirmWords("consequence.purge_user_data"));
    expect(
      within(dialog).getByRole("button", { name: "Ask for erasure" }).className
    ).toMatch(/bg-red-/);
  });

  it("an action that can be changed back is not marked irreversible", () => {
    render(<Opener />);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAttribute("data-risk", "consequential");
    expect(dialog).not.toHaveTextContent(confirmWords("irreversible"));
    expect(dialog).toHaveTextContent(confirmWords("consequence.change_user_role"));
  });

  it("[hostile] an action the registry does not know is consequential, never waved through", () => {
    render(<Opener action="nobody.knows_this" />);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(screen.getByRole("alertdialog")).toHaveAttribute("data-risk", "consequential");
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      confirmWords("consequence.unknown")
    );
  });

  // P5: eight screens asked for a reason eight ways (a minimum of 1, of 3, unstated, a button
  // that just stayed grey). One field, one minimum, said before the mistake.
  it("a required reason: its minimum is said up front; too short is said at the field, and nothing is confirmed", () => {
    const onConfirm = jest.fn();
    render(
      <Opener
        action="jobs.discard"
        confirmLabel="Discard the job"
        onConfirm={onConfirm}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    const reason = screen.getByRole("textbox", { name: confirmWords("reason_label") });
    expect(reason).toHaveAccessibleDescription(confirmWords("reason_help", { min: 3 }));
    expect(reason).toHaveAttribute("maxLength", "500");
    const confirm = screen.getByRole("button", { name: "Discard the job" });
    expect(confirm).not.toBeDisabled();
    fireEvent.change(reason, { target: { value: " a " } });
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(reason).toHaveAttribute("aria-invalid", "true");
    expect(reason).toHaveAccessibleDescription(
      new RegExp(confirmWords("reason_short", { min: 3 }).replace(".", "\\."))
    );
    expect(reason).toHaveFocus();
    fireEvent.change(reason, { target: { value: "  stuck for a week  " } });
    expect(reason).not.toHaveAttribute("aria-invalid");
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ reason: "stuck for a week" });
  });

  it("kinds of reason to choose from are a labelled choice, and the one chosen is given", () => {
    const onConfirm = jest.fn();
    render(
      <Opener
        action="users.erase"
        confirmLabel="Ask"
        choiceLabel="Why?"
        choices={[
          { value: "a", label: "First" },
          { value: "b", label: "Second" },
        ]}
        onConfirm={onConfirm}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    // No free text is asked where the registry asks for none.
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Why?" }), {
      target: { value: "b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(onConfirm).toHaveBeenCalledWith({ reason: "", choice: "b" });
  });

  it("busy: says so, and neither button nor Escape acts", () => {
    const onCancel = jest.fn();
    render(
      <ConfirmStep
        action="users.erase"
        title="t"
        confirmLabel="Go"
        busy
        onConfirm={jest.fn()}
        onCancel={onCancel}
      />
    );
    expect(screen.getByRole("button", { name: confirmWords("working") })).toBeDisabled();
    expect(screen.getByRole("button", { name: confirmWords("cancel") })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});

// ── the permission gate ──────────────────────────────────────────────────────────────────
describe("GatedButton", () => {
  it("allowed: the control", () => {
    const onClick = jest.fn();
    render(
      <GatedButton allowed onClick={onClick}>
        Approve
      </GatedButton>
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onClick).toHaveBeenCalled();
  });

  it("refused with a reason: disabled, the reason beside it and tied to it — by the permission's name", () => {
    const onClick = jest.fn();
    render(
      <GatedButton
        allowed={false}
        reason={needsPermission("admin_manage_users")}
        onClick={onClick}
      >
        Approve
      </GatedButton>
    );
    const button = screen.getByRole("button", { name: "Approve" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Needs the permission “Manage users”.");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.queryByText(/admin_manage_users/)).toBeNull();
  });

  it("refused with no reason: not offered at all", () => {
    render(
      <GatedButton allowed={false} onClick={jest.fn()}>
        Approve
      </GatedButton>
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});

// ── the labels ───────────────────────────────────────────────────────────────────────────
describe("labels: a name for every code, never the code", () => {
  it("the catalogue's name where it has one", () => {
    expect(permissionLabel("admin_manage_users")).toBe("Manage users");
    expect(tableLabel("audit_log")).toBe("the audit log");
    expect(tableLabel("role_permissions")).toBe("role permissions");
    expect(filterLabel("signed_in_within_days")).toBe("the days since the last sign-in");
    expect(toolLabel("change_user_role")).toBe("Change an account's role");
    expect(columnLabel("last_sign_in_at")).toBe("Last sign-in");
    expect(roleLabel("super_admin", "Super Admin")).toBe("Super admin");
    // A job's short name (TASK-221) — its description is screens.jobs.kinds.
    expect(jobKindLabel("data.retention")).toBe("Data retention");
    expect(jobKindLabel("gdpr.retention-purge")).toBe("Erasure purge");
  });

  it.each([
    [permissionLabel, "can_do_new_thing", "Can do new thing"],
    [tableLabel, "new_table", "New table"],
    [filterLabel, "some_filter", "Some filter"],
    [featureLabel, "translate", "Translate"],
    [columnLabel, "unnamed_col", "Unnamed col"],
    [jobKindLabel, "app.new-job", "App new job"],
    [roleLabel, "qa_lead", "Qa lead"],
  ])(
    "[hostile] a code the catalogue does not name is made readable (%#)",
    (label, code, expected) => {
      const said = (label as (code: string) => string)(code);
      expect(said).toBe(expected);
      expect(said).not.toContain("_");
      expect(said).not.toMatch(/^screens\./);
    }
  );

  it("a setting by a readable name; an unknown tool said to be one", () => {
    expect(settingLabel("moderation.strike_ban_threshold")).toBe(
      "Moderation: strike ban threshold"
    );
    expect(settingLabel("signups_enabled")).toBe("Signups enabled");
    expect(toolLabel("drop_everything")).toBe("Action Drop everything");
    expect(readableCode("")).toBe("");
  });

  it("initialisms as people write them, a level's number its own word (the walk's setting names)", () => {
    expect(settingLabel("moderation.escalation_sla_hours")).toBe(
      "Moderation: escalation SLA hours"
    );
    expect(settingLabel("ai.daily_paid_requests_per_actor")).toBe(
      "AI: daily paid requests per actor"
    );
    expect(settingLabel("auth.staff_mfa_required")).toBe("Auth: staff MFA required");
    expect(settingLabel("moderation.level1_block_severity")).toBe(
      "Moderation: level 1 block severity"
    );
    expect(readableCode("coppa.enforcement_enabled")).toBe("COPPA enforcement enabled");
    expect(readableCode("user_id")).toBe("User ID");
    // A word that only contains one is left alone.
    expect(readableCode("maintenance_said")).toBe("Maintenance said");
  });

  it("a person by name, else address, else what they are; the id only as a detail", () => {
    const { rerender } = render(
      <PersonRef person={{ email: "ann@example.test" }} name="Ann" id="u-1" />
    );
    expect(screen.getByText("Ann")).toBeDefined();
    expect(screen.queryByText("u-1")).toBeNull();
    rerender(<PersonRef person={{ email: "ann@example.test" }} id="u-1" showId />);
    expect(screen.getByText(/ann@example\.test/)).toBeDefined();
    expect(screen.getByText("u-1")).toBeDefined();
    rerender(<PersonRef person={{ email: null, erased: true }} id="u-1" />);
    expect(
      screen.getByText(renderMessage("screens.admin_console.people.erased"))
    ).toBeDefined();
    rerender(<PersonRef person={null} />);
    expect(
      screen.getByText(renderMessage("screens.admin_console.people.unknown"))
    ).toBeDefined();
    rerender(<IdDetail id="u-1" show={false} />);
    expect(screen.queryByText("u-1")).toBeNull();
  });
});

// ── the call helper ──────────────────────────────────────────────────────────────────────
describe("adminCall", () => {
  it("a 2xx is ok with its body — a 202 too: a held change is not a refusal", async () => {
    const held: RouteFixtureName = "PATCH /api/admin/users — held for a second admin";
    fetchMock.mockResolvedValueOnce(reply(held));
    const said = await adminCall("/api/admin/users", { method: "PATCH", json: { a: 1 } });
    expect(said).toEqual({ ok: true, status: 202, body: routeAnswer(held)[1] });
    expect(said.ok && said.body.held).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/admin/users");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ a: 1 });
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("a body goes with the method it names; neither is a plain read, a GET", async () => {
    fetchMock.mockResolvedValue(reply(NONE));
    await adminCall("/api/admin/x", { method: "POST", json: {} });
    expect(fetchMock.mock.calls[0]![1].method).toBe("POST");
    await adminCall("/api/admin/x");
    expect(fetchMock.mock.calls[1]![1].method).toBe("GET");
    expect(fetchMock.mock.calls[1]![1].body).toBeUndefined();
    // A body with no method is refused by the type: the method is always said where it is sent
    // (TASK-218's guard reads it there).
    // @ts-expect-error — a body names its method
    await adminCall("/api/admin/x", { json: {} });
  });

  it("a refusal is its code's sentence — never the code — with the body's own fields", async () => {
    const name: RouteFixtureName =
      "POST /api/admin/approvals/[id] — approved, the run failed";
    fetchMock.mockResolvedValueOnce(reply(name));
    const refused = await adminCall("/api/admin/approvals/p", {
      method: "POST",
      json: {},
    });
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.refusal.code).toBe("approvals.run_failed");
    expect(refused.refusal.message).toBe(messageOf(name));
    expect(refused.refusal.message).not.toContain("approvals.run_failed");
    // What the decision route says of the approval travels with the refusal.
    expect(refused.body.approvalKept).toBe(true);
    expect(refused.status).toBe(503);
  });

  it("[hostile] a coded refusal with no message, an uncoded one, a list, no body: a sentence, never raw text", async () => {
    // Not a route's answers: what a proxy or a broken gateway sends in a route's place.
    const coded = refusalFrom(409, { code: "approvals.self_approval" });
    expect(coded.message).toBe(renderMessage(messageKey("approvals.self_approval")));
    expect(coded.message).not.toContain("approvals.self_approval");
    for (const text of ['{"error":""}', '["not","an","object"]', "null", '"text"']) {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => JSON.parse(text),
      });
      const refused = await adminCall("/api/admin/x");
      expect(refused.ok).toBe(false);
      if (!refused.ok)
        expect([text, refused.refusal.message]).toEqual([
          text,
          renderMessage("screens.refusal.generic"),
        ]);
    }
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 504,
      json: async () => Promise.reject(new Error("no body")),
    });
    const none = await adminCall("/api/admin/x");
    expect(none.ok || none.refusal.message).toBe(
      renderMessage("screens.refusal.generic")
    );
  });

  it("no answer at all: the network refusal — it never throws", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const refused = await adminCall("/api/admin/x", { method: "DELETE" });
    expect(refused).toEqual({
      ok: false,
      refusal: expect.objectContaining({
        kind: "service-unavailable",
        message: renderMessage("screens.refusal.network"),
      }),
      body: {},
    });
  });

  it("an account that no longer exists ends the session, once, for every screen", () => {
    const ended = jest.fn();
    window.addEventListener(SESSION_END_EVENT, ended);
    const refused = refusalFrom(404, { code: "account.not_found" });
    refusalFrom(403, { code: "auth.permission_denied" });
    window.removeEventListener(SESSION_END_EVENT, ended);
    expect(refused.kind).toBe("signed-out-erased");
    expect(ended).toHaveBeenCalledTimes(1);
  });
});

// ── the detail panel, the field ──────────────────────────────────────────────────────────
describe("DetailPanel and Field", () => {
  function Detail() {
    const [open, setOpen] = React.useState(false);
    return (
      <DetailLayout
        detail={
          open ? (
            <DetailPanel
              title="Account: Ann"
              onClose={() => setOpen(false)}
              returnFocus={() => document.getElementById("opener")}
            >
              <p>facts</p>
            </DetailPanel>
          ) : null
        }
      >
        <button id="opener" onClick={() => setOpen(true)}>
          open
        </button>
      </DetailLayout>
    );
  }

  it("opens as a labelled region whose heading takes focus; Close and Escape return focus to the opener", async () => {
    render(<Detail />);
    const opener = screen.getByRole("button", { name: "open" });
    fireEvent.click(opener);
    const panel = screen.getByRole("region", { name: "Account: Ann" });
    await waitFor(() => expect(within(panel).getByRole("heading")).toHaveFocus());
    fireEvent.click(within(panel).getByRole("button", { name: ui("detail_close") }));
    await waitFor(() => expect(opener).toHaveFocus());
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole("region", { name: "Account: Ann" }), {
      key: "Escape",
    });
    await waitFor(() => expect(opener).toHaveFocus());
    expect(screen.queryByRole("region", { name: "Account: Ann" })).toBeNull();
  });

  it("one placement: beside the list when wide, in its place when narrow", () => {
    render(<Detail />);
    const layout = document.querySelector("[data-detail-open]")!;
    expect(layout).toHaveAttribute("data-detail-open", "false");
    expect(layout.querySelector("[data-detail-list]")!.className).not.toMatch(/hidden/);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(layout).toHaveAttribute("data-detail-open", "true");
    expect(layout.className).toMatch(/xl:grid-cols-\[minmax\(0,1fr\)_22rem\]/);
    expect(layout.querySelector("[data-detail-list]")!.className).toMatch(
      /\bhidden xl:block\b/
    );
  });

  it("a field ties its label, its help and its error to the control; the error is announced", () => {
    const { rerender } = render(
      <Field label="Reason" help="At least 3 characters.">
        {(control) => <TextInput {...control} />}
      </Field>
    );
    const input = screen.getByRole("textbox", { name: "Reason" });
    expect(input).toHaveAccessibleDescription("At least 3 characters.");
    expect(input).not.toHaveAttribute("aria-invalid");
    rerender(
      <Field label="Reason" help="At least 3 characters." error="Too short.">
        {(control) => <TextInput {...control} />}
      </Field>
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("At least 3 characters. Too short.");
    expect(screen.getByRole("alert")).toHaveTextContent("Too short.");
  });
});
