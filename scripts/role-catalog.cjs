#!/usr/bin/env node
/**
 * scripts/role-catalog.cjs — The roles and permissions the migrations create
 *
 * Reads supabase/baseline/000_baseline.sql and every migration the baseline does not record —
 * the same set, in the same order, as scripts/migration-replay.sh — and returns the permission
 * catalog, each role's direct permissions (`roles`), the roles it inherits from (`inherits`), and
 * its effective permissions (`effective`: direct plus one level of inheritance, as
 * platform/auth/permissions.ts resolves them). Entitlements are per user and not included.
 *
 * Used by:
 *   - __tests__/helpers/test-identities.ts: test callers hold exactly the permissions their real
 *     role holds, so an authorization test cannot pass on a made-up permission set.
 *   - __tests__/admin-authorization-matrix.test.ts: every permission the code requires exists.
 *   - scripts/migration-replay.sh: the catalog computed here must equal the replayed database,
 *     so this parser is itself checked against real Postgres on every CI run.
 *
 * Fails closed: a migration that changes roles or permissions in a form this parser does not
 * understand is an error, not a silent gap.
 *
 * CLI: node scripts/role-catalog.cjs --pairs        → "role|permission" lines, sorted
 *      node scripts/role-catalog.cjs --inheritance  → "role|inherited role" lines, sorted
 *      node scripts/role-catalog.cjs --json    → { permissions, roles }
 */

"use strict";

const fs = require("fs");
const path = require("path");

const IDENT = "(?:public\\.)?";

function stripComments(sql) {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

function quoted(text) {
  return [...text.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
}

/** Split "VALUES (...), (...)" into the text of each tuple, respecting quotes. */
function tuples(valuesText) {
  const out = [];
  let depth = 0;
  let inQuote = false;
  let start = -1;
  for (let i = 0; i < valuesText.length; i += 1) {
    const ch = valuesText[i];
    if (ch === "'") {
      if (inQuote && valuesText[i + 1] === "'") {
        i += 1;
        continue;
      }
      inQuote = !inQuote;
    } else if (!inQuote && ch === "(") {
      if (depth === 0) start = i + 1;
      depth += 1;
    } else if (!inQuote && ch === ")") {
      depth -= 1;
      if (depth === 0) out.push(valuesText.slice(start, i));
    }
  }
  return out;
}

/** Statements, split on semicolons outside quotes and dollar-quoted bodies. */
function statements(sql) {
  const out = [];
  let buf = "";
  let inQuote = false;
  let dollar = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (!inQuote && !dollar && ch === "$") {
      const m = sql.slice(i).match(/^\$[a-z_]*\$/i);
      if (m) {
        dollar = m[0];
        buf += dollar;
        i += dollar.length - 1;
        continue;
      }
    } else if (dollar && sql.startsWith(dollar, i)) {
      buf += dollar;
      i += dollar.length - 1;
      dollar = null;
      continue;
    }
    if (!dollar && ch === "'") inQuote = !inQuote;
    if (!inQuote && !dollar && ch === ";") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

const TOUCHES = new RegExp(
  `\\b(insert\\s+into|update|delete\\s+from|truncate)\\s+${IDENT}(roles|permissions|role_permissions|role_inheritance)\\b`,
  "i"
);

/** An UPDATE that changes only descriptive columns (never a name, code or id) is allowed. */
function isDescriptiveUpdate(stmt) {
  const set = stmt.match(/\bset\b([\s\S]*?)(\bwhere\b|$)/i);
  if (!set) return false;
  const cols = [...set[1].matchAll(/(?:^|,)\s*([a-z_]+)\s*=/gi)].map((m) =>
    m[1].toLowerCase()
  );
  return cols.length > 0 && cols.every((c) => !["id", "name", "code"].includes(c));
}

function applyStatement(catalog, stmt, file) {
  const touched = stmt.match(TOUCHES);
  if (!touched) return;
  const verb = touched[1].toLowerCase();
  const table = touched[2].toLowerCase();
  if (
    verb === "update" &&
    (table === "roles" || table === "permissions") &&
    isDescriptiveUpdate(stmt)
  ) {
    return;
  }
  if (touched.index !== 0) {
    throw new Error(`${file}: unsupported change to ${table}: ${stmt.slice(0, 120)}`);
  }
  const insert = new RegExp(
    `^insert\\s+into\\s+${IDENT}${table}\\s*\\(([^)]*)\\)\\s*`,
    "i"
  );
  const head = stmt.match(insert);
  if (!head)
    throw new Error(`${file}: unsupported change to ${table}: ${stmt.slice(0, 120)}`);
  const columns = head[1].split(",").map((c) => c.trim().toLowerCase());
  const rest = stmt.slice(head[0].length);

  if (table === "permissions" || table === "roles") {
    const key = table === "permissions" ? "code" : "name";
    const idCol = columns.indexOf("id");
    const keyCol = columns.indexOf(key);
    if (keyCol === -1 || !/^values\b/i.test(rest)) {
      throw new Error(`${file}: unsupported insert into ${table}`);
    }
    for (const tuple of tuples(rest.replace(/\bon\s+conflict\b[\s\S]*$/i, ""))) {
      const values = quoted(tuple);
      const value = values[keyCol];
      if (table === "permissions") {
        catalog.permissions.add(value);
        if (idCol !== -1) catalog.permissionIds.set(values[idCol], value);
      } else {
        if (!catalog.roles.has(value)) catalog.roles.set(value, new Set());
        if (idCol !== -1) catalog.roleIds.set(values[idCol], value);
      }
    }
    return;
  }

  if (table === "role_inheritance") {
    if (/^values\b/i.test(rest)) {
      const roleCol = columns.indexOf("role_id");
      const fromCol = columns.indexOf("inherits_from_id");
      for (const tuple of tuples(rest)) {
        const values = quoted(tuple);
        const role = catalog.roleIds.get(values[roleCol]);
        const from = catalog.roleIds.get(values[fromCol]);
        if (!role || !from)
          throw new Error(`${file}: role_inheritance row with unknown ids`);
        if (!catalog.inherits.has(role)) catalog.inherits.set(role, new Set());
        catalog.inherits.get(role).add(from);
      }
      return;
    }
    const m = rest.match(
      /^select\s+r\.id\s*,\s*(\w+)\.id\s+from\s+(?:public\.)?roles\s+r\s*,\s*(?:public\.)?roles\s+\1\s+where\s+r\.name\s+(?:in\s*\(([^)]*)\)|=\s*'([^']+)')\s+and\s+\1\.name\s*=\s*'([^']+)'(?:\s+and\s+not\s+exists\s*\([\s\S]*\))?\s*$/i
    );
    if (!m)
      throw new Error(
        `${file}: unsupported role_inheritance form: ${stmt.slice(0, 160)}`
      );
    const heirs = m[2] !== undefined ? quoted(m[2]) : [m[3]];
    const from = m[4];
    // As in SQL, a name that matches no role inserts nothing.
    if (!catalog.roles.has(from)) return;
    for (const heir of heirs) {
      if (!catalog.roles.has(heir)) continue;
      if (!catalog.inherits.has(heir)) catalog.inherits.set(heir, new Set());
      catalog.inherits.get(heir).add(from);
    }
    return;
  }

  // role_permissions: the baseline's (id, role_id, permission_id, ...) VALUES rows, or a
  // migration's SELECT r.id, p.id ... WHERE r.name = 'x' AND p.code IN ('a', ...).
  if (/^values\b/i.test(rest)) {
    const roleCol = columns.indexOf("role_id");
    const permCol = columns.indexOf("permission_id");
    for (const tuple of tuples(rest)) {
      const values = quoted(tuple);
      const role = catalog.roleIds.get(values[roleCol]);
      const perm = catalog.permissionIds.get(values[permCol]);
      if (!role || !perm)
        throw new Error(`${file}: role_permissions row with unknown ids`);
      catalog.roles.get(role).add(perm);
    }
    return;
  }
  const grant = rest.match(
    /^select\s+r\.id\s*,\s*p\.id\s+from\s+(?:public\.)?roles\s+r\s*,\s*(?:public\.)?permissions\s+p\s+where\s+r\.name\s*=\s*'([^']+)'\s+and\s+p\.code\s+in\s*\(([^)]*)\)\s*(?:on\s+conflict[\s\S]*)?$/i
  );
  if (!grant) throw new Error(`${file}: unsupported grant form: ${stmt.slice(0, 160)}`);
  const role = grant[1];
  // As in SQL, a role or code that matches nothing grants nothing.
  if (!catalog.roles.has(role)) return;
  for (const code of quoted(grant[2])) {
    if (catalog.permissions.has(code)) catalog.roles.get(role).add(code);
  }
}

function loadRoleCatalog(root = path.resolve(__dirname, "..")) {
  const catalog = {
    permissions: new Set(),
    roles: new Map(),
    permissionIds: new Map(),
    roleIds: new Map(),
    inherits: new Map(),
  };
  const baselinePath = path.join(root, "supabase/baseline/000_baseline.sql");
  const baseline = fs.readFileSync(baselinePath, "utf8");
  for (const stmt of statements(stripComments(baseline))) {
    applyStatement(catalog, stmt, "000_baseline.sql");
  }
  const dir = path.join(root, "supabase/migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  for (const f of files) {
    if (baseline.includes(`('${f}', 'verified'`)) continue;
    const sql = stripComments(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const stmt of statements(sql)) applyStatement(catalog, stmt, f);
  }
  const roles = {};
  const effective = {};
  const inherits = {};
  for (const [name, perms] of [...catalog.roles].sort(([a], [b]) => a.localeCompare(b))) {
    roles[name] = [...perms].sort();
    // One level, as platform/auth/permissions.ts resolvePermissions applies it.
    const from = [...(catalog.inherits.get(name) ?? [])].sort();
    inherits[name] = from;
    effective[name] = [
      ...new Set([...perms, ...from.flatMap((r) => [...catalog.roles.get(r)])]),
    ].sort();
  }
  return { permissions: [...catalog.permissions].sort(), roles, inherits, effective };
}

module.exports = { loadRoleCatalog };

if (require.main === module) {
  const catalog = loadRoleCatalog();
  if (process.argv.includes("--pairs") || process.argv.includes("--inheritance")) {
    const source = process.argv.includes("--pairs") ? catalog.roles : catalog.inherits;
    const lines = [];
    for (const [role, items] of Object.entries(source)) {
      for (const item of items) lines.push(`${role}|${item}`);
    }
    process.stdout.write(lines.sort().join("\n") + "\n");
  } else {
    process.stdout.write(JSON.stringify(catalog, null, 2) + "\n");
  }
}
