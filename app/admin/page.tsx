"use client";

import React, { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import AdminShell, { permittedSections } from "@/components/admin/AdminShell";
import { SectionConsole } from "@/components/admin/SectionConsole";
import { renderMessage } from "@/platform/errors/messages";
import { useAuth } from "@/platform/auth/context";
import MfaEnrollment from "@/components/admin/MfaEnrollment";
import { leaveConsole } from "@/components/admin/leave-console";
import { signInPath } from "@/platform/auth/return-path";
import { readableRole } from "@/components/admin/admin-format";
import { adminCall } from "@/components/admin/ui/admin-call";
import { Reading } from "@/components/admin/ui/PanelState";
import { BUTTON, TEXT } from "@/components/admin/ui/tokens";
import { RefusalNotice } from "@/components/refusal/RefusalNotice";
import { useRefusalSessionEnd } from "@/components/refusal/useRefusalSessionEnd";
import { handleRefusal, type Refusal } from "@/platform/errors/refusal";

/** The console's own user (GET /api/admin/session), or why it cannot open. */
type ConsoleSession =
  | { kind: "loading" }
  | {
      kind: "admin";
      roleName: string;
      permissions: readonly string[];
      /** The admin's own account id (the Users panel offers no change to it). */
      userId?: string;
      /** Who is signed in, for the header: their name, else their address (SF-admin-005). */
      name?: string;
    }
  | { kind: "mfa_required" }
  | { kind: "refused" }
  /** Refused for a reason other than access (TASK-181): restricted, unavailable, … */
  | { kind: "refusal"; refusal: Refusal };

/**
 * What the console does with a refused GET /api/admin/session (TASK-181 — it showed one "refused"
 * text for every refusal): no administrative access (`auth.permission_denied`, or not signed in)
 * is the access page; staff without a second factor enrol; an erased account's session ends;
 * anything else — a restricted account, a service that is down — is shown as itself.
 */
function sessionRefused(refusal: Refusal): ConsoleSession {
  if (refusal.code === "auth.mfa_required") return { kind: "mfa_required" };
  if (refusal.code === "auth.permission_denied" || refusal.kind === "sign-in") {
    return { kind: "refused" };
  }
  // An erased account's session is ended by the call helper (announceSessionEnd).
  return { kind: "refusal", refusal };
}

/** What a permission list allows: "*" (the development bypass admin) allows everything. */
function permissionCheck(granted: readonly string[]): (code: string) => boolean {
  return (code) => granted.includes("*") || granted.includes(code);
}

export default function AdminPage() {
  const router = useRouter();
  const [session, setSession] = useState<ConsoleSession>({ kind: "loading" });
  const [sessionAttempt, setSessionAttempt] = useState(0);
  // "Show details" (admins and super-admins only): in memory for this console session.
  const [showDetails, setShowDetails] = useState(false);
  const { signOut, session: pageSession } = useAuth();
  useRefusalSessionEnd();
  // The sign-in session ended while the console was open (ADR-057 D5: a staff session idle for
  // thirty minutes, or ended from another device): the console is not left standing with panels
  // that can no longer read — it becomes the access page, with the way to sign in.
  const sessionEnded = pageSession?.status === "signed-out";

  // Which sections to show: the admin's own permissions (audit B-14 — every section was shown
  // to every admin). Display only: each section's route checks its own permission. Through the
  // one call helper: a refusal by its code, and no answer at all, are both said.
  useEffect(() => {
    let current = true;
    void adminCall("/api/admin/session").then((answer) => {
      if (!current) return;
      if (!answer.ok) {
        setSession(sessionRefused(answer.refusal));
        return;
      }
      const body = answer.body;
      if (!Array.isArray(body.permissions)) {
        setSession(sessionRefused(handleRefusal(undefined, { status: answer.status })));
        return;
      }
      const text = (value: unknown) =>
        typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
      const name = text(body.displayName) ?? text(body.email);
      setSession({
        kind: "admin",
        roleName: typeof body.roleName === "string" ? body.roleName : "",
        ...(typeof body.userId === "string" ? { userId: body.userId } : {}),
        ...(name ? { name } : {}),
        permissions: body.permissions.filter((p): p is string => typeof p === "string"),
      });
    });
    return () => {
      current = false;
    };
  }, [sessionAttempt]);

  // The sections this admin may open, in the registry's order; none until the session has
  // answered "admin". The shell opens the first (or the one the address names) and the section's
  // console reads only that one.
  const permitted = useMemo(
    () =>
      session.kind === "admin"
        ? permittedSections(permissionCheck(session.permissions))
        : [],
    [session]
  );
  const allowed = useMemo(
    () => (session.kind === "admin" ? permissionCheck(session.permissions) : () => false),
    [session]
  );

  // Nobody, or someone without administrative access: no console shell at all (audit B-14).
  if (session.kind === "refused" || sessionEnded) {
    return (
      <main className="mx-auto max-w-md p-8 text-center">
        <p className={`mb-4 text-sm ${TEXT.quiet}`}>
          {renderMessage("screens.admin_console.refused")}
        </p>
        <button
          type="button"
          className={BUTTON.primary}
          // Back to this console, the section the address names, once signed in (E-113).
          onClick={() =>
            router.push(signInPath(window.location.pathname + window.location.search))
          }
        >
          {renderMessage("screens.admin_console.sign_in")}
        </button>
      </main>
    );
  }

  if (session.kind === "refusal") {
    return (
      <main className="mx-auto max-w-md p-8 text-center">
        <RefusalNotice
          refusal={session.refusal}
          onRetry={() => setSessionAttempt((n) => n + 1)}
          onSignOut={() => {
            void signOut().then((ended) => {
              if (ended) router.push("/auth");
            });
          }}
        />
      </main>
    );
  }

  if (session.kind === "mfa_required") {
    return (
      <MfaEnrollment
        onSignOut={() => {
          void signOut().then((ended) => {
            if (ended) router.push("/auth");
          });
        }}
      />
    );
  }

  // Nothing is shown, and nothing read, until the session has answered.
  if (session.kind === "loading") {
    return (
      <main className="mx-auto max-w-md p-8 text-center">
        <Reading text={renderMessage("screens.admin_console.loading")} />
      </main>
    );
  }

  // Administrative access, but no section this role may open: say so, never a refused read. A
  // safety net, not a state the platform's server produces: /api/admin/session requires
  // can_access_admin, which always opens Approvals and Tenant. It holds if a section's permission
  // or the session route changes.
  if (permitted.length === 0) {
    return (
      <main className="mx-auto max-w-md p-8 text-center">
        <RefusalNotice
          refusal={handleRefusal("auth.permission_denied", {
            message: renderMessage("screens.admin_console.no_sections"),
          })}
        />
        <button
          type="button"
          className={`mt-4 ${BUTTON.primary}`}
          onClick={() => {
            void signOut().then((ended) => {
              if (ended) router.push("/auth");
            });
          }}
        >
          {renderMessage("screens.refusal.sign_out")}
        </button>
      </main>
    );
  }

  const role = session.roleName
    ? // The role as the Users screen reads one ("super_admin" → "Super admin").
      readableRole(session.roleName, null)
    : renderMessage("screens.admin_console.admin_fallback");
  const admin = {
    roleName: session.roleName,
    ...(session.userId ? { userId: session.userId } : {}),
  };
  return (
    <AdminShell
      // Who is signed in, then their role (SF-admin-005: it named only the role).
      adminName={session.name ?? role}
      adminRole={session.name ? role : undefined}
      hasPermission={allowed}
      onSignOut={() => {
        // The session ends — the server revokes it and this browser forgets its tokens — then a
        // full load to sign-in (TASK-184: it only left for "/", still signed in).
        // Only once the server has ended it (TASK-219): a refused sign-out leaves the console
        // signed in, and the provider says so.
        void signOut()
          .catch(() => false)
          .then((ended) => {
            if (ended) leaveConsole("/auth");
          });
      }}
    >
      {(section) => (
        // Each section has its own console: its plan, its outcomes and its read are its own.
        <SectionConsole
          key={section}
          section={section}
          admin={admin}
          hasPermission={allowed}
          showDetails={showDetails}
          onShowDetails={setShowDetails}
        />
      )}
    </AdminShell>
  );
}
