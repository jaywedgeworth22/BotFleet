import { useEffect, useRef, useState } from "react";
import { Check, Copy, Hash } from "lucide-react";
import { cn } from "@/lib/cn";

export interface CopyButtonProps {
  text?: string;
  messageId?: string;
  requestId?: string;
  className?: string;
  copied?: boolean;
  onCopy?: () => void;
}

export function CopyButton({
  text = "",
  messageId,
  requestId,
  className,
  copied: externalCopied,
  onCopy,
}: CopyButtonProps) {
  const [copiedType, setCopiedType] = useState<"text" | "id" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const effectiveId = requestId || messageId;
  const isCopied = externalCopied || copiedType !== null;

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const copyText = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!text) return;
    void navigator.clipboard?.writeText(text);
    setCopiedType("text");
    setMenuOpen(false);
    onCopy?.();
    setTimeout(() => setCopiedType(null), 1400);
  };

  const copyId = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!effectiveId) return;
    void navigator.clipboard?.writeText(effectiveId);
    setCopiedType("id");
    setMenuOpen(false);
    onCopy?.();
    setTimeout(() => setCopiedType(null), 1400);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!effectiveId) return;
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen((prev) => !prev);
  };

  return (
    <div className="relative inline-flex items-center">
      <button
        ref={buttonRef}
        type="button"
        onClick={copyText}
        onContextMenu={handleContextMenu}
        aria-label={effectiveId ? "Copy message text (right-click for ID)" : "Copy message"}
        title={
          isCopied
            ? copiedType === "id"
              ? "Copied ID to clipboard!"
              : "Copied to clipboard!"
            : effectiveId
              ? "Copy message (Right-click for Request ID)"
              : "Copy message"
        }
        className={cn(
          "rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
          isCopied && "!opacity-100 text-success hover:text-success",
          menuOpen && "!opacity-100 bg-raised text-ink",
          className,
        )}
      >
        {isCopied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
      </button>

      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute bottom-full right-0 z-50 mb-1.5 min-w-[160px] rounded-xl border border-hairline/50 bg-panel/95 p-1 text-[12.5px] shadow-xl backdrop-blur-md"
        >
          <button
            type="button"
            onClick={copyText}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ink hover:bg-control"
          >
            <Copy size={13} className="text-ink-secondary" />
            <span>Copy Text</span>
          </button>
          {effectiveId && (
            <button
              type="button"
              onClick={copyId}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ink hover:bg-control"
            >
              <Hash size={13} className="text-ink-secondary" />
              <div className="flex min-w-0 flex-col">
                <span>{requestId ? "Copy Request ID" : "Copy Message ID"}</span>
                <span className="truncate font-mono text-[10px] text-ink-secondary">{effectiveId}</span>
              </div>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
