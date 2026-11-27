import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../web/src/markdown.js";

/** The Markdown the human reads (the spec, the Griller's questions): rendered, and never able to inject HTML. */

describe("renderMarkdown", () => {
  it("renders headings (below the page's own), paragraphs, emphasis and inline code", () => {
    const html = renderMarkdown("# Spec\n\n## Problem Statement\n\nA **bold** and _italic_ and *starred* word, with `code <b>`.\nSecond line.");

    expect(html).toContain("<h3>Spec</h3>");
    expect(html).toContain("<h4>Problem Statement</h4>");
    expect(html).toContain("<p>A <strong>bold</strong> and <em>italic</em> and <em>starred</em> word, with <code>code &lt;b&gt;</code>.<br>Second line.</p>");
  });

  it("renders ordered and nested bullet lists", () => {
    const html = renderMarkdown("1. First?\n   - sub a\n   - sub b\n2. Second?\n\n- loose\n- list");

    expect(html).toContain("<ol><li>First?\n<ul><li>sub a</li><li>sub b</li></ul></li><li>Second?</li></ol>");
    expect(html).toContain("<ul><li>loose</li><li>list</li></ul>");
  });

  it("renders fenced code verbatim, quotes, rules and tables", () => {
    const html = renderMarkdown("```ts\nconst a = 1 < 2 && **x**;\n```\n\n> quoted *text*\n\n---\n\n| A | B |\n|---|---|\n| 1 | **2** |");

    expect(html).toContain("<pre><code>const a = 1 &lt; 2 &amp;&amp; **x**;</code></pre>");
    expect(html).toContain("<blockquote><p>quoted <em>text</em></p></blockquote>");
    expect(html).toContain("<hr>");
    expect(html).toContain("<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td><strong>2</strong></td></tr></tbody></table>");
  });

  it("escapes any HTML the text contains", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n# <b>head</b>');

    expect(html).not.toMatch(/<script|<img|<b>/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("keeps links to http, https and mailto only, and cannot break out of the attribute", () => {
    const html = renderMarkdown(
      '[ok](https://example.com/a?b=1&c=2) [mail](mailto:a@b.c) [js](javascript:alert(1)) [data](data:text/html,x) [q](https://x.y/"onmouseover="alert(1))',
    );

    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">ok</a>');
    expect(html).toContain('<a href="mailto:a@b.c"');
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain('href="data');
    expect(html).toContain("[js](javascript:alert(1))");
    // The quote is escaped: the text stays inside the one href, which is the only attribute the link has besides target and rel.
    expect(html).toContain('href="https://x.y/&quot;onmouseover=&quot;alert(1"');
  });

  it("does not let the text forge a code span", () => {
    const html = renderMarkdown("`real` and \u00000\u0000 and `<i>`");

    expect(html).toBe("<p><code>real</code> and 0 and <code>&lt;i&gt;</code></p>");
  });

  it("renders an empty text as nothing, and plain text as one paragraph", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("Just words.")).toBe("<p>Just words.</p>");
  });
});
