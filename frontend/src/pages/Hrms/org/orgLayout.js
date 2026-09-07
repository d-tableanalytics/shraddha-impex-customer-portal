/**
 * Org chart layout.
 *
 * A port of the reference's layout engine (`OrgSettingsPage.tsx:50-116`) —
 * `buildTree`, `calcLayout`, `nudgeX`, `flatten`, `collectEdges` — kept as pure
 * functions so the geometry can be tested without rendering anything. The
 * reference's maths is sound; only its rendering is Ant Design, and none of
 * that is here.
 *
 * Coordinates are in pixels, origin top-left, before the canvas padding is
 * added. A parent sits centred over the span of its children; sibling subtrees
 * are packed left to right with a fixed gap; separate roots are packed the same
 * way.
 */

/** The reference's constants, kept identical so the chart reads the same. */
export const CARD_W = 172;
export const CARD_H = 96;
export const GAP_X = 36;
export const GAP_Y = 64;
export const PAD = 28;

/**
 * Group the flat list into trees.
 *
 * ---------------------------------------------------------------------------
 * Nothing is ever dropped
 * ---------------------------------------------------------------------------
 * The reference does `if (map.has(managerId)) attach; else roots.push(node)`.
 * That looks total, and is not: if the data ever contained a cycle, every node
 * in it would find a parent, none would be pushed as a root, and the whole
 * group would vanish from the chart — hiding precisely the people whose data is
 * broken.
 *
 * Our server breaks cycles before sending (`managerCycleBroken`), so this
 * should never fire. It is still handled, because "should never happen" is a
 * poor reason for people to disappear from an org chart. Anything unreachable
 * after the first pass is promoted to a root and marked `detached`.
 *
 * @param {object[]} nodes flat nodes from GET /hrms/org/tree
 * @returns {{ roots: object[], detached: number }}
 */
export function buildForest(nodes = []) {
  const byId = new Map(nodes.map((n) => [n.id, { ...n, children: [] }]));
  const roots = [];

  for (const node of nodes) {
    const self = byId.get(node.id);
    const parent = node.reportingManagerId ? byId.get(node.reportingManagerId) : null;
    if (parent && parent !== self) parent.children.push(self);
    else roots.push(self);
  }

  // Everything reachable from a root. Whatever is left was in a cycle.
  const seen = new Set();
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop();
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    stack.push(...node.children);
  }

  let detached = 0;
  for (const node of byId.values()) {
    if (seen.has(node.id)) continue;

    // Promoting alone is not enough: the ring would still be a ring, and
    // laying it out would recurse forever. Cut the incoming edge first, which
    // turns the cycle into a chain hanging off this node.
    const parent = node.reportingManagerId ? byId.get(node.reportingManagerId) : null;
    if (parent) parent.children = parent.children.filter((child) => child !== node);

    node.detached = true;
    roots.push(node);
    detached += 1;

    // Claim the subtree that just became reachable, so the rest of the ring is
    // not promoted node by node.
    const stack2 = [node];
    while (stack2.length > 0) {
      const current = stack2.pop();
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      stack2.push(...current.children);
    }
  }

  return { roots, detached };
}

/** Shift a positioned subtree horizontally. */
function nudge(pos, dx) {
  pos.x += dx;
  for (const child of pos.children) nudge(child, dx);
}

/**
 * Position one tree, its own left edge at x = 0.
 *
 * A leaf occupies one card width. A parent spans its children and centres over
 * the midpoint of the first and last, which is what keeps a lopsided tree from
 * leaning.
 */
function layoutTree(node, depth) {
  const y = depth * (CARD_H + GAP_Y);

  if (node.children.length === 0) {
    return { node, x: CARD_W / 2, y, subtreeW: CARD_W, children: [] };
  }

  let cursor = 0;
  const children = [];
  for (const child of node.children) {
    const positioned = layoutTree(child, depth + 1);
    nudge(positioned, cursor);
    cursor += positioned.subtreeW + GAP_X;
    children.push(positioned);
  }

  const spanned = cursor - GAP_X;
  const centre = (children[0].x + children[children.length - 1].x) / 2;

  return { node, x: centre, y, subtreeW: Math.max(spanned, CARD_W), children };
}

const flatten = (pos) => [pos, ...pos.children.flatMap(flatten)];

/** Parent-bottom to child-top, for the SVG connector layer. */
const collectEdges = (pos) =>
  pos.children.flatMap((child) => [
    { fromX: pos.x, fromY: pos.y + CARD_H, toX: child.x, toY: child.y, key: `${pos.node.id}-${child.node.id}` },
    ...collectEdges(child),
  ]);

/**
 * Lay out every tree side by side.
 *
 * @param {object[]} roots from `buildForest`
 * @returns {{ cards: object[], edges: object[], width: number, height: number }}
 *   coordinates already include the canvas padding, so a caller can position
 *   directly.
 */
export function layoutForest(roots = []) {
  if (roots.length === 0) return { cards: [], edges: [], width: 0, height: 0 };

  let cursor = 0;
  const positioned = [];
  for (const root of roots) {
    const tree = layoutTree(root, 0);
    nudge(tree, cursor);
    cursor += tree.subtreeW + GAP_X;
    positioned.push(tree);
  }

  const all = positioned.flatMap(flatten);
  const edges = positioned.flatMap(collectEdges);

  return {
    cards: all.map((pos) => ({
      node: pos.node,
      // Cards are positioned by their top-left corner; `x` is their centre.
      left: pos.x - CARD_W / 2 + PAD,
      top: pos.y + PAD,
    })),
    edges: edges.map((e) => ({
      ...e,
      fromX: e.fromX + PAD,
      fromY: e.fromY + PAD,
      toX: e.toX + PAD,
      toY: e.toY + PAD,
    })),
    width: cursor - GAP_X + PAD * 2,
    height: Math.max(...all.map((p) => p.y)) + CARD_H + PAD * 2,
  };
}

/** A cubic curve that leaves the parent downward and arrives at the child. */
export const edgePath = (e) => {
  const midY = (e.fromY + e.toY) / 2;
  return `M ${e.fromX} ${e.fromY} C ${e.fromX} ${midY}, ${e.toX} ${midY}, ${e.toX} ${e.toY}`;
};

/** Up to two initials, the reference's avatar fallback. */
export const initialsOf = (name) =>
  (name || "?")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();

export default { buildForest, layoutForest, edgePath, initialsOf };
