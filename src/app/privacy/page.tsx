import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import AppShell from "../app-shell";
import { parsePrivacyMarkdown, type Block, type Inline, type ListItem } from "./privacy-markdown";

export const metadata: Metadata = {
  title: "Privacy Notice | Plantetary",
  description: "What information Plantetary handles, where it's kept, and how to contact us about it.",
};

/**
 * The Privacy Notice source, word for word from privacy-notice.md, read when the site is built. Open to
 * everyone: guests and signed-in players alike, with or without sign-in set up.
 */
function readNotice(): Block[] {
  return parsePrivacyMarkdown(readFileSync(join(process.cwd(), "src/app/privacy/privacy-notice.md"), "utf8"));
}

function slug(text: string) {
  return `privacy-${text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function renderInline(content: Inline[]): ReactNode[] {
  return content.map((piece, index) => {
    if (piece.kind === "strong") return <strong key={index}>{piece.text}</strong>;
    if (piece.kind === "code") return <code key={index}>{piece.text}</code>;
    if (piece.kind === "email") {
      return <a key={index} className="text-link" href={`mailto:${piece.text}`}>{piece.text}</a>;
    }
    // Only https addresses get this far (safeHttpsUrl). They open in the same tab, like the app's own links.
    if (piece.kind === "link") return <a key={index} className="text-link" href={piece.href}>{piece.text}</a>;
    return piece.text;
  });
}

function renderList(items: ListItem[], ordered: boolean): ReactNode {
  const children = items.map((item, index) => (
    <li key={index}>
      {renderInline(item.content)}
      {item.children.length > 0 && renderList(item.children, false)}
    </li>
  ));
  return ordered ? <ol>{children}</ol> : <ul>{children}</ul>;
}

function renderBlock(block: Block, index: number): ReactNode {
  if (block.kind === "paragraph") {
    const effectiveDate = block.content[0]?.kind === "strong" && block.content[0].text.startsWith("Effective date:");
    return <p key={index} className={effectiveDate ? "privacy-effective-date" : undefined}>{renderInline(block.content)}</p>;
  }
  if (block.kind === "list") return <div key={index}>{renderList(block.items, block.ordered)}</div>;
  return null;
}

export default function PrivacyPage() {
  const blocks = readNotice();
  const [title, ...rest] = blocks;
  if (title?.kind !== "heading" || title.level !== 1) throw new Error("The Privacy Notice must start with its # title");

  // The introduction (effective date and opening paragraph), then one card per ## section.
  const firstSection = rest.findIndex((block) => block.kind === "heading");
  const introduction = firstSection === -1 ? rest : rest.slice(0, firstSection);
  const sections: { heading: string; blocks: Block[] }[] = [];
  for (const block of firstSection === -1 ? [] : rest.slice(firstSection)) {
    if (block.kind === "heading") sections.push({ heading: block.text, blocks: [] });
    else sections.at(-1)!.blocks.push(block);
  }

  return (
    <AppShell page="privacy">
      <main className="settings-content privacy-content">
        <article className="privacy-notice" aria-labelledby="privacy-title">
          <header className="settings-heading privacy-heading">
            <h1 id="privacy-title">{title.text}</h1>
            {introduction.map(renderBlock)}
          </header>
          {sections.map(({ heading, blocks: sectionBlocks }) => (
            <section className="settings-section privacy-section" key={heading} aria-labelledby={slug(heading)}>
              <h2 id={slug(heading)}>{heading}</h2>
              {sectionBlocks.map(renderBlock)}
            </section>
          ))}
        </article>
      </main>
    </AppShell>
  );
}
