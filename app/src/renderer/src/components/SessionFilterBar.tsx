import { LANES } from "@shared/tasks";
import {
  NO_FILTER,
  accountTitle,
  activeChips,
  folderLabel,
  toggled,
  type SessionFilter,
} from "@shared/sessionFilter";

/**
 * The Sessions column's filters: one line ("Filters", how many are on, a chip for each, Clear all)
 * that opens to the search and the choices. Within a group any picked value matches; groups combine.
 */
export function SessionFilterBar({
  filter,
  onFilter,
  open,
  onOpen,
  multi,
  accounts,
  folders,
}: {
  filter: SessionFilter;
  onFilter: (f: SessionFilter) => void;
  open: boolean;
  onOpen: (open: boolean) => void;
  /** Two or more accounts: only then is there an Account group. */
  multi: boolean;
  accounts: string[];
  folders: string[];
}) {
  const chips = activeChips(filter, multi);
  const pick = (key: string, on: boolean, label: string, title: string | undefined, toggle: () => void) => (
    <button
      key={key}
      className={`chip btnlike ${on ? "on" : ""}`}
      aria-pressed={on}
      title={title}
      onClick={toggle}
    >
      {label}
    </button>
  );
  return (
    <div className={`sfilter ${open ? "open" : ""}`}>
      <div className="sfilter-line">
        <button
          className="sfilter-toggle"
          aria-expanded={open}
          onClick={() => onOpen(!open)}
          title={open ? "Hide the filters" : "Filter the sessions"}
        >
          <span className="mark">{open ? "▾" : "▸"}</span> Filters
          {chips.length > 0 && <span className="count">{chips.length}</span>}
        </button>
        <span className="sfilter-chips">
          {!open &&
            chips.map((c) => (
              <span key={c.id} className="chip sfilter-chip" title={c.label}>
                <span className="sfilter-chip-text">{c.label}</span>
                <button
                  aria-label={`Remove filter ${c.label}`}
                  title="Remove this filter"
                  onClick={() => onFilter(c.without)}
                >
                  ×
                </button>
              </span>
            ))}
        </span>
        {chips.length > 0 && (
          <button className="link-btn sfilter-clear" onClick={() => onFilter(NO_FILTER)}>
            Clear all
          </button>
        )}
      </div>
      {open && (
        <div className="sfilter-body">
          <input
            className="sfilter-search"
            type="search"
            placeholder="Search session names"
            aria-label="Search session names"
            value={filter.q}
            onChange={(e) => onFilter({ ...filter, q: e.target.value })}
            onKeyDown={(e) => e.key === "Escape" && filter.q && (e.stopPropagation(), onFilter({ ...filter, q: "" }))}
          />
          <div className="sfilter-group" role="group" aria-label="Status">
            <span className="sfilter-label">Status</span>
            {LANES.map((l) =>
              pick(l.id, filter.status.includes(l.id), l.title, l.hint, () =>
                onFilter({ ...filter, status: toggled(filter.status, l.id) }),
              ),
            )}
          </div>
          {multi && (
            <div className="sfilter-group" role="group" aria-label="Account">
              <span className="sfilter-label">Account</span>
              {accounts.map((a) =>
                pick(a, filter.accounts.includes(a), accountTitle(a), undefined, () =>
                  onFilter({ ...filter, accounts: toggled(filter.accounts, a) }),
                ),
              )}
            </div>
          )}
          {folders.length > 0 && (
            <div className="sfilter-group" role="group" aria-label="Repository or folder">
              <span className="sfilter-label">Repo</span>
              {folders.map((d) =>
                pick(d, filter.folders.includes(d), folderLabel(d), d, () =>
                  onFilter({ ...filter, folders: toggled(filter.folders, d) }),
                ),
              )}
            </div>
          )}
          <div className="sfilter-group" role="group" aria-label="Starred">
            <span className="sfilter-label">Show</span>
            {pick("starred", filter.starred, "★ Starred only", "Only the sessions you starred", () =>
              onFilter({ ...filter, starred: !filter.starred }),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
