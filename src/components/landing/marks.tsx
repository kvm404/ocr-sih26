export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      fill="none"
    >
      <path d="M16 3.2 28.4 10.2 16 17.2 3.6 10.2 16 3.2Z" fill="#7BA3F5" />
      <path d="M3.6 10.2 16 17.2V28.8L3.6 21.8V10.2Z" fill="#1D4ED8" />
      <path d="M16 17.2 28.4 10.2V21.8L16 28.8V17.2Z" fill="#3B6EEA" />
    </svg>
  );
}

export function IndiaFlag({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 21 15" className={className} aria-hidden="true">
      <rect width="21" height="5" fill="#FF9933" />
      <rect y="5" width="21" height="5" fill="#FFFFFF" />
      <rect y="10" width="21" height="5" fill="#138808" />
      <circle cx="10.5" cy="7.5" r="1.6" fill="none" stroke="#000080" strokeWidth="0.5" />
      <circle cx="10.5" cy="7.5" r="0.35" fill="#000080" />
    </svg>
  );
}
