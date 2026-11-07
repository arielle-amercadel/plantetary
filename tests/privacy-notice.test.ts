import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseInline, parsePrivacyMarkdown, plainText, type Block } from "../src/app/privacy/privacy-markdown";

const notice = readFileSync(resolve(__dirname, "../src/app/privacy/privacy-notice.md"), "utf8");
const blocks = parsePrivacyMarkdown(notice);
const headings = (list: Block[]) => list.filter((block) => block.kind === "heading").map((block) => block.text);

describe("the approved Privacy Notice", () => {
  it("is exactly the approved wording", () => {
    // The notice's wording is reviewed before it's published. Any change to privacy-notice.md, including
    // setting the effective date, must be approved; then update this fingerprint in the same change.
    expect(createHash("sha256").update(notice).digest("hex")).toBe("da1628b99f43c35d9278a98ef0385291609f751c2cb0e550e026da16af10ebfc");
  });

  it("has its title and every approved section, in order", () => {
    expect(blocks[0]).toEqual({ kind: "heading", level: 1, text: "Plantetary Privacy Notice" });
    expect(headings(blocks.slice(1))).toEqual([
      "The short version",
      "What Plantetary collects",
      "Guests and signed-in players",
      "Browser storage and cookies",
      "Cloud saves, backups and how long they're kept",
      "Services we use",
      "How your information is protected",
      "Your choices: access and deletion",
      "What happens after your account is deleted",
      "Children's privacy",
      "Changes to this notice",
      "Contact",
    ]);
  });

  it("keeps the effective date as a clearly marked placeholder until it's published", () => {
    expect(blocks[1]).toEqual({ kind: "paragraph", content: [{ kind: "strong", text: "Effective date: [DATE — to be set when published]" }] });
  });

  it("names Plantetary and its contact address, and the approved commitments", () => {
    const text = plainText(blocks);
    expect(text.match(/hello\.plantetary@gmail\.com/g)).toHaveLength(4);
    expect(text).toContain("We may update this notice from time to time. When we do, we'll update the effective date shown on this page.");
    expect(text).toContain("isn't specifically directed to children under 13");
    expect(text).toContain("Our practice is to delete them by hand within 30 days.");
    expect(text).toContain("Deletion isn't automatic.");
    // Removed in the review: no offer to restore backups, no in-app notice of changes.
    expect(text).not.toMatch(/restore|let players know in the app/i);
  });

  it("reads lists, nested lists, numbered steps, bold, code and email addresses", () => {
    const cookies = blocks.find((block) => block.kind === "list" && block.items.some((item) => plainText([{ kind: "paragraph", content: item.content }]).startsWith("Session storage")));
    expect(cookies?.kind === "list" && cookies.items[1].children).toHaveLength(2);
    const steps = blocks.find((block) => block.kind === "list" && block.ordered);
    expect(steps?.kind === "list" && steps.items).toHaveLength(3);
    expect(parseInline("Ask **hello.plantetary@gmail.com** about `mi•••@example.com`.")).toEqual([
      { kind: "text", text: "Ask " },
      { kind: "email", text: "hello.plantetary@gmail.com" },
      { kind: "text", text: " about " },
      { kind: "code", text: "mi•••@example.com" },
      { kind: "text", text: "." },
    ]);
  });
});

describe("reading the notice's Markdown", () => {
  it("refuses formatting it doesn't support, rather than changing what players read", () => {
    expect(() => parsePrivacyMarkdown("### Too deep")).toThrow("Unsupported heading");
    expect(() => parsePrivacyMarkdown("Some **unclosed bold")).toThrow("Unmatched");
    expect(() => parsePrivacyMarkdown("- one\n   - odd indent")).toThrow("multiple of two");
    expect(() => parsePrivacyMarkdown("- one\n    - two levels at once")).toThrow("nested too deeply");
    expect(() => parsePrivacyMarkdown("- bullet\n1. number")).toThrow("Mixed list types");
  });

  it("joins a paragraph's lines, and keeps separate paragraphs apart", () => {
    expect(parsePrivacyMarkdown("One line\nand the next.\n\nA new one.")).toEqual([
      { kind: "paragraph", content: [{ kind: "text", text: "One line and the next." }] },
      { kind: "paragraph", content: [{ kind: "text", text: "A new one." }] },
    ]);
  });
});
