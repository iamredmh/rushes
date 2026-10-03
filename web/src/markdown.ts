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
  // balanced inner group before requiring the link's own closing paren.
  out = out.replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codeSpans[Number(i)]);
  return out;
}

/**
 * Renders a small, safe Markdown subset to an HTML string: `#`-`###` headings, paragraphs,
 * `-`/`*` and `1.` lists, `**bold**`, `*italic*`, `` `code` `` and fenced code blocks. Escapes
 * all HTML first (see escapeHtml), so `<script>`, an `onerror` attribute or any other raw markup
 * in the source text always comes out as inert, visible text -- never a real element. Links
 * render as their text only; bare URLs are left as plain text, never auto-linked.
 */
export function safeMarkdownHtml(text: string): string {
  const escaped = escapeHtml(text);
  const lines = escaped.split(/\r\n|\r|\n/);
  const html: string[] = [];
  let para: string[] = [];
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
      html.push(`<${tag}>${list.items.map((item) => `<li>${inlineFormat(item)}</li>`).join("")}</${tag}>`);
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

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineFormat(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    const ordered = /^\d+\.\s+(.*)$/.exec(line);
    const unordered = ordered ? null : /^[-*]\s+(.*)$/.exec(line);
    if (ordered || unordered) {
      flushPara();
      const isOrdered = !!ordered;
      const content = (ordered ?? unordered)![1];
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push(content);
      i++;
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

/** Alias kept for readers who think of this as "rendering Markdown" rather than the safety it
 *  guarantees -- both names do exactly the same thing. */
export const renderMarkdown = safeMarkdownHtml;
