// §16.1's built-in Markdown renderer, for the preview panel on Scripts & docs, Captions, Exports
// and Edit files. Pure (no DOM), so it's unit-tested in Node like the rest of lib.ts.
//
// The contract (ruling 2 of the plan): escape every character that could open an HTML tag or
// attribute FIRST, then apply a small formatting subset on top of the escaped text. Nothing here
// ever re-introduces raw HTML from the file's own content, and a link's URL is always discarded
// -- only its text survives, never as a clickable anchor. That's what makes the result safe to
// hand straight to dangerouslySetInnerHTML.

/** Escapes the five characters that matter for HTML text and (double- and single-quoted)
 *  attribute contexts. `&` first, so the entities this function itself writes don't get
 *  re-escaped by the following replacements. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Inline formatting within one block of already-escaped text: code spans, bold, italic, and
 * links rendered as their text alone. Code spans are pulled out before bold/italic run, so a
 * literal `**` or `*` inside `` `code` `` is never touched by either.
 */
function inlineFormat(text: string): string {
  const codeSpans: string[] = [];
  let out = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  // [text](url) -> text. The url is discarded outright: never rendered, never an href. The url
  // group tolerates one level of nested parens (e.g. "javascript:alert(1)") by matching a
  // balanced inner group before requiring the link's own closing paren. The text group excludes
  // `[` as well as `]` (I4): `[^\]]*` alone can span across an unmatched `[`, so a run of many
  // `[` characters makes the engine rescan the same text from every one of them -- quadratic on
  // an adversarial input. Excluding `[` too means a text group simply can't cross one, so each
  // failed attempt is O(1) rather than restarting a scan.
  out = out.replace(/\[([^\][]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codeSpans[Number(i)]);
  return out;
}

interface ListItemMatch {
  indent: number;
  ordered: boolean;
  content: string;
}

/** `  - text` / `1. text`, at any indent -- the caller decides whether the indent makes it a
 *  top-level or (one level of) nested item. */
function matchListItem(line: string): ListItemMatch | null {
  // [ \t]+, not \s+ (I4): \s includes U+2028/U+2029, which `.` never matches (they're line
  // terminators, dotAll or not) -- a run of them after the marker would make `\s+` and `(.*)$`
  // fight over the same characters, backtracking one at a time across the whole run.
  const m = /^( *)([-*]|\d+\.)[ \t]+(.*)$/.exec(line);
  if (!m) return null;
  return { indent: m[1].length, ordered: /\d/.test(m[2]), content: m[3] };
}

/** `> text`, or just `>` on its own, matched against ALREADY-ESCAPED text -- escapeHtml turns
 *  every literal `>` into `&gt;` before this ever runs, `>` being one of the five characters it
 *  escapes, so the marker to look for here is the escaped form, not a literal `>`. Only an
 *  actual `>` in the source produces that exact sequence (a literal "&gt;" typed in the source
 *  would itself have had its `&` escaped to `&amp;` first), so this never misfires. Returns the
 *  quoted text, or null for a non-quote line. */
function matchBlockquote(line: string): string | null {
  const m = /^&gt;\s?(.*)$/.exec(line);
  return m ? m[1] : null;
}

/**
 * Renders a small, safe Markdown subset to an HTML string: `#`-`###` headings, paragraphs,
 * `-`/`*` and `1.` lists (with one level of nesting, indented two or more spaces under a list
 * item), `> ` blockquotes, `**bold**`, `*italic*`, `` `code` `` and fenced code blocks. Escapes
 * all HTML first (see escapeHtml), so `<script>`, an `onerror` attribute or any other raw markup
 * in the source text always comes out as inert, visible text -- never a real element, including
 * inside a blockquote or a nested list item. Links render as their text only; bare URLs are left
 * as plain text, never auto-linked.
 */
export function safeMarkdownHtml(text: string): string {
  const escaped = escapeHtml(text);
  // U+2028 (line separator) and U+2029 (paragraph separator) split lines too (I4): both are
  // valid line breaks in a text file, and leaving either inside a line is what made [ \t]+
  // necessary above in the first place.
  const lines = escaped.split(/\r\n|\r|\n|\u2028|\u2029/);
  const html: string[] = [];
  let para: string[] = [];
  // Each item already holds its fully-rendered inner HTML (inline-formatted text, plus any
  // nested <ul>/<ol> appended) -- unlike `para`, which collects raw lines for flushPara to join
  // and format once.
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${inlineFormat(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      html.push(`<${tag}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`);
      list = null;
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      flushPara();
      flushList();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // the closing fence, if there was one
      html.push(`<pre><code>${code.join("\n")}</code></pre>`);
      continue;
    }

    // Same [ \t]+ reasoning as matchListItem (I4).
    const heading = /^(#{1,3})[ \t]+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineFormat(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    const quoted = matchBlockquote(line);
    if (quoted !== null) {
      flushPara();
      flushList();
      const quotedLines = [quoted];
      i++;
      let next: string | null;
      while (i < lines.length && (next = matchBlockquote(lines[i])) !== null) {
        quotedLines.push(next);
        i++;
      }
      html.push(`<blockquote><p>${inlineFormat(quotedLines.join(" "))}</p></blockquote>`);
      continue;
    }

    const item = matchListItem(line);
    if (item && item.indent < 2) {
      flushPara();
      if (!list || list.ordered !== item.ordered) {
        flushList();
        list = { ordered: item.ordered, items: [] };
      }
      let inner = inlineFormat(item.content);
      i++;
      // One level of nesting: lines directly under this item, indented two or more spaces,
      // that are themselves list items. A homogeneous nested run becomes one nested list,
      // using whichever marker (-/* or N.) its own first line used.
      const nested: ListItemMatch[] = [];
      let nextItem: ListItemMatch | null;
      while (i < lines.length && (nextItem = matchListItem(lines[i])) && nextItem.indent >= 2) {
        nested.push(nextItem);
        i++;
      }
      if (nested.length) {
        const nestedTag = nested[0].ordered ? "ol" : "ul";
        inner += `<${nestedTag}>${nested.map((n) => `<li>${inlineFormat(n.content)}</li>`).join("")}</${nestedTag}>`;
      }
      list.items.push(inner);
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      flushList();
      i++;
      continue;
    }

    flushList();
    para.push(line);
    i++;
  }
  flushPara();
  flushList();
  return html.join("\n");
}
