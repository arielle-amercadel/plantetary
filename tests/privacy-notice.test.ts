import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseInline, parsePrivacyMarkdown, plainText, safeHttpsUrl, type Block } from "../src/app/privacy/privacy-markdown";

const notice = readFileSync(resolve(__dirname, "../src/app/privacy/privacy-notice.md"), "utf8");
const blocks = parsePrivacyMarkdown(notice);
const headings = (list: Block[]) => list.filter((block) => block.kind === "heading").map((block) => block.text);

describe("the Privacy Notice source", () => {
  it("is an exact match for the reviewed source text", () => {
    // Detect unintended source changes; update this fingerprint alongside intentional wording edits.
    // Matching this text is not legal review or publication approval.
    expect(createHash("sha256").update(notice).digest("hex")).toBe("0304e1d935c1d5b81ee37260868c20d723bb3840cad45d9edaa7d42cb86c57aa");
  });

  it("has its title and every expected section, in order", () => {
    expect(blocks[0]).toEqual({ kind: "heading", level: 1, text: "Plantetary Privacy Notice" });
    expect(headings(blocks.slice(1))).toEqual([
      "The short version",
      "What Plantetary collects",
      "Guests and signed-in players",
      "Browser storage and cookies",
      "Cloud saves, backups and how long they're kept",
      "Services we use",
      "How your information is protected",
      "Your choices: access, correction and deletion",
      "What happens after your account is deleted",
      "Children's privacy",
      "Changes to this notice",
      "Contact",
    ]);
  });

  it("keeps the effective date as a clearly marked placeholder until it's published", () => {
    expect(blocks[1]).toEqual({ kind: "paragraph", content: [{ kind: "strong", text: "Effective date: [DATE — to be set when published]" }] });
  });

  it("names Plantetary as the operator, with its contact address, and no personal name", () => {
    const text = plainText(blocks);
    expect(text).toContain("This notice is from Plantetary — an independent personal project.");
    expect(text.match(/hello\.plantetary@gmail\.com/g)).toHaveLength(5);
  });

  it("describes documented data practices", () => {
    const text = plainText(blocks);
    // 13+, as an acknowledgment only.
    expect(text).toContain("Plantetary accounts are for people 13 and older; teenagers aged 13 to 17 are welcome.");
    expect(text).toContain("isn't directed to children under 13");
    expect(text).toContain("Before you can ask for a sign-in link, you confirm that you're at least 13 years old.");
    expect(text).toContain("Plantetary doesn't collect birthdays and doesn't independently verify ages.");
    expect(text).toContain("we'll promptly look into it and take appropriate steps to delete it");
    // When an email address is stored, and that signing in is a separate step.
    expect(text).toContain("Asking for a sign-in link creates an account for that address with Supabase, even if the link is never used.");
    // Cookies: possibly several, including temporary sign-in codes, and sign-out may not remove them all.
    expect(text).toContain("A long session may be split across a few cookies.");
    expect(text).toContain("Signing out ends your signed-in session in that browser, but may not remove every temporary sign-in cookie.");
    // Requests: access, correction and deletion, handled by hand, verified, aiming for 30 days.
    expect(text).toContain("We aim to complete verified requests within 30 days, or sooner when the law requires it.");
    expect(text).toContain("Deletion isn't automatic or immediate");
    expect(text).toContain("It doesn't include your email address or other sign-in information, or your cloud backups.");
    // Backups as they are now: by count, possibly indefinitely, and players can't change or delete them.
    expect(text).toContain("Backups are currently kept by number, not by date.");
    expect(text).toContain("older copies may be kept indefinitely");
    expect(text).toContain("players can't change or delete them");
    expect(text).toContain("Our practice is to delete these copies by hand within 30 days.");
    expect(text).toContain("Plantetary can't see it or delete it for you.");
    expect(text).toContain("We may update this notice from time to time. When we do, we'll update the effective date shown on this page.");
  });

  it("describes best-effort conflict copies, local recovery and retained reset metadata", () => {
    const text = plainText(blocks);
    expect(text).toContain("Plantetary attempts to keep a copy of the unsaved version. This attempt can fail.");
    expect(text).toContain("Up to 20 successfully stored conflict copies are kept");
    expect(text).not.toContain("the version that couldn't be saved is kept");
    expect(text).toContain("Closing or reloading the page before downloading can lose this recovery copy.");
    expect(text).toContain("resetting does not remove this marker");
    expect(text).toContain("Reset may be blocked during conflicts or storage failures");
  });

  it("avoids the listed unsupported claims", () => {
    const text = plainText(blocks);
    expect(text).not.toMatch(/One cookie/i);
    expect(text).not.toContain("doesn't ask for your age");
    expect(text).not.toMatch(/read and change only its own garden and backups/);
    // Not built: no restoring backups on request, no in-app announcements, no age-based backup cleanup.
    expect(text).not.toMatch(/restore|announce|in the app when|let players know in the app/i);
    expect(text).not.toMatch(/30 days old|90 days|removed automatically once a day/i);
    // No claims of legal compliance, verified ages or perfect security.
    expect(text).not.toMatch(/COPPA|compliant|complies with|in compliance|age verification|we verify (your )?age/i);
    expect(text).toContain("No system is completely secure");
  });

  it("links to the providers' official privacy pages", () => {
    const links = blocks.flatMap((block) => block.kind === "list"
      ? block.items.flatMap((item) => item.content)
      : block.kind === "paragraph" ? block.content : [])
      .filter((piece) => piece.kind === "link");
    expect(links).toEqual([
      { kind: "link", text: "Supabase's privacy policy", href: "https://supabase.com/privacy" },
      { kind: "link", text: "Vercel's privacy notice", href: "https://vercel.com/legal/privacy-policy" },
    ]);
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

describe("links in the notice", () => {
  it("reads [text](https://…) as a link", () => {
    expect(parseInline("See [the policy](https://example.com/privacy).")).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "the policy", href: "https://example.com/privacy" },
      { kind: "text", text: "." },
    ]);
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://example.com/privacy",
    "mailto:someone@example.com",
    "vbscript:msgbox(1)",
    "//example.com/privacy",
    "/privacy",
    "privacy",
    "https://user:secret@example.com/",
    "https://",
  ])("refuses an unsafe or non-https address: %s", (href) => {
    expect(() => safeHttpsUrl(href)).toThrow();
    expect(() => parseInline(`[x](${href})`)).toThrow();
  });

  it("refuses a link that isn't written properly, rather than showing it as text", () => {
    expect(() => parseInline("[text] (https://example.com)")).toThrow("Malformed link");
    expect(() => parseInline("text](https://example.com)")).toThrow("Malformed link");
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
