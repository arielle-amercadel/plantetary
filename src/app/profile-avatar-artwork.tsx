import type { ProfilePreferences } from "./settings-logic";

type AvatarId = ProfilePreferences["avatar"];

export default function ProfileAvatarArtwork({ avatar }: { avatar: AvatarId }) {
  const common = {
    shapeRendering: "crispEdges" as const,
    width: 30,
    height: 30,
    viewBox: "0 0 24 24",
    "aria-hidden": true as const,
    focusable: false as const,
  };

  if (avatar === null) {
    return (
      <svg {...common}>
        <path d="M9 2h6v2h4v4h2v8h-2v4h-4v2H9v-2H5v-4H3V8h2V4h4V2Zm0 2v2H7v2H5v8h2v2h2v2h6v-2h2v-2h2V8h-2V6h-2V4H9Z" fill="#728365" fillRule="evenodd" />
      </svg>
    );
  }

  if (avatar === "seedling") {
    return (
      <svg {...common}>
        <path d="M11 12h2v9h-2zM9 5h4v2h2v3h-2v2h-2v-2H8V8h1zM7 8h2v2h2v2H9v-2H7zM13 7h2v2h2v2h-2V9h-2z" fill="#55744d" />
        <path d="M10 6h2v2h-2zM14 8h2v2h-2z" fill="#8da36b" />
      </svg>
    );
  }

  if (avatar === "leaf") {
    return (
      <svg {...common}>
        <path d="M5 16v-4h2V8h3V5h5v2h4v5h-2v4h-4v2h-4v-2H5Z" fill="#55744d" />
        <path d="M8 14h3v-3h3V8h3v2h-2v3h-3v3h-3v-2H8Z" fill="#8da36b" />
        <path d="M7 18h2v2h2v2H9v-2H7z" fill="#55744d" />
      </svg>
    );
  }

  if (avatar === "flower") {
    return (
      <svg {...common}>
        <path d="M11 12h2v9h-2zM8 18h3v2H8z" fill="#55744d" />
        <path d="M10 4h4v3h3v4h-3v3h-4v-3H7V7h3z" fill="#e6bc55" />
        <path d="M11 7h2v2h2v2h-2v2h-2v-2H9V9h2z" fill="#f5d879" />
        <path d="M11 9h2v2h-2z" fill="#a87342" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <path d="M10 4h4v2h2v6h-2v2h-2v-2h-2V8H8v4H6V8h2V6h2zM14 9h2v2h2v5h-2v2h-3v-2h1v-5h-2V9z" fill="#55744d" />
      <path d="M10 6h2v2h-2zM15 11h1v4h-1zM7 9h1v2H7z" fill="#8da36b" />
      <path d="M6 18h12v2h-1v2H7v-2H6z" fill="#a96945" />
      <path d="M8 20h8v1H8z" fill="#d49a68" />
    </svg>
  );
}
