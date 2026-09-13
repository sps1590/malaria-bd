"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/* ------------------------------- Attribution ------------------------------ */

const DEVELOPER_NAME = "Md. Shahriar Parvez";
const DEVELOPER_ROLE = "MIS/IT Expert | NMEP";
/** Plain-text form for exported files (PNG stamp, .xlsx banner rows, .pdf header/footer). */
export const BUILT_BY = `Developed by: ${DEVELOPER_NAME} | ${DEVELOPER_ROLE}`;

/**
 * Credit line shown in the header/footer of every page and stamped onto every exported file.
 * The name renders in its own span (via `nameClassName`) so callers can give it an accent color
 * that actually stands out against their background, rather than one flat, easy-to-miss tone.
 */
export function Attribution({ className = "", nameClassName = "" }: { className?: string; nameClassName?: string }) {
  return (
    <span className={`whitespace-nowrap ${className}`}>
      Developed by: <span className={`font-semibold ${nameClassName}`}>{DEVELOPER_NAME}</span> <span className="opacity-80">| {DEVELOPER_ROLE}</span>
    </span>
  );
}

/* --------------------------------- Icons --------------------------------- */

export type IconName =
  | "cases" | "deaths" | "tests" | "percent" | "activity" | "droplet" | "microscope"
  | "download" | "expand" | "layers" | "close";

const PATHS: Record<IconName, ReactNode> = {
  cases: (
    <>
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
    </>
  ),
  deaths: (
    <>
      <path d="M19.5 13.6C21 12 22 10.4 22 8.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .6-4.5 2-1.5-1.4-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 1.9 1 3.5 2.5 5.1L12 21z" />
      <path d="M12.5 6.5 10.5 10l3 2.5-2 3.5" />
    </>
  ),
  tests: <path d="M9 3h6M10 3v6.2L4.6 18.4A1.7 1.7 0 0 0 6.1 21h11.8a1.7 1.7 0 0 0 1.5-2.6L14 9.2V3M7.2 15h9.6" />,
  percent: (
    <>
      <path d="M19 5 5 19" />
      <circle cx="6.5" cy="6.5" r="2.5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
    </>
  ),
  activity: <path d="M22 12h-4l-3 8L9 4l-3 8H2" />,
  droplet: <path d="M12 2.8 17.7 8.5a8 8 0 1 1-11.4 0z" />,
  microscope: <path d="M6 18h8M3 22h18M14 22a7 7 0 1 0 0-14h-1M9 14h2M9 12a2 2 0 0 1-2-2V6h6v4a2 2 0 0 1-2 2zM12 6V3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3" />,
  download: <path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M4 17v3h16v-3" />,
  expand: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  layers: <path d="m12 2 10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
};

export function Icon({ name, className = "h-4 w-4" }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {PATHS[name]}
    </svg>
  );
}

export function IconButton({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="grid h-7 w-7 place-items-center rounded-md border border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
    >
      <Icon name={icon} />
    </button>
  );
}

/* ------------------------------ PNG download ------------------------------ */

const TRANSPARENT_PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

/** Saves the referenced element (chart, map, table) as a PNG in the viewer's browser. */
export function DownloadImageButton({ target, filename }: { target: RefObject<HTMLElement | null>; filename: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      title="Download as PNG image"
      aria-label="Download as PNG image"
      disabled={busy}
      data-no-export="true"
      onClick={async (e) => {
        e.stopPropagation();
        const node = target.current;
        if (!node) return;
        setBusy(true);
        // Stamp the credit line onto the node just for the capture, then remove it — keeps every
        // PNG export attributed without cluttering the on-screen widget.
        const stamp = document.createElement("div");
        stamp.textContent = BUILT_BY;
        Object.assign(stamp.style, {
          position: "absolute", right: "6px", bottom: "4px", fontSize: "9px", lineHeight: "1.4",
          color: "#94a3b8", background: "rgba(255,255,255,0.85)", padding: "1px 6px", borderRadius: "4px",
          pointerEvents: "none", zIndex: "9999",
        });
        const needsRelative = getComputedStyle(node).position === "static";
        if (needsRelative) node.style.setProperty("position", "relative");
        node.appendChild(stamp);
        try {
          const { toPng } = await import("html-to-image");
          const url = await toPng(node, {
            backgroundColor: "#ffffff",
            pixelRatio: 2,
            imagePlaceholder: TRANSPARENT_PIXEL,
            filter: (el) => !(el instanceof HTMLElement && el.dataset.noExport === "true"),
          });
          const link = document.createElement("a");
          link.href = url;
          link.download = `${filename.replace(/[^\w.-]+/g, "-").toLowerCase()}.png`;
          link.click();
        } catch (err) {
          console.error("PNG export failed", err);
          window.alert("Could not create the image. Please try again.");
        } finally {
          stamp.remove();
          if (needsRelative) node.style.removeProperty("position");
          setBusy(false);
        }
      }}
      className="grid h-7 w-7 place-items-center rounded-md border border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-50"
    >
      {busy ? <span className="text-xs">…</span> : <Icon name="download" />}
    </button>
  );
}

/* --------------------------------- Modal --------------------------------- */

export function Modal({ title, onClose, actions, children }: { title: string; onClose: () => void; actions?: ReactNode; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[3000] flex items-center justify-center bg-slate-950/60 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="flex h-[90vh] w-[min(1500px,96vw)] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
          <h2 className="text-base font-semibold text-slate-800">{title}</h2>
          <div className="flex flex-wrap items-center gap-2">
            {actions}
            <IconButton icon="close" label="Close" onClick={onClose} />
          </div>
        </div>
        <div className="min-h-0 flex-1 p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/* -------------------------------- PopoutCard ------------------------------- */

/**
 * Standard wrapper for every table/chart block outside the BI tab (which has its own richer,
 * drag-and-drop Widget): a bordered card with a header carrying a PNG-download button and an
 * "open larger" button that pops the same content into the full BI-style Modal. Pass a render
 * function as children when the expanded view should look different (e.g. a taller chart) —
 * mirrors BiTab's own `body: (big) => …` widgets — or a plain node otherwise.
 */
export function PopoutCard({
  title,
  downloadName,
  headerExtra,
  actions,
  className = "",
  bodyClassName = "",
  noDownload = false,
  children,
}: {
  title: string;
  downloadName?: string;
  /** Subtitle/note rendered under the title, on the left. */
  headerExtra?: ReactNode;
  /** Extra controls rendered on the right, before the download/expand buttons (e.g. a "See all →" link). */
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** The block has nothing meaningful to rasterize as-is (e.g. a virtualized grid) — hide the download button. */
  noDownload?: boolean;
  children: ReactNode | ((expanded: boolean) => ReactNode);
}) {
  const [expanded, setExpanded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const modalBodyRef = useRef<HTMLDivElement>(null);
  const render = (big: boolean) => (typeof children === "function" ? children(big) : children);
  const name = downloadName ?? title;

  return (
    <section className={`rounded-xl border border-slate-200 bg-white p-4 ${className}`}>
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          {headerExtra}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {actions}
          {!noDownload && <DownloadImageButton target={bodyRef} filename={name} />}
          <IconButton icon="expand" label="Open larger" onClick={() => setExpanded(true)} />
        </div>
      </div>
      <div ref={bodyRef} className={bodyClassName}>
        {render(false)}
      </div>

      {expanded && (
        <Modal
          title={title}
          onClose={() => setExpanded(false)}
          actions={!noDownload ? <DownloadImageButton target={modalBodyRef} filename={name} /> : undefined}
        >
          <div ref={modalBodyRef} className={`h-full bg-white ${bodyClassName}`}>
            {render(true)}
          </div>
        </Modal>
      )}
    </section>
  );
}
