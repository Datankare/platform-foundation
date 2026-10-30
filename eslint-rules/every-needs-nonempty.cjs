/**
 * eslint-rules/every-needs-nonempty.cjs — `expect(xs.every(…)).toBe(true)` holds on an empty list
 * (TASK-198, D-19)
 *
 * `[].every(p)` is true, so an assertion that every item satisfies a predicate passes when there
 * are no items at all — a mock never called, a query that matched nothing (config-impact's "every
 * query has no level", social-jobs' "every run is the curator's"). This rule asks for a non-empty
 * assertion on the same list earlier in the same test:
 *
 *   expect(xs).toHaveLength(3)               expect(xs.length).toBeGreaterThan(0)
 *   expect(xs.map(f)).toEqual([a, b])        expect(xs).toContain(a)
 *   expect(fn).toHaveBeenCalledTimes(2)      (for xs = fn.mock.calls)
 *
 * with `expect(xs.every(…)).toBe(true)` (or toBeTruthy / toEqual(true) / toStrictEqual(true)).
 * The list is matched by its source text, so a computed one (`results.filter(…)`) is named first:
 * `const failed = results.filter(…)`.
 */
"use strict";

const TRUE_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual", "toBeTruthy"]);

/** The `expect(arg)` call a matcher chain starts from, and whether `.not` is in it. */
function expectOf(member) {
  let node = member.object;
  let negated = false;
  if (node.type === "MemberExpression" && node.property.name === "not") {
    negated = true;
    node = node.object;
  }
  if (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "expect"
  )
    return { call: node, negated };
  return null;
}

/** The index just past the `)` that closes the `(` at `open`, or -1. */
function closing(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** A matcher argument that says "not empty / not zero". */
function nonEmptyArg(matcher, arg) {
  const a = arg.trim();
  // A number literal (an integer or a decimal), or NaN when the argument is not one.
  const n = /^-?\d+(?:\.\d+)?$/.test(a) ? Number(a) : NaN;
  switch (matcher) {
    case "toContain":
    case "toContainEqual":
    case "toHaveBeenCalled":
      return true;
    // A length (or a call count) greater than a number ≥ 0 is at least one (round 1: not -1).
    case "toBeGreaterThan":
      return n >= 0;
    case "toBeGreaterThanOrEqual":
      return n >= 1;
    case "toHaveLength":
    case "toHaveBeenCalledTimes":
      // A literal must be ≥ 1; a name (a constant length) is taken as given.
      return Number.isNaN(n) ? a.length > 0 && !/^-/.test(a) : n >= 1;
    case "toBe":
    case "toEqual":
    case "toStrictEqual":
      // A number ≥ 1, or a non-empty array literal.
      return n >= 1 || /^\[\s*[^\]\s]/.test(a);
    default:
      return false;
  }
}

/**
 * Whether `text` (the test's other statements) asserts that `list` is non-empty: an
 * `expect(<list>…)` — the list itself, its length, a map or filter of it — with a matcher that
 * fails on an empty one. For `fn.mock.calls`, `expect(fn).toHaveBeenCalled[Times(n)]` too.
 */
function assertsNonEmpty(text, list) {
  const mock = /^(.*)\.mock\.calls$/.exec(list);
  const subjects = mock ? [list, mock[1]] : [list];
  for (const subject of subjects) {
    let from = 0;
    for (;;) {
      const at = text.indexOf("expect(", from);
      if (at < 0) break;
      from = at + 1;
      const open = at + "expect".length;
      const inner = text.slice(open + 1).trimStart();
      if (!inner.startsWith(subject)) continue;
      const next = inner[subject.length];
      if (next !== ")" && next !== "." && next !== "[" && !/\s/.test(next)) continue;
      if (inner.slice(subject.length).startsWith(".every(")) continue;
      const end = closing(text, open);
      if (end < 0) continue;
      const m = /^\s*\.\s*(\w+)\s*\(/.exec(text.slice(end));
      if (!m) continue;
      const argOpen = end + m[0].length - 1;
      const argEnd = closing(text, argOpen);
      if (argEnd < 0) continue;
      if (nonEmptyArg(m[1], text.slice(argOpen + 1, argEnd - 1))) return true;
    }
  }
  return false;
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "expect(xs.every(…)) passes on an empty list: assert xs is non-empty before it",
    },
    schema: [],
    messages: {
      empty:
        "`{{list}}.every(…)` is true when `{{list}}` is empty: assert it is non-empty first (expect({{list}}).toHaveLength(n), or expect({{list}}.length).toBeGreaterThan(0)) — TASK-198 D-19.",
    },
  },
  create(context) {
    const source = context.sourceCode ?? context.getSourceCode();
    return {
      "CallExpression > MemberExpression.callee"(member) {
        if (
          member.property.type !== "Identifier" ||
          !TRUE_MATCHERS.has(member.property.name)
        )
          return;
        const matcher = member.parent;
        const found = expectOf(member);
        if (!found || found.negated) return;
        const name = member.property.name;
        if (name !== "toBeTruthy") {
          const arg = matcher.arguments[0];
          if (!arg || arg.type !== "Literal" || arg.value !== true) return;
        }
        const tested = found.call.arguments[0];
        if (
          !tested ||
          tested.type !== "CallExpression" ||
          tested.callee.type !== "MemberExpression" ||
          tested.callee.property.type !== "Identifier" ||
          tested.callee.property.name !== "every"
        )
          return;
        const list = source.getText(tested.callee.object);
        // The enclosing function (the test's callback): what comes before this assertion in it.
        let fn = matcher.parent;
        while (
          fn &&
          fn.type !== "ArrowFunctionExpression" &&
          fn.type !== "FunctionExpression" &&
          fn.type !== "FunctionDeclaration"
        )
          fn = fn.parent;
        const body = fn ? source.getText(fn) : source.text;
        // Before or after the every(): either fails the test on an empty list.
        const own = source.getText(matcher);
        if (assertsNonEmpty(body.replace(own, ""), list)) return;
        context.report({ node: matcher, messageId: "empty", data: { list } });
      },
    };
  },
};

module.exports = rule;
module.exports.assertsNonEmpty = assertsNonEmpty;
