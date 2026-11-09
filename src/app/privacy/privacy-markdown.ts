/**
 * Reads the Privacy Notice (privacy-notice.md) into blocks the page renders. The notice is kept as
 * Markdown so its source wording lives in one file, unchanged by the page. Only what the notice uses
 * is supported: `#` and `##` headings, paragraphs, `-` lists (nested by two spaces), `1.` lists, and
 * `**bold**`, `` `code` `` and `[links](https://…)` within text. Links must be `https:`. Anything else
 * is an error, so a formatting slip can't quietly change what players read, or point them somewhere unsafe.
 */

export type Inline =
  | { kind: "text" | "strong" | "code" | "email"; text: string }
  | { kind: "link"; text: string; href: string };
export type ListItem = { content: Inline[]; children: ListItem[] };
export type Block =
  | { kind: "heading"; level: 1 | 2; text: string }
  | { kind: "paragraph"; content: Inline[] }
  | { kind: "list"; ordered: boolean; items: ListItem[] };

const emailPattern = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** The link's address, if it's a safe absolute `https:` URL; otherwise an error naming it. */
export function safeHttpsUrl(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new Error(`Links must be absolute https:// addresses: ${href}`);
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw new Error(`Links must be absolute https:// addresses, without a user name or password: ${href}`);
  }
  return url.href;
}

/** Splits text into plain, **bold**, `code` and email-address pieces. */
export function parseInline(text: string): Inline[] {
  const pieces: Inline[] = [];
  const pushText = (value: string, kind: "text" | "strong") => {
    let last = 0;
    for (const match of value.matchAll(emailPattern)) {
      if (match.index > last) pieces.push({ kind, text: value.slice(last, match.index) });
      pieces.push({ kind: "email", text: match[0] });
      last = match.index + match[0].length;
    }
    if (last < value.length) pieces.push({ kind, text: value.slice(last) });
  };
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) pushText(text.slice(last, match.index), "text");
    if (match[1] !== undefined) pushText(match[1], "strong");
    else if (match[2] !== undefined) pieces.push({ kind: "code", text: match[2] });
    else pieces.push({ kind: "link", text: match[3], href: safeHttpsUrl(match[4]) });
    last = match.index + match[0].length;
  }
  if (last < text.length) pushText(text.slice(last), "text");
  if (pieces.some((piece) => piece.kind !== "code" && /\*\*|`/.test(piece.text))) {
    throw new Error(`Unmatched ** or \` in: ${text}`);
  }
  if (pieces.some((piece) => (piece.kind === "text" || piece.kind === "strong") && /\]\(|\[[^\]]*\]\s*\(/.test(piece.text))) {
    throw new Error(`Malformed link in: ${text}`);
  }
  return pieces;
}

const listLine = /^( *)(-|\d+\.) (.*)$/;

export function parsePrivacyMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const heading = /^(#{1,2}) (.+)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length as 1 | 2, text: heading[2].trim() });
      index += 1;
      continue;
    }
    if (/^#/.test(line)) throw new Error(`Unsupported heading: ${line}`);

    if (listLine.test(line)) {
      const ordered = /^\d+\./.test(line.trim());
      // Each item's depth is its indent in steps of two spaces.
      const stack: { depth: number; items: ListItem[] }[] = [{ depth: 0, items: [] }];
      while (index < lines.length && listLine.test(lines[index])) {
        const [, indent, marker, text] = listLine.exec(lines[index])!;
        if (indent.length % 2 !== 0) throw new Error(`List indent must be a multiple of two spaces: ${lines[index]}`);
        const depth = indent.length / 2;
        if (depth === 0 && /^\d+\.$/.test(marker) !== ordered) throw new Error(`Mixed list types: ${lines[index]}`);
        while (depth < stack[stack.length - 1].depth) stack.pop();
        if (depth > stack[stack.length - 1].depth) {
          const parent = stack[stack.length - 1].items.at(-1);
          if (!parent || depth !== stack[stack.length - 1].depth + 1) throw new Error(`List nested too deeply: ${lines[index]}`);
          stack.push({ depth, items: parent.children });
        }
        stack[stack.length - 1].items.push({ content: parseInline(text), children: [] });
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items: stack[0].items });
      continue;
    }

    // A paragraph: consecutive lines that aren't headings or list items.
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() !== "" && !/^#/.test(lines[index]) && !listLine.test(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", content: parseInline(paragraph.join(" ")) });
  }
  return blocks;
}

/** The text a reader sees, for comparing the page with the notice source. */
export function plainText(blocks: Block[]): string {
  const inline = (content: Inline[]) => content.map((piece) => piece.text).join("");
  const items = (list: ListItem[]): string[] => list.flatMap((item) => [inline(item.content), ...items(item.children)]);
  return blocks
    .flatMap((block) => (block.kind === "heading" ? [block.text] : block.kind === "paragraph" ? [inline(block.content)] : items(block.items)))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
