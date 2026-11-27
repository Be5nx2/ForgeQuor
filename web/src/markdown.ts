/**
 * A small Markdown renderer for what Agents write the human to read (the Griller's questions and summary, the spec): headings,
 * paragraphs, bold, italic, inline code, fenced code, links, quotes, lists (nested), tables and rules.
 *
 * Safe by construction: all text is HTML-escaped first and the tags come only from this file, so no HTML the Agent wrote
 * (a script, an image with a handler) is ever passed through, and a link is kept only when it goes to http(s) or mailto.
 * A pure function, so it is tested without a browser.
 */

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/** A character that cannot occur in the text (it is stripped from the input), used to park the code spans while the rest is formatted. */
const PARK = "\u0000";

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Inline formatting of one run of text. */
function inline(text: string): string {
  const spans: string[] = [];
  // Code spans first: what is inside them is never formatted.
  let out = text.replace(/(`+)(.+?)\1/g, (_m, _ticks, code: string) => {
    spans.push(`<code>${escapeHtml(code.trim())}</code>`);
    return `${PARK}${spans.length - 1}${PARK}`;
  });
  out = escapeHtml(out);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => {
    // The URL was escaped with the rest: `&amp;` is what it needs inside an attribute.
    return SAFE_URL.test(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>` : m;
  });
  out = out
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<![\w*])__(?=\S)(.+?)(?<=\S)__(?![\w*])/g, "<strong>$1</strong>")
    .replace(/(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, "<em>$1</em>")
    .replace(/(?<![\w])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\w])/g, "<em>$1</em>");
  return out.replace(new RegExp(`${PARK}(\\d+)${PARK}`, "g"), (_m, i: string) => spans[Number(i)]!);
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** Renders Markdown to HTML that is safe to insert. Headings start at h3, since the page has its own h1 and h2. */
export function renderMarkdown(source: string): string {
  const lines = source.replaceAll(PARK, "").replace(/\r\n?/g, "\n").split("\n");
  return blocks(lines);
}

function blocks(lines: string[]): string {
  const html: string[] = [];
  let i = 0;
  const startsBlock = (line: string) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line);
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const code: string[] = [];
      for (i++; i < lines.length && !new RegExp(`^\\s{0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`).test(lines[i]!); i++) code.push(lines[i]!);
      i++;
      html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(heading[1]!.length + 2, 6);
      html.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      html.push("<hr>");
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]!); i++) quoted.push(QUOTE.exec(lines[i]!)![1]!);
      html.push(`<blockquote>${blocks(quoted)}</blockquote>`);
      continue;
    }
    if (ITEM.test(line)) {
      const taken: string[] = [];
      const first = ITEM.exec(line)!;
      /** Whether an item continues this list: same kind of marker, not less indented (a bullet after a numbered item starts another list). */
      const continues = (l: string) => {
        const m = ITEM.exec(l);
        return !!m && (m[1]!.length > first[1]!.length || /\d/.test(m[2]!) === /\d/.test(first[2]!));
      };
      // A list goes on over blank lines when an item follows, and over indented lines.
      for (; i < lines.length; i++) {
        const l = lines[i]!;
        if (ITEM.test(l) && !continues(l)) break;
        if (!l.trim()) {
          const next = lines.slice(i + 1).find((x) => x.trim());
          if (next && ((ITEM.test(next) && continues(next)) || /^\s{2,}\S/.test(next))) {
            taken.push("");
            continue;
          }
          break;
        }
        if (!ITEM.test(l) && !/^\s+\S/.test(l) && startsBlock(l)) break;
        taken.push(l);
      }
      html.push(list(taken));
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      for (; i < lines.length && lines[i]!.trim() && lines[i]!.includes("|"); i++) rows.push(cells(lines[i]!));
      const row = (cs: string[], tag: string) => `<tr>${head.map((_, k) => `<${tag}>${inline(cs[k] ?? "")}</${tag}>`).join("")}</tr>`;
      html.push(`<table><thead>${row(head, "th")}</thead><tbody>${rows.map((r) => row(r, "td")).join("")}</tbody></table>`);
      continue;
    }
    const paragraph: string[] = [];
    for (; i < lines.length && lines[i]!.trim() && (paragraph.length === 0 || !startsBlock(lines[i]!)); i++) paragraph.push(lines[i]!.trim());
    html.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
  }
  return html.join("\n");
}

/** One list (its items and what is nested in them). The list is ordered when its first marker is a number. */
function list(lines: string[]): string {
  const first = ITEM.exec(lines[0]!)!;
  const indent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: string[][] = [];
  for (const l of lines) {
    const m = ITEM.exec(l);
    if (m && m[1]!.length <= indent) items.push([m[3]!]);
    else if (items.length) items.at(-1)!.push(l);
  }
  const tag = ordered ? "ol" : "ul";
  const body = items.map(([head, ...rest]) => {
    // What is under an item is rendered as blocks of its own, so a nested list or a second paragraph works.
    const nested = rest.length ? blocks(dedent(rest)) : "";
    return `<li>${inline(head!)}${nested ? `\n${nested}` : ""}</li>`;
  });
  return `<${tag}>${body.join("")}</${tag}>`;
}

function dedent(lines: string[]): string[] {
  const widths = lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length);
  const cut = widths.length ? Math.min(...widths) : 0;
  return lines.map((l) => l.slice(cut));
}
