import { describe, expect, it } from "vitest";
import { safeMarkdownHtml } from "../../web/src/markdown.js";

describe("safeMarkdownHtml", () => {
  it("escapes a script tag to inert text", () => {
    const html = safeMarkdownHtml("<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes an img onerror attribute to inert text", () => {
    const html = safeMarkdownHtml("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("renders a link as its text only, with no anchor and no javascript: url", () => {
    const html = safeMarkdownHtml("[x](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("javascript:");
    expect(html).toContain(">x<");
  });

  it("leaves a bare URL as plain text, never auto-linked", () => {
    const html = safeMarkdownHtml("See https://example.com for more.");
    expect(html).not.toContain("<a ");
    expect(html).toContain("https://example.com");
  });

  it("renders headings # through ###", () => {
    const html = safeMarkdownHtml("# One\n## Two\n### Three");
    expect(html).toContain("<h1>One</h1>");
    expect(html).toContain("<h2>Two</h2>");
    expect(html).toContain("<h3>Three</h3>");
  });

  it("groups consecutive lines into one paragraph, and blank lines split paragraphs", () => {
    const html = safeMarkdownHtml("Line one\nLine two\n\nLine three");
    expect(html).toBe("<p>Line one Line two</p>\n<p>Line three</p>");
  });

  it("renders - and * bullet lists", () => {
    expect(safeMarkdownHtml("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(safeMarkdownHtml("* a\n* b")).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("renders 1. ordered lists", () => {
    expect(safeMarkdownHtml("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("renders bold, italic and inline code", () => {
    const html = safeMarkdownHtml("**bold** and *italic* and `code`");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
  });

  it("protects a code span's own asterisks from bold/italic formatting", () => {
    const html = safeMarkdownHtml("`a**b*c`");
    expect(html).toContain("<code>a**b*c</code>");
  });

  it("renders a fenced code block verbatim (still escaped), without running inline formatting inside it", () => {
    const html = safeMarkdownHtml("```\n*not italic*\n<b>not bold</b>\n```");
    expect(html).toBe("<pre><code>*not italic*\n&lt;b&gt;not bold&lt;/b&gt;</code></pre>");
  });
});
