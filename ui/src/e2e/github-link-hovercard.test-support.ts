import type { ControlUiLinkReaderPreview } from "../../../src/shared/control-ui-link-reader.js";

export const pullPreviewResponse = {
  url: "https://github.com/openclaw/openclaw/pull/99816",
  subtitle: "openclaw/openclaw #99816",
  author: "steipete",
  authorUrl: "https://github.com/steipete",
  coAuthors: ["ada", "mira", "lin"].map((name) => ({
    name,
    imageUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=",
  })),
  coAuthorCount: 5,
  badge: { label: "Merged", tone: "accent" },
  metadata: [
    { label: "", value: "+101", tone: "positive" },
    { label: "", value: "−12", tone: "negative" },
  ],
  imageUrl:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlY9Z8AAAAASUVORK5CYII=",
  createdAt: "2026-07-04T05:03:47Z",
  title: "fix(agents): derive conversation scope from trusted group facts",
  updatedAt: "2026-07-04T09:53:55Z",
} satisfies ControlUiLinkReaderPreview;

export const PULL_HREF = "https://github.com/openclaw/openclaw/pull/99816";
export const PULL_COMMENT_HREF = `${PULL_HREF}#issuecomment-123`;
