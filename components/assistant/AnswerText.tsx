"use client";

/**
 * components/assistant/AnswerText.tsx — the assistant's answer, its formatting shown as
 * formatting (TASK-224, SF-app-030)
 *
 * The model writes Markdown — lists, **bold**, `code`, headings — and the page showed it as
 * typed: asterisks, hashes and backticks in the answer. This renders the small part of Markdown
 * an answer uses, as React elements built from the text: nothing the model writes is ever read as
 * HTML (no `dangerouslySetInnerHTML`, no HTML parser), so an answer cannot put markup, a script or
 * an image on the page. A link is shown as its words and its address in plain text, not as a link:
 * an answer is not a trusted source of addresses to follow (OWASP LLM Top 10 2025, LLM05 —
 * improper output handling). It works on a partial answer too, as the answer streams in: an
 * unfinished mark is shown as typed until its end arrives.
 *
 * Block forms: paragraphs (separated by a blank line), "-", "*" or "+" bullet lists, "1." numbered
 * lists, "#" headings (shown as a strong line — the page's own headings stay the page's), and
 * fenced code blocks. Inline forms: **bold**, *italic* or _italic_, `code`, [words](address).
 *
 * @module components/assistant
 */

import React from "react";

export type Inline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "strong" | "em" | "code"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string };

export type Block =
  | { readonly kind: "paragraph"; readonly lines: readonly string[] }
  | { readonly kind: "heading"; readonly text: string }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly items: readonly string[];
    }
  | { readonly kind: "code"; readonly text: string };

const FENCE = /^ {0,3}```/;

/** A line's list marker: "- ", "* ", "+ " (a bullet) or "1. ", "1) " (numbered). */
function listItem(line: string): { ordered: boolean; text: string } | null {
  const body = line.replace(/^ {0,3}/, "");
  const m = /^(?:([-*+])|\d{1,3}[.)]) /.exec(body);
  if (!m) return null;
  return { ordered: m[1] === undefined, text: body.slice(m[0].length).trim() };
}

/** A line's heading text ("# Title" → "Title"), or null. */
function headingText(line: string): string | null {
  const body = line.replace(/^ {0,3}/, "");
  const m = /^#{1,6} /.exec(body);
  if (!m) return null;
  return body.slice(m[0].length).replace(/#+$/, "").trim();
}

/** The answer's blocks, in order. */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (FENCE.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!);
      i += 1; // the closing fence (or the end, while the answer is still streaming)
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = headingText(line);
    if (heading !== null) {
      blocks.push({ kind: "heading", text: heading });
      i += 1;
      continue;
    }
    const first = listItem(line);
    if (first) {
      const items: string[] = [];
      for (let item = listItem(lines[i]!); item && item.ordered === first.ordered;) {
        items.push(item.text);
        i += 1;
        item = i < lines.length ? listItem(lines[i]!) : null;
      }
      blocks.push({ kind: "list", ordered: first.ordered, items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !FENCE.test(lines[i]!) &&
      headingText(lines[i]!) === null &&
      listItem(lines[i]!) === null
    ) {
      para.push(lines[i]!);
      i += 1;
    }
    blocks.push({ kind: "paragraph", lines: para });
  }
  return blocks;
}

/** One span of inline marks: the first of code, link, bold, italic that starts earliest. */
const INLINE =
  /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\s][^*\n]*)\*|(?<![a-z0-9])_([^_\s][^_\n]*)_(?![a-z0-9])/i;

/** A line's inline pieces, in order; text with no mark is one text piece. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest.length > 0) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push({ kind: "text", text: rest });
      break;
    }
    if (m.index > 0) out.push({ kind: "text", text: rest.slice(0, m.index) });
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "link", text: m[2], href: m[3]! });
    else if (m[4] !== undefined || m[5] !== undefined)
      out.push({ kind: "strong", text: (m[4] ?? m[5])! });
    else out.push({ kind: "em", text: (m[6] ?? m[7])! });
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

function InlineText({ text }: { readonly text: string }) {
  return (
    <>
      {parseInline(text).map((piece, i) => {
        switch (piece.kind) {
          case "strong":
            return (
              <strong key={i} className="font-semibold text-white">
                {piece.text}
              </strong>
            );
          case "em":
            return <em key={i}>{piece.text}</em>;
          case "code":
            return (
              <code
                key={i}
                className="rounded bg-black/40 px-1 py-0.5 font-mono text-[0.85em]"
              >
                {piece.text}
              </code>
            );
          case "link":
            // Its words, then its address as plain text: never a link to follow.
            return (
              <span key={i} data-answer-link="true">
                {piece.text}{" "}
                <span className="break-all text-gray-400">({piece.href})</span>
              </span>
            );
          default:
            return <React.Fragment key={i}>{piece.text}</React.Fragment>;
        }
      })}
    </>
  );
}

export function AnswerText({ text }: { readonly text: string }) {
  return (
    <div className="space-y-3 break-words text-sm leading-relaxed text-gray-100">
      {parseBlocks(text).map((block, i) => {
        switch (block.kind) {
          case "heading":
            return (
              <p key={i} className="font-semibold text-white">
                <InlineText text={block.text} />
              </p>
            );
          case "code":
            return (
              <pre
                key={i}
                className="overflow-x-auto rounded-lg bg-black/40 p-3 font-mono text-xs text-gray-100"
              >
                <code>{block.text}</code>
              </pre>
            );
          case "list": {
            const items = block.items.map((item, j) => (
              <li key={j}>
                <InlineText text={item} />
              </li>
            ));
            return block.ordered ? (
              <ol key={i} className="list-decimal space-y-1 pl-6">
                {items}
              </ol>
            ) : (
              <ul key={i} className="list-disc space-y-1 pl-6">
                {items}
              </ul>
            );
          }
          default:
            return (
              <p key={i}>
                {block.lines.map((line, j) => (
                  <React.Fragment key={j}>
                    {j > 0 ? <br /> : null}
                    <InlineText text={line} />
                  </React.Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
