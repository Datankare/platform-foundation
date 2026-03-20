# ADR-002 — Next.js + React Stack

**Status:** Accepted
**Date:** 2026-03-18

## Context

The platform must run on iOS, Android, and all major browsers with maximum
code sharing between platforms. We need server-side rendering for performance,
a component model for UI consistency, and TypeScript for type safety.

## Decision

- **Web:** Next.js (App Router) with TypeScript and Tailwind CSS
- **Mobile:** React Native (future phase) — shares business logic with web
- **Monorepo:** Single repository with shared types, utils, and components
- **Language:** TypeScript strict mode throughout — no `any`, no shortcuts

## Consequences

- Maximum code sharing between web and mobile
- Next.js App Router enables server components and API routes in one framework
- TypeScript strict mode catches errors at compile time not runtime
- Tailwind CSS enables rapid UI development with consistent design tokens
- Requires discipline to keep platform and game layers separated in monorepo
- Next.js upgrade cycle must be monitored for security vulnerabilities (see DS-001)
