/**
 * __tests__/helpers/input-reads-scan.ts — the input keys a handler reads, from its code
 * (TASK-194 round 11, item 2; round 12, I-3)
 *
 * Reads the TypeScript of a set of files (compiler API) and follows one parameter — the action's
 * input — through a handler. It looks at every place the input is used, and each is one of:
 *
 *   a key read      `input.x`, `input["x"]`, `input[CONST]` (as `[CONST]`), `const { x } = input`,
 *                   a parameter destructured where it is declared, `"x" in input`,
 *                   `Object.prototype.hasOwnProperty.call(input, "x")`
 *   passed on       a call to a function of the scanned files — that function's parameter followed
 *                   in turn; an object of functions' members too (`rule.facts`), and a member a
 *                   factory builds (`facts: roleNamed("role_name")`: the factory's returned
 *                   function, its parameters bound to the literals it was given)
 *   an alias        `const i = input` (as T, ?? {}): followed as the input
 *   no key read     a test of the input itself (`!input`, `typeof input`, `input === x`)
 *   every key       `Object.entries/keys/values(input)`, `{ ...input }`, `for (… in input)`,
 *                   a rest element (`const { a, ...rest } = input`) — `whole`
 *   a computed key  `input[k]`, `{ [k]: v } = input`, `k in input` — `dynamic`
 *
 * Anything else — a call it cannot follow, the input put inside an object or a list, assigned
 * to a name (`x = input`), returned, or a factory member it cannot bind — is `unresolved`, by
 * what it is, for the guard to fail on: never dropped silently.
 */

import { readFileSync } from "node:fs";
import * as ts from "typescript";

type FnNode = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** A function to follow, with its parameters bound to literals when a factory built it. */
export interface Fn {
  readonly node: FnNode;
  readonly bindings?: ReadonlyMap<string, string>;
}

/** The functions of a set of files, and the object members among them it could not resolve. */
export type Functions = Map<string, Fn> & {
  readonly unresolvedMembers: Map<string, string>;
  /** Names defined in more than one of the files: a call by name cannot say which (round 13). */
  readonly ambiguous: Set<string>;
};

export interface InputReads {
  /** Each key read, with the functions it was read in. */
  readonly keys: Map<string, Set<string>>;
  /** Functions that read every key. */
  readonly whole: Set<string>;
  /** Functions that read a key computed at run time. */
  readonly dynamic: Set<string>;
  /** What the scan cannot follow, by what it is. */
  readonly unresolved: Set<string>;
}

const WHOLE_READERS = new Set(["Object.entries", "Object.keys", "Object.values"]);
const RULE_MEMBERS = new Set(["facts", "beforeFacts", "decide"]);

function skipCasts(e: ts.Expression): ts.Expression {
  let x = e;
  while (
    ts.isAsExpression(x) ||
    ts.isParenthesizedExpression(x) ||
    ts.isNonNullExpression(x) ||
    ts.isTypeAssertionExpression(x) ||
    ts.isSatisfiesExpression(x)
  )
    x = x.expression;
  return x;
}

/** The function a factory returns: `return (…) => …`, or a concise arrow body. */
function returnedFunction(fn: FnNode): FnNode | undefined {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
    const b = skipCasts(fn.body);
    return ts.isArrowFunction(b) || ts.isFunctionExpression(b) ? b : undefined;
  }
  let found: FnNode | undefined;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isReturnStatement(n) && n.expression) {
      const r = skipCasts(n.expression);
      if (ts.isArrowFunction(r) || ts.isFunctionExpression(r)) found = r;
      return;
    }
    if (ts.isFunctionLike(n) && n !== fn) return;
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
}

/** The name an object literal property is under, when it is a plain one. */
function memberName(prop: ts.ObjectLiteralElementLike): string | undefined {
  if (ts.isShorthandPropertyAssignment(prop)) return prop.name.text;
  if (
    (ts.isPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) &&
    ts.isIdentifier(prop.name)
  )
    return prop.name.text;
  return undefined;
}

/**
 * Every named function of `files`: declarations, `const f = (…) => …`, and the members of an
 * object of functions (`const rule = { facts: …, decide: decideX }`) as `rule.facts` and
 * `rule.decide` — an inline function, a named one, or one a factory of the files builds from
 * literal arguments. A member it cannot resolve is listed in `unresolvedMembers`, with why.
 */
export function functionsOf(files: readonly string[]): Functions {
  const out = new Map<string, Fn>() as Map<string, Fn> & {
    unresolvedMembers: Map<string, string>;
    ambiguous: Set<string>;
  };
  out.unresolvedMembers = new Map();
  out.ambiguous = new Set();
  const fileOf = new Map<string, string>();
  /** A name's function, unless another file defines the name too (then it is ambiguous). */
  const define = (name: string, fn: Fn, file: string) => {
    const before = fileOf.get(name);
    if (before !== undefined && before !== file) out.ambiguous.add(name);
    fileOf.set(name, file);
    out.set(name, fn);
  };
  const memberRefs: [string, ts.Expression][] = [];
  for (const file of files) {
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && st.body)
        define(st.name.text, { node: st }, file);
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const init = skipCasts(d.initializer);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
          define(d.name.text, { node: init }, file);
        if (!ts.isObjectLiteralExpression(init)) continue;
        for (const prop of init.properties) {
          const member = memberName(prop);
          const key = `${d.name.text}.${member ?? "?"}`;
          if (!member) {
            out.unresolvedMembers.set(key, "a computed or spread member");
            continue;
          }
          if (ts.isMethodDeclaration(prop)) {
            out.unresolvedMembers.set(key, "a method (not followed)");
            continue;
          }
          const v = ts.isShorthandPropertyAssignment(prop)
            ? prop.name
            : skipCasts((prop as ts.PropertyAssignment).initializer);
          if (ts.isArrowFunction(v) || ts.isFunctionExpression(v))
            out.set(key, { node: v });
          else memberRefs.push([key, v]);
        }
      }
    }
  }
  for (const [member, v] of memberRefs) {
    if (ts.isIdentifier(v)) {
      const target = out.get(v.text);
      if (target) out.set(member, target);
      else out.unresolvedMembers.set(member, `${v.text} (not a function of these files)`);
      continue;
    }
    if (ts.isCallExpression(v) && ts.isIdentifier(v.expression)) {
      const factory = out.get(v.expression.text);
      const built = factory && returnedFunction(factory.node);
      const literals = v.arguments.map((a) =>
        ts.isStringLiteralLike(a) ? a.text : undefined
      );
      if (factory && built && literals.every((l) => l !== undefined)) {
        const bindings = new Map<string, string>();
        factory.node.parameters.forEach((p, i) => {
          if (ts.isIdentifier(p.name) && literals[i] !== undefined)
            bindings.set(p.name.text, literals[i]!);
        });
        out.set(member, { node: built, bindings });
        continue;
      }
      out.unresolvedMembers.set(member, `${v.getText()} (a factory it cannot bind)`);
      continue;
    }
    out.unresolvedMembers.set(member, `${v.getText()} (not a function)`);
  }
  return out;
}

function bindingNames(p: ts.ObjectBindingPattern): {
  names: string[];
  computed: boolean;
} {
  const names: string[] = [];
  let computed = false;
  for (const el of p.elements) {
    if (el.dotDotDotToken) continue;
    const key = el.propertyName ?? el.name;
    if (ts.isIdentifier(key) || ts.isStringLiteral(key)) names.push(key.text);
    else computed = true;
  }
  return { names, computed };
}

const isConst = (text: string) => /^[A-Z][A-Z0-9_]*$/.test(text);

/** The input keys `fnName` reads through its parameter `index`, following calls in `fns`. */
export function inputReads(fns: Map<string, Fn>, fnName: string, index = 0): InputReads {
  const result: InputReads = {
    keys: new Map(),
    whole: new Set(),
    dynamic: new Set(),
    unresolved: new Set(),
  };
  const seen = new Set<string>();
  const add = (key: string, where: string) => {
    if (!result.keys.has(key)) result.keys.set(key, new Set());
    result.keys.get(key)!.add(where);
  };

  const follow = (name: string, i: number, passed = true) => {
    const id = `${name}#${i}`;
    if (seen.has(id)) return;
    seen.add(id);
    const fn = fns.get(name);
    if (!fn) {
      result.unresolved.add(`${name} (a call it cannot follow)`);
      return;
    }
    if ((fns as Partial<Functions>).ambiguous?.has(name)) {
      result.unresolved.add(`${name} (defined in more than one file: which one runs?)`);
      return;
    }
    // The input given to a rest parameter, or past the last one, is not followed (round 13).
    const rest = fn.node.parameters.findIndex((p) => p.dotDotDotToken !== undefined);
    if (rest !== -1 && i >= rest) {
      result.unresolved.add(`${name} (the input passed to its rest parameter)`);
      return;
    }
    const param = fn.node.parameters[i];
    if (!param) {
      // A start that takes no input reads none; an input passed past them is not followed.
      if (passed) result.unresolved.add(`${name} (the input passed past its parameters)`);
      return;
    }
    if (ts.isObjectBindingPattern(param.name)) {
      const { names, computed } = bindingNames(param.name);
      for (const k of names) add(k, name);
      if (computed) result.dynamic.add(name);
      if (param.name.elements.some((el) => el.dotDotDotToken)) result.whole.add(name);
      return;
    }
    if (!ts.isIdentifier(param.name)) {
      result.unresolved.add(`${name}: its input parameter is not a name`);
      return;
    }
    const aliases = new Set([param.name.text]);
    const bindings = fn.bindings ?? new Map<string, string>();

    /** The outermost expression the input stands for here: through casts, `??` and `||`. */
    const outer = (node: ts.Identifier): ts.Node => {
      let cur: ts.Node = node;
      for (;;) {
        const p = cur.parent;
        if (
          ts.isAsExpression(p) ||
          ts.isParenthesizedExpression(p) ||
          ts.isNonNullExpression(p) ||
          ts.isTypeAssertionExpression(p) ||
          ts.isSatisfiesExpression(p) ||
          (ts.isBinaryExpression(p) &&
            p.left === cur &&
            (p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
              p.operatorToken.kind === ts.SyntaxKind.BarBarToken))
        ) {
          cur = p;
          continue;
        }
        return cur;
      }
    };

    const keyOf = (arg: ts.Expression): string | undefined => {
      if (ts.isStringLiteralLike(arg)) return arg.text;
      if (ts.isIdentifier(arg) && bindings.has(arg.text)) return bindings.get(arg.text);
      if (ts.isIdentifier(arg) && isConst(arg.text)) return `[${arg.text}]`;
      return undefined;
    };

    /** A use of the input at `e` (its outermost form), by its context. */
    const onUse = (e: ts.Node) => {
      const p = e.parent;
      // A key read.
      if (ts.isPropertyAccessExpression(p) && p.expression === e) {
        add(p.name.text, name);
        return;
      }
      if (ts.isElementAccessExpression(p) && p.expression === e) {
        const k = keyOf(p.argumentExpression);
        if (k !== undefined) add(k, name);
        else result.dynamic.add(name);
        return;
      }
      if (
        ts.isBinaryExpression(p) &&
        p.right === e &&
        p.operatorToken.kind === ts.SyntaxKind.InKeyword
      ) {
        const k = keyOf(p.left);
        if (k !== undefined) add(k, name);
        else result.dynamic.add(name);
        return;
      }
      // An alias, or keys destructured.
      if (ts.isVariableDeclaration(p) && p.initializer === e) {
        if (ts.isIdentifier(p.name)) aliases.add(p.name.text);
        else if (ts.isObjectBindingPattern(p.name)) {
          const { names, computed } = bindingNames(p.name);
          for (const k of names) add(k, name);
          if (computed) result.dynamic.add(name);
          if (p.name.elements.some((el) => el.dotDotDotToken)) result.whole.add(name);
        } else result.unresolved.add(`${name}: the input destructured as a list`);
        return;
      }
      // Every key.
      if (ts.isSpreadAssignment(p) || ts.isSpreadElement(p)) {
        result.whole.add(name);
        return;
      }
      if (ts.isForInStatement(p) && p.expression === e) {
        result.whole.add(name);
        return;
      }
      // Passed on.
      if (ts.isCallExpression(p) && p.arguments.some((a) => a === e)) {
        const ai = p.arguments.findIndex((a) => a === e);
        const callee = skipCasts(p.expression);
        const calleeText = callee.getText();
        if (WHOLE_READERS.has(calleeText)) result.whole.add(name);
        else if (calleeText === "Object.prototype.hasOwnProperty.call" && ai === 0) {
          const k = p.arguments[1] ? keyOf(p.arguments[1]) : undefined;
          if (k !== undefined) add(k, name);
          else result.dynamic.add(name);
        } else if (ts.isIdentifier(callee)) follow(callee.text, ai);
        else if (fns.has(calleeText)) follow(calleeText, ai);
        else if (
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "rule" &&
          RULE_MEMBERS.has(callee.name.text)
        ) {
          // The rules' generic runner (shared.ts applyRule): each rule's members are scanned
          // themselves, and the guard fails on any member it cannot resolve.
        } else result.unresolved.add(`${name}: ${calleeText} (a call it cannot follow)`);
        return;
      }
      // A test of the input itself reads no key.
      if (
        (ts.isPrefixUnaryExpression(p) &&
          p.operator === ts.SyntaxKind.ExclamationToken) ||
        ts.isTypeOfExpression(p) ||
        (ts.isBinaryExpression(p) &&
          [
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
            ts.SyntaxKind.EqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken,
          ].includes(p.operatorToken.kind))
      )
        return;
      // Anything else: inside a literal, assigned, returned, … — not followed.
      const what =
        ts.isObjectLiteralExpression(p) ||
        ts.isPropertyAssignment(p) ||
        ts.isShorthandPropertyAssignment(p) ||
        ts.isArrayLiteralExpression(p)
          ? "put inside a literal"
          : ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken
            ? "assigned to another name"
            : ts.isReturnStatement(p) || ts.isArrowFunction(p)
              ? "returned"
              : `used as ${ts.SyntaxKind[p.kind]}`;
      result.unresolved.add(`${name}: the input ${what}`);
    };

    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && aliases.has(n.text)) {
        const p = n.parent;
        // Declarations and member names are not uses.
        const declares =
          (ts.isParameter(p) && p.name === n) ||
          (ts.isVariableDeclaration(p) && p.name === n) ||
          (ts.isPropertyAccessExpression(p) && p.name === n) ||
          (ts.isPropertyAssignment(p) && p.name === n) ||
          (ts.isBindingElement(p) && (p.name === n || p.propertyName === n));
        if (!declares) onUse(outer(n));
      }
      ts.forEachChild(n, visit);
    };
    if (fn.node.body) visit(fn.node.body);
  };

  follow(fnName, index, false);
  return result;
}
