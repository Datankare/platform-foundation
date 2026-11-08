/**
 * @jest-environment node
 */
/**
 * __tests__/admin-usability-units.test.ts — the pure parts of the admin console's usability fixes
 * (TASK-202): a search scoped to its screen (N-65), a setting's value read by its type (N-60),
 * a list change's diff (N-61), a person named by address (N-63), and who may approve an erasure's
 * attestation (S3-E19).
 */
import {
  namesTable,
  scopeSearches,
  SECTION_SEARCH_TABLES,
} from "@/app/api/admin/ai/search-scope";
import {
  inputFor,
  listChange,
  readInput,
  sameValue,
  shownValue,
  type SettingRules,
} from "@/components/admin/config-value";
import { personText } from "@/components/admin/people";
import { secondOperatorAvailable } from "@/platform/gdpr/erasure-status";
import { renderMessage } from "@/platform/errors/messages";
import { SEARCHABLE_TABLES } from "@/app/api/admin/ai/tool-permissions";

const search = (table: string) => ({ tool: "search", input: { table } });

describe("a search reads its own screen unless another table is named (N-65)", () => {
  it("drops the other tables the planner added on the config screen, and says which", () => {
    const out = scopeSearches("platform-config", "find the moderation threshold", [
      search("platform_config"),
      search("permissions"),
      search("audit_log"),
    ]);
    expect(out.actions).toEqual([search("platform_config")]);
    expect(out.dropped).toEqual(["permissions", "audit_log"]);
  });

  it("keeps a table the request names, by any of its words, whole words only", () => {
    expect(
      scopeSearches("platform-config", "show the audit log for this key", [
        search("platform_config"),
        search("audit_log"),
      ]).actions
    ).toHaveLength(2);
    expect(namesTable("who changed the setting?", "platform_config")).toBe(true);
    // "auditor" is not "audit"; "settingsx" is not "settings".
    expect(namesTable("ask the auditor", "audit_log")).toBe(false);
    expect(namesTable("settingsx", "platform_config")).toBe(false);
  });

  it("never drops an action that is not a search, a search with no known table, or one on a screen with no tables", () => {
    const other = { tool: "update_config", input: { key: "k" } };
    const odd = { tool: "search", input: { table: 7 } };
    const unknown = search("not_a_table");
    expect(scopeSearches("platform-config", "x", [other, odd, unknown]).actions).toEqual([
      other,
      odd,
      unknown,
    ]);
    // Approvals has no table of its own: every search stays.
    expect(scopeSearches("approvals", "x", [search("users")]).dropped).toEqual([]);
    // A section name that is an Object.prototype key is not a section.
    expect(scopeSearches("constructor", "x", [search("users")]).dropped).toEqual([]);
  });

  it("each dropped table is listed once", () => {
    expect(
      scopeSearches("users", "x", [search("roles"), search("roles")]).dropped
    ).toEqual(["roles"]);
  });

  it("every section's tables are searchable tables", () => {
    for (const tables of Object.values(SECTION_SEARCH_TABLES))
      for (const t of tables) expect(Object.keys(SEARCHABLE_TABLES)).toContain(t);
  });
});

const rules = (over: Partial<SettingRules>): SettingRules => ({
  valueType: "string",
  minValue: null,
  maxValue: null,
  allowedValues: null,
  ...over,
});

describe("a setting's value read by its type (N-60)", () => {
  it("a number within its range; outside it, or not a number, says why", () => {
    const r = rules({ valueType: "number", minValue: 1, maxValue: 10 });
    expect(readInput(r, "5")).toEqual({ ok: true, value: 5 });
    expect(readInput(r, "0")).toEqual({
      ok: false,
      problem: renderMessage("screens.admin_console.config.number_below", { min: 1 }),
    });
    expect(readInput(r, "11")).toEqual({
      ok: false,
      problem: renderMessage("screens.admin_console.config.number_above", { max: 10 }),
    });
    expect(readInput(r, "abc").ok).toBe(false);
    expect(readInput(r, "  ").ok).toBe(false);
    expect(readInput(rules({ valueType: "number" }), "-3.5")).toEqual({
      ok: true,
      value: -3.5,
    });
  });

  it("a list is JSON that parses to a list; an object or bad JSON is refused before it is sent", () => {
    const r = rules({ valueType: "json_array" });
    expect(readInput(r, '["a", "b"]')).toEqual({ ok: true, value: ["a", "b"] });
    expect(readInput(r, '{"a": 1}')).toEqual({
      ok: false,
      problem: renderMessage("screens.admin_console.config.json_not_array"),
    });
    const bad = readInput(r, "[1,");
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.problem).toMatch(/not valid JSON/);
  });

  it("a boolean from the switch; text and a choice not empty", () => {
    expect(readInput(rules({ valueType: "boolean" }), true)).toEqual({
      ok: true,
      value: true,
    });
    expect(readInput(rules({ valueType: "boolean" }), false)).toEqual({
      ok: true,
      value: false,
    });
    expect(readInput(rules({ valueType: "string" }), " ").ok).toBe(false);
    expect(readInput(rules({ valueType: "string_enum" }), "high")).toEqual({
      ok: true,
      value: "high",
    });
  });

  it("an input starts from the value: JSON laid out for a list, on/off for a boolean", () => {
    expect(inputFor(rules({ valueType: "json_array" }), ["a"])).toBe('[\n  "a"\n]');
    expect(inputFor(rules({ valueType: "json_array" }), null)).toBe("[]");
    expect(inputFor(rules({ valueType: "boolean" }), true)).toBe(true);
    expect(inputFor(rules({ valueType: "number" }), 3)).toBe("3");
    expect(inputFor(rules({ valueType: "string" }), null)).toBe("");
  });
});

describe("a change shown as before → after (N-61)", () => {
  it("a list's items added and removed, each once as JSON", () => {
    expect(listChange(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], removed: ["a"] });
    expect(listChange([["agent:x", { s: 1 }]], [])).toEqual({
      added: [],
      removed: ['["agent:x",{"s":1}]'],
    });
    expect(listChange(1, 2)).toBeUndefined();
  });

  it("values in words; the same value is the same", () => {
    expect(shownValue(true)).toBe(
      renderMessage("screens.admin_console.config.boolean_on")
    );
    expect(shownValue("x")).toBe("x");
    expect(shownValue([1])).toBe("[1]");
    expect(shownValue(undefined)).toBe(renderMessage("screens.held.diff_unknown"));
    expect(sameValue([1, 2], [1, 2])).toBe(true);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
  });
});

describe("a person named by address, never by id (N-63)", () => {
  it("by address, with the role when asked; erased, unknown and address-less said so", () => {
    expect(personText({ email: "a@x.test" })).toBe("a@x.test");
    expect(personText({ email: "a@x.test", role: "Admin" }, true)).toBe(
      "a@x.test (Admin)"
    );
    expect(personText({ email: null, erased: true })).toBe(
      renderMessage("screens.admin_console.people.erased")
    );
    expect(personText(null)).toBe(renderMessage("screens.admin_console.people.unknown"));
    expect(personText({ email: null })).toBe(
      renderMessage("screens.admin_console.people.no_email")
    );
  });
});

describe("who may approve an erasure's attestation (S3-E19; the rule is unchanged)", () => {
  const op = (id: string, sub: string | null = null) => ({ id, sub });
  it("one operator: nobody can approve, whether or not a request is open", () => {
    expect(secondOperatorAvailable([op("a")], undefined)).toBe(false);
    expect(secondOperatorAvailable([op("a")], "a")).toBe(false);
  });
  it("two operators: the other may approve the first one's request", () => {
    expect(secondOperatorAvailable([op("a"), op("b")], undefined)).toBe(true);
    expect(secondOperatorAvailable([op("a"), op("b")], "a")).toBe(true);
  });
  it("[hostile:id-spelling] the requester in another spelling is still the requester", () => {
    // An upper-case id, or the identity subject, names the same operator: no second one.
    const id = "0b7c1d2e-3f40-4a51-8b62-7c83d94ea5f6";
    expect(secondOperatorAvailable([op(id, "sub-1")], id.toUpperCase())).toBe(false);
    expect(secondOperatorAvailable([op(id, "sub-1")], `{${id}}`)).toBe(false);
    expect(secondOperatorAvailable([op(id, "sub-1")], "sub-1")).toBe(false);
    // A subject that is no UUID compares exactly: another subject is another operator.
    expect(secondOperatorAvailable([op(id, "sub-1")], "SUB-1")).toBe(true);
  });
  it("no operator: none", () => {
    expect(secondOperatorAvailable([], undefined)).toBe(false);
  });
});
