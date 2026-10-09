import { useMemo, useState, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "@shared/markdown";
import { deck } from "../deck";

/**
 * Markdown as GitHub shows it in an issue, drawn from `parseMarkdown`'s tree: React elements only,
 * never HTML built from the text. `html: false` (notes) reads no tag at all. A link opens in the browser; an image that does not load (a
 * private repository's upload needs a login the app does not have) becomes a link to it.
 */
export function MarkdownView({ text, className, html = true }: { text: string; className?: string; html?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(text, { html }), [text, html]);
  return <div className={`mdv${className ? ` ${className}` : ""}`}>{blocks.map(block)}</div>;
}

function Img({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Link href={src}>{alt || "image"} ↗</Link>;
  return <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        deck().openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

function inline(n: Inline, i: number): ReactNode {
  switch (n.t) {
    case "text":
      return n.v;
    case "code":
      return <code key={i}>{n.v}</code>;
    case "br":
      return <br key={i} />;
    case "strong":
      return <strong key={i}>{n.c.map(inline)}</strong>;
    case "em":
      return <em key={i}>{n.c.map(inline)}</em>;
    case "del":
      return <del key={i}>{n.c.map(inline)}</del>;
    case "link":
      return (
        <Link key={i} href={n.href}>
          {n.c.map(inline)}
        </Link>
      );
    case "image":
      return <Img key={i} src={n.src} alt={n.alt} />;
  }
}

function block(b: Block, i: number): ReactNode {
  switch (b.t) {
    case "heading": {
      const H = `h${b.level}` as "h1";
      return <H key={i}>{b.c.map(inline)}</H>;
    }
    case "para":
      return <p key={i}>{b.c.map(inline)}</p>;
    case "code":
      return (
        <pre key={i} data-lang={b.lang || undefined}>
          <code>{b.v}</code>
        </pre>
      );
    case "quote":
      return <blockquote key={i}>{b.c.map(block)}</blockquote>;
    case "hr":
      return <hr key={i} />;
    case "list": {
      const items = b.items.map((it, j) => (
        <li key={j} className={it.task === null ? undefined : "task"}>
          {it.task !== null && <input type="checkbox" checked={it.task} readOnly disabled aria-label={it.task ? "done" : "not done"} />}
          {/* A one-line item reads as a line, not a paragraph. */}
          {it.c.map((c, k) => (c.t === "para" && k === 0 ? <span key={k}>{c.c.map(inline)}</span> : block(c, k)))}
        </li>
      ));
      return b.ordered ? (
        <ol key={i} start={b.start}>
          {items}
        </ol>
      ) : (
        <ul key={i}>{items}</ul>
      );
    }
    case "table":
      return (
        <div key={i} className="mdv-table">
          <table>
            <thead>
              <tr>
                {b.head.map((c, j) => (
                  <th key={j}>{c.map(inline)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, k) => (
                    <td key={k}>{c.map(inline)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}
