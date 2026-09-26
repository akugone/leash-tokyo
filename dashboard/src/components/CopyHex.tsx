import { useState } from "react";
import { shortHex } from "../lib/leash";

type Props = {
  /// Full address or hash: what is copied, and what the tooltip shows.
  value: string;
  head?: number;
  tail?: number;
  /// Optional link for the shortened text, e.g. the transaction on Etherscan.
  href?: string;
  what?: "address" | "hash";
};

/// A shortened address or hash that copies in full: the text keeps the full value as its tooltip, the button
/// copies it and confirms with a check mark.
export function CopyHex({ value, head = 6, tail = 4, href, what = "address" }: Props) {
  const [copied, setCopied] = useState(false);
  const text = shortHex(value, head, tail);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard API refused (older browsers, some app views): copy through a selected text area.
      const area = document.createElement("textarea");
      area.value = value;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <span className="addr num" title={value}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {text}
        </a>
      ) : (
        text
      )}
      <button
        type="button"
        className={`copy ${copied ? "copied" : ""}`}
        onClick={() => void copy()}
        title={copied ? "Copied" : `Copy ${what}`}
        aria-label={copied ? "Copied" : `Copy full ${what}`}
      >
        {copied ? "✓" : "⧉"}
      </button>
    </span>
  );
}
