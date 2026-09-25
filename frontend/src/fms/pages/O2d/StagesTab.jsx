import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { HrmsDataTable } from "../../components/hrms/HrmsDataTable";
import { FilterBar } from "../../components/hrms/FilterBar";
import {
  o2dApi,
  formatDate,
  formatDateTime,
  formatRelative,
} from "../../services/o2d/orders";
import { O2dApiError } from "../../services/o2d/client";
import { OrderDrawer } from "./OrderDrawer";
import { OrderStatusBadge, StageBadge } from "./o2dShared";
import { ORDER_STATUS } from "@shared/constants/o2d.js";

/** Every status, so a stage keeps its record once its orders are delivered. */
const ALL_STATUSES = Object.values(ORDER_STATUS);

/**
 * The stage board — one tab per stage, and the orders sitting in it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TWELVE STAGES ARE A SECOND ROW, NOT TWELVE TOP-LEVEL TABS
 * ---------------------------------------------------------------------------
 *
 * The ask is a tab for every stage. Putting those beside My Tasks, Order
 * Tracker, Exit Register and Analytics would mean sixteen tabs competing in one
 * strip, which stops being navigation somewhere around eight — on a laptop they
 * wrap into three rows and the top-level structure disappears.
 *
 * So the stages get their own top-level tab and a rail of their own beneath it.
 * That keeps both readings true: FMS still has four places to be, and every
 * stage still has a tab you can click and link to.
 *
 * ---------------------------------------------------------------------------
 * THE SELECTED STAGE IS IN THE URL
 * ---------------------------------------------------------------------------
 *
 * `?stage=7`, the same reasoning the outer tab uses: a link to "everything
 * stuck at Warehouse Picking" is the thing a manager actually wants to paste
 * into a message, and the back button should move between stages.
 *
 * A SEARCH PARAM rather than a path segment because the route is `/fms/o2d/:tab`
 * — adding `/fms/o2d/stages/7` would mean a second route shape for one screen,
 * and `?open=` is already how this module deep-links an order.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN DOES NOT DECIDE
 * ---------------------------------------------------------------------------
 *
 * Which stages a viewer may see is the SERVER's answer, not this component's.
 * `stageBoard` applies the caller's role scope, so an Import Team account is
 * handed counts only from its floor stage upward and the rail renders what it
 * was given. A client-side filter here would be a second, weaker copy of a rule
 * the service already enforces on every read path.
 */

const PAGE_SIZE = 25;

export function StagesTab() {
  const [params, setParams] = useSearchParams();

  const [board, setBoard] = useState(null);
  const [boardError, setBoardError] = useState(null);

  /**
   * Which question this stage's list answers.
   *
   *   passed  everything that has been through here, finished or not
   *   now     only what is sitting here at this moment
   *
   * `passed` is the default. An order is ONE record with twelve stage rows
   * that are never deleted, and grouping the board by `currentStage` made
   * the screen contradict that — an order completed at stage 2 vanished
   * from stage 2 as though it had been moved out of it.
   */
  const [scope, setScope] = useState("passed");
  const [rows, setRows] = useState({ data: [], total: 0 });
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);

  /**
   * The stage in the URL, if it is one the board actually has.
   *
   * Validated against the board rather than against `1..12`, because the board
   * is what the server decided this viewer may see — `?stage=2` typed by an
   * Import Team account must not select a tab that is not on their rail.
   *
   * Falls back to the first stage with work in it, so landing on the screen
   * shows something rather than an empty table for a quiet stage.
   */
  const selected = useMemo(() => {
    if (!board?.length) return null;
    const asked = Number(params.get("stage"));
    if (board.some((s) => s.stageNumber === asked)) return asked;
    return (board.find((s) => s.total > 0) ?? board[0]).stageNumber;
  }, [board, params]);

  const selectStage = (stageNumber) => {
    const next = new URLSearchParams(params);
    next.set("stage", String(stageNumber));
    // The open order is a different stage's, so it goes when the stage does.
    next.delete("open");
    setParams(next, { replace: true });
    setPage(1);
  };

  const loadBoard = useCallback(async () => {
    setBoardError(null);
    try {
      setBoard(await o2dApi.stageBoard());
    } catch (err) {
      setBoardError(err instanceof O2dApiError ? err : new O2dApiError(err.message));
      setBoard([]);
    }
  }, []);

  useEffect(() => { loadBoard(); }, [loadBoard]);

  const load = useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    try {
      setRows(
        await o2dApi.list({
          page,
          pageSize: PAGE_SIZE,
          // `stageReached` asks what has passed through; `currentStage` asks
          // what is here now. The default is the first.
          ...(scope === "now" ? { currentStage: selected } : { stageReached: selected }),
          /*
            Every status, not just the live ones.

            `listOrders` defaults to OPEN + ON_HOLD, which is right for a work
            tracker and wrong here: a stage's record of what it handled must
            not empty out as those orders are delivered.
          */
          status: ALL_STATUSES,
          search: search || undefined,
        }),
      );
    } catch (err) {
      setError(err instanceof O2dApiError ? err : new O2dApiError(err.message));
    } finally {
      setLoading(false);
    }
  }, [selected, page, scope, search]);

  useEffect(() => {
    const t = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const active = board?.find((s) => s.stageNumber === selected) ?? null;

  const columns = useMemo(
    () => [
      {
        header: "PO",
        cell: (row) => (
          <div>
            <p className="font-medium text-slate-900">{row.poNumber}</p>
            <p className="text-xs text-slate-500">{row.customerName}</p>
          </div>
        ),
      },
      { header: "PO date", cell: (row) => formatDate(row.poDate) },
      {
        /*
          The status AT THIS STAGE, which is the column the screen is for — an
          order can be Completed here and still In Progress overall, and the
          order-level badge below cannot say that.
        */
        header: "This stage",
        cell: (row) =>
          row.stageStatus ? (
            <div>
              <StageBadge status={row.stageStatus.status} />
              {row.stageStatus.actualCompletion && (
                <p className="mt-0.5 text-[11px] text-slate-400">
                  {formatDateTime(row.stageStatus.actualCompletion)}
                  {row.stageStatus.completedByName ? ` · ${row.stageStatus.completedByName}` : ""}
                </p>
              )}
            </div>
          ) : (
            <span className="text-xs text-slate-400">—</span>
          ),
      },
      { header: "Order", cell: (row) => <OrderStatusBadge status={row.status} /> },
      {
        header: "Promise",
        cell: (row) =>
          row.promiseDate ? (
            <div>
              <p className="text-sm">{formatDate(row.promiseDate)}</p>
              <p className="text-xs text-slate-500">{formatRelative(row.promiseDate)}</p>
            </div>
          ) : (
            <span className="text-xs text-amber-700">None — overridden</span>
          ),
      },
      { header: "Created", cell: (row) => formatDateTime(row.createdAt) },
    ],
    [],
  );

  if (boardError) {
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        <p>{boardError.message}</p>
        <button type="button" className="mt-1 text-xs font-medium underline" onClick={loadBoard}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <>
      {/*
        The rail. Horizontally scrollable rather than wrapped: twelve stages in
        a fixed order read as a pipeline, and wrapping them into three ragged
        rows loses the sequence that is the whole point of numbering them.
      */}
      <StageRail stages={board ?? []} selected={selected} onSelect={selectStage} />

      {active && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
          <span>
            Owner: <span className="font-medium text-slate-800">{active.ownerRole}</span>
          </span>
          <span>{active.total} order{active.total === 1 ? "" : "s"} at this stage</span>
          {active.overdue > 0 && (
            <span className="font-medium text-red-700">{active.overdue} overdue</span>
          )}
          {active.dueSoon > 0 && (
            <span className="font-medium text-amber-700">{active.dueSoon} due soon</span>
          )}
          {active.onHold > 0 && <span className="text-slate-500">{active.onHold} on hold</span>}
        </div>
      )}

      {/*
        Which question the list answers. Two chips rather than a dropdown: there
        are exactly two readings and both deserve to be one click away.
      */}
      <div className="flex flex-wrap gap-2">
        {[
          { key: "passed", label: "Passed through" },
          { key: "now", label: "Here now" },
        ].map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => {
              setScope(chip.key);
              setPage(1);
            }}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              scope === chip.key
                ? "border-primary-600 bg-primary-50 text-primary-700"
                : "border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <FilterBar
        search={search}
        onSearchChange={(v) => {
          setSearch(v);
          setPage(1);
        }}
        searchPlaceholder="Search by PO, customer or invoice…"
        onReset={() => {
          setSearch("");
          setPage(1);
        }}
      />

      <HrmsDataTable
        columns={columns}
        rows={rows.data}
        loading={loading || board === null}
        error={error}
        onRetry={load}
        page={page}
        pageSize={PAGE_SIZE}
        total={rows.total}
        onPageChange={setPage}
        rowKey={(row) => row._id}
        onRowClick={(row) => setOpenId(row._id)}
        emptyTitle={active ? `Nothing at ${active.name}` : "No stages to show"}
        emptyDescription={
          active
            ? `No live order is waiting at stage ${active.stageNumber}.`
            : "You do not have visibility of any workflow stage."
        }
      />

      {openId && (
        <OrderDrawer
          orderId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            // Completing a stage MOVES the order off this tab, so the rail's
            // counts are stale the moment anything is worked from here. Both
            // are reloaded, not just the list.
            load();
            loadBoard();
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The rail
// ---------------------------------------------------------------------------

/**
 * How much of the visible width one arrow press moves — a little under a page,
 * so the tab you were looking at stays on screen as an anchor.
 */
const SCROLL_STEP = 0.8;

/**
 * The twelve stages as one horizontally scrollable strip.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NATIVE SCROLLBAR IS HIDDEN AND REPLACED
 * ---------------------------------------------------------------------------
 *
 * A bare `overflow-x-auto` renders the OS scrollbar, and on Windows that is a
 * full-width grey trough sitting between the rail and the content — visually
 * heavier than the tabs it serves, and it reads as a divider, which is exactly
 * the wrong signal directly beneath a tab strip.
 *
 * Hiding a scrollbar is only safe if the overflow is announced some other way,
 * or the rail silently truncates. Three things replace it:
 *
 *   ARROW BUTTONS at each end, rendered ONLY in the direction that can actually
 *     move. A permanently visible arrow that does nothing at the end of the
 *     list teaches people to ignore both arrows.
 *   EDGE FADES beside those arrows, so a half-cut tab looks deliberately cut
 *     rather than clipped by a layout bug.
 *   THE WHEEL and the trackpad, unchanged — the element still scrolls natively;
 *     this only changes what is painted.
 *
 * `UserAccessModal` makes the opposite call for its vertical list, and says why:
 * there the scrollbar IS the only affordance. Here there are three others.
 *
 * ---------------------------------------------------------------------------
 * KEYBOARD
 * ---------------------------------------------------------------------------
 *
 * `role="tablist"` promises arrow-key navigation, and a screen reader announces
 * it whether or not it works. Left/Right move between stages, Home and End jump
 * to the ends, and only the selected tab sits in the tab order — otherwise
 * reaching the table below would cost twelve Tab presses.
 */
function StageRail({ stages, selected, onSelect }) {
  const scrollerRef = useRef(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  /** Which ends can still move — decides whether each arrow exists at all. */
  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // 1px of slack: a trackpad leaves fractional scroll positions, which would
    // otherwise keep an arrow alive at an end that cannot actually move.
    const max = el.scrollWidth - el.clientWidth;
    setOverflow({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;

    measure();
    el.addEventListener("scroll", measure, { passive: true });

    // The rail's overflow changes with the WINDOW, not only with the data —
    // collapsing the sidebar or resizing the browser must bring the arrows
    // back. Guarded because jsdom has no ResizeObserver.
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(el);

    return () => {
      el.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [measure, stages.length]);

  /**
   * Bring the selected stage into view.
   *
   * Matters most for a pasted link: `?stage=11` selects a tab that is off the
   * right-hand edge on most screens, and without this the rail opens looking as
   * though nothing is selected at all.
   *
   * Feature-checked because jsdom does not implement `scrollIntoView`.
   */
  useEffect(() => {
    const tab = scrollerRef.current?.querySelector('[aria-selected="true"]');
    if (typeof tab?.scrollIntoView === "function") {
      tab.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
  }, [selected, stages.length]);

  const nudge = (direction) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * SCROLL_STEP, behavior: "smooth" });
  };

  const onKeyDown = (event) => {
    const index = stages.findIndex((s) => s.stageNumber === selected);
    if (index < 0) return;

    const target = {
      ArrowLeft: index - 1,
      ArrowRight: index + 1,
      Home: 0,
      End: stages.length - 1,
    }[event.key];

    if (target === undefined) return;

    // Clamped rather than wrapped: the stages are a pipeline, and jumping from
    // stage 12 back to stage 1 on one keypress misrepresents the shape of it.
    const next = stages[Math.max(0, Math.min(stages.length - 1, target))];
    if (!next || next.stageNumber === selected) return;

    event.preventDefault();
    onSelect(next.stageNumber);
  };

  /**
   * The arrow affordance.
   *
   * `aria-hidden` and out of the tab order on purpose: it scrolls, it does not
   * navigate. A keyboard user moves between stages with the arrow keys, which
   * also scrolls the rail — so exposing this would be a second control for
   * something already reachable, announced as an unlabelled button.
   */
  const Arrow = ({ side }) => (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      onClick={() => nudge(side === "left" ? -1 : 1)}
      className={`absolute ${side === "left" ? "left-0" : "right-0"} top-0 bottom-px z-20
                  flex w-7 items-center justify-center bg-white text-slate-400
                  transition-colors hover:text-slate-700`}
    >
      {side === "left" ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
    </button>
  );

  return (
    /*
      `relative` so the arrows and fades can overlay the strip, and the bottom
      border lives HERE rather than on the scroller — on the scroller it would
      travel with the content and the strip would lose its baseline.
    */
    <div className="relative border-b border-slate-200">
      {overflow.left && (
        <>
          <Arrow side="left" />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-7 top-0 bottom-px z-10 w-8
                       bg-gradient-to-r from-white to-transparent"
          />
        </>
      )}

      <div
        ref={scrollerRef}
        role="tablist"
        aria-label="Workflow stages"
        onKeyDown={onKeyDown}
        className="flex gap-1 overflow-x-auto scroll-smooth
                   [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
      >
        {stages.map((stage) => {
          const isActive = stage.stageNumber === selected;
          return (
            <button
              key={stage.stageNumber}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onSelect(stage.stageNumber)}
              title={`${stage.name} — owned by ${stage.ownerRole}`}
              className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium
                          outline-none transition-colors focus-visible:bg-primary-50 ${
                            isActive
                              ? "border-primary-600 text-primary-700"
                              : "border-transparent text-slate-500 hover:text-slate-700"
                          }`}
            >
              <span className="tabular-nums">{stage.stageNumber}.</span> {stage.name}
              {/*
                The count is part of the tab, not a detail inside it: "which
                stage is the work stuck at" is answerable from the rail alone,
                which is what a manager opens this screen to find out.
              */}
              <span
                className={`ml-1.5 rounded-full px-1.5 py-0.5 text-xs tabular-nums ${
                  stage.overdue > 0
                    ? "bg-red-100 text-red-700"
                    : stage.total > 0
                      ? "bg-slate-100 text-slate-600"
                      : "bg-slate-50 text-slate-400"
                }`}
              >
                {stage.total}
              </span>
            </button>
          );
        })}
      </div>

      {overflow.right && (
        <>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute right-7 top-0 bottom-px z-10 w-8
                       bg-gradient-to-l from-white to-transparent"
          />
          <Arrow side="right" />
        </>
      )}
    </div>
  );
}
