import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ALL, type GroupOp, type SessionGroups } from "@shared/sessionGroups";
import { deck } from "../deck";
import { can } from "../web";

const SESSION_MIME = "text/masterdeck-session";
const GROUP_MIME = "text/masterdeck-group";

/**
 * The session list's tabs (#146): All, then the user's tabs. A session dragged from the list is
 * dropped on a tab to put it there (on All: out of its tab); a tab is dragged to reorder it.
 * Right-click a tab to rename, move or delete it. Scrolls sideways when the tabs do not fit.
 */
export function SessionGroupBar({
  groups,
  tab,
  onTab,
  counts,
  hot,
  draggingSession,
  onAssign,
  onDragOverBar,
  flash,
}: {
  groups: SessionGroups;
  tab: string;
  onTab: (id: string) => void;
  /** Sessions per tab id (ALL: every one). */
  counts: Record<string, number>;
  /** Sessions with an open Needs-you item per tab id. */
  hot: Record<string, number>;
  /** A session row is being dragged: tabs take the drop. */
  draggingSession: boolean;
  onAssign: (key: string, group: string | null) => void;
  /** A session is dragged over the bar: the list's drop marker goes. */
  onDragOverBar: () => void;
  flash: (m: string) => void;
}) {
  const editable = can("sessionGroupsAct");
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dragTab, setDragTab] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const selected = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    selected.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [tab]);

  const act = async (op: GroupOp): Promise<{ ok: boolean; id?: string }> => {
    const r = await deck().sessionGroupsAct(op);
    if (!r.ok) flash(r.message);
    return r;
  };
  const clear = () => {
    setDragTab(null);
    setOver(null);
  };
  const ids = groups.groups.map((g) => g.id);
  const moveBy = (id: string, by: -1 | 1) => {
    const i = ids.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= ids.length) return;
    // Before the one after the new place (null: the end).
    void act({ op: "move", id, before: by < 0 ? ids[j] : (ids[j + 1] ?? null) });
  };
  const remove = async (id: string) => {
    const g = groups.groups.find((x) => x.id === id);
    const r = await act({ op: "remove", id });
    if (r.ok && g) {
      flash(`Deleted tab ${g.name}. Its sessions are in All.`);
      if (tab === id) onTab(ALL);
    }
  };

  // What dropping on a tab does: a session goes in it (All: out of its tab), a tab goes before it.
  const dropProps = (id: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!editable || (!draggingSession && !(dragTab && dragTab !== id))) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOver(id);
    },
    onDragLeave: () => setOver((o) => (o === id ? null : o)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const key = e.dataTransfer.getData(SESSION_MIME);
      const g = e.dataTransfer.getData(GROUP_MIME);
      if (key) onAssign(key, id === ALL ? null : id);
      else if (g && g !== id) void act({ op: "move", id: g, before: id === ALL ? (ids[0] ?? null) : id });
      clear();
    },
  });

  const tabButton = (id: string, name: string) => {
    const on = id === tab;
    const n = hot[id] ?? 0;
    const custom = id !== ALL;
    if (renaming === id)
      return (
        <NameInput
          key={id}
          initial={name}
          onDone={async (v) => {
            if (v !== null && v !== name && !(await act({ op: "rename", id, name: v })).ok) return false;
            setRenaming(null);
            return true;
          }}
        />
      );
    return (
      <button
        key={id}
        ref={on ? selected : undefined}
        role="tab"
        aria-selected={on}
        className={`sgroup ${on ? "on" : ""} ${over === id ? (draggingSession ? "drop" : "drop-before") : ""} ${dragTab === id ? "dragging" : ""}`}
        title={
          custom
            ? `${name}: ${counts[id] ?? 0} session${counts[id] === 1 ? "" : "s"}. Drag a session here to put it in this tab; right-click to rename, move or delete.`
            : "Every session. Drag a session here to take it out of its tab."
        }
        onClick={() => onTab(id)}
        onDoubleClick={() => custom && editable && setRenaming(id)}
        onContextMenu={(e) => {
          if (!custom || !editable) return;
          e.preventDefault();
          setMenu({ id, x: e.clientX, y: e.clientY });
        }}
        draggable={custom && editable}
        onDragStart={(e) => {
          e.dataTransfer.setData(GROUP_MIME, id);
          e.dataTransfer.effectAllowed = "move";
          setDragTab(id);
        }}
        onDragEnd={clear}
        {...dropProps(id)}
      >
        <span className="sgroup-name">{name}</span>
        <span className="sgroup-count">{counts[id] ?? 0}</span>
        {n > 0 && (
          <span className="sgroup-hot" aria-label={`${n} need${n === 1 ? "s" : ""} you`}>
            {n}
          </span>
        )}
      </button>
    );
  };

  const menuGroup = menu ? groups.groups.find((g) => g.id === menu.id) : undefined;
  return (
    <div className="sgroups" role="tablist" aria-label="Session tabs" onDragEnter={() => draggingSession && onDragOverBar()}>
      {tabButton(ALL, "All")}
      {groups.groups.map((g) => tabButton(g.id, g.name))}
      {editable &&
        (adding ? (
          <NameInput
            initial=""
            onDone={async (v) => {
              const r = v === null ? null : await act({ op: "add", name: v });
              if (r && !r.ok) return false;
              setAdding(false);
              if (r?.id) onTab(r.id);
              return true;
            }}
          />
        ) : (
          <button
            className={`sgroup-add ${over === "" ? "drop-before" : ""}`}
            title="New tab"
            aria-label="New tab"
            onClick={() => setAdding(true)}
            onDragOver={(e) => {
              if (!dragTab) return;
              e.preventDefault();
              setOver("");
            }}
            onDragLeave={() => setOver((o) => (o === "" ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              const g = e.dataTransfer.getData(GROUP_MIME);
              if (g) void act({ op: "move", id: g, before: null });
              clear();
            }}
          >
            +
          </button>
        ))}
      {menu && menuGroup && (
        <GroupMenu
          x={menu.x}
          y={menu.y}
          name={menuGroup.name}
          first={ids[0] === menu.id}
          last={ids.at(-1) === menu.id}
          onClose={() => setMenu(null)}
          onRename={() => setRenaming(menu.id)}
          onLeft={() => moveBy(menu.id, -1)}
          onRight={() => moveBy(menu.id, 1)}
          onDelete={() => void remove(menu.id)}
        />
      )}
    </div>
  );
}

/** A tab's name, typed in place: Enter or leaving it saves, Esc (or nothing typed) cancels. */
function NameInput({ initial, onDone }: { initial: string; onDone: (v: string | null) => Promise<boolean> }) {
  const [v, setV] = useState(initial);
  // Set while a save runs (and after it closed the input), so a blur after Enter saves nothing twice.
  const busy = useRef(false);
  const finish = (value: string | null) => {
    if (busy.current) return;
    busy.current = true;
    // A refused name (taken, too long) stays to be fixed.
    void onDone(value).then((closed) => {
      if (!closed) busy.current = false;
    });
  };
  return (
    <input
      className="sgroup-input"
      autoFocus
      value={v}
      maxLength={40}
      placeholder="Tab name"
      aria-label="Tab name"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(v.trim() || null);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(v.trim() || null)}
    />
  );
}

function GroupMenu({
  x,
  y,
  name,
  first,
  last,
  onClose,
  onRename,
  onLeft,
  onRight,
  onDelete,
}: {
  x: number;
  y: number;
  name: string;
  first: boolean;
  last: boolean;
  onClose: () => void;
  onRename: () => void;
  onLeft: () => void;
  onRight: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
  }, [x, y]);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  const run = (f: () => void) => () => {
    onClose();
    f();
  };
  return createPortal(
    <div className="menu session-menu" ref={ref} style={{ left: pos.left, top: pos.top }} role="menu" aria-label={`${name} tab actions`}>
      <div className="session-menu-head" title={name}>
        {name}
      </div>
      <button onClick={run(onRename)}>Rename</button>
      <button onClick={run(onLeft)} disabled={first}>
        Move left
      </button>
      <button onClick={run(onRight)} disabled={last}>
        Move right
      </button>
      <hr />
      <button className="danger" onClick={run(onDelete)} title="Its sessions stay, in All">
        Delete tab
      </button>
    </div>,
    document.body,
  );
}
