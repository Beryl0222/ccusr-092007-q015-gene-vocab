/**
 * 有向图工具：同源关系可能被错误来源连成链（A≈B、B≈C、C≈A），
 * 导入前与复核时都要能给出环上的具体节点，供专家判断是合并错误还是多祖证据。
 *
 * 图以邻接表表达：Map<node, Set<target>>。
 */

export function buildAdjacency(edges) {
  const graph = new Map();
  const ensure = (node) => {
    let set = graph.get(node);
    if (!set) {
      set = new Set();
      graph.set(node, set);
    }
    return set;
  };
  for (const { from, to } of edges) {
    ensure(from).add(to);
    ensure(to);
  }
  return graph;
}

/**
 * 返回找到的第一个环（节点序列，首尾相同），无环返回 null。
 * 迭代式 DFS，含颜色标记与父指针，避免深递归。
 */
export function findCycle(graph) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  const parent = new Map();
  for (const node of graph.keys()) color.set(node, WHITE);

  for (const start of graph.keys()) {
    if (color.get(start) !== WHITE) continue;
    const stack = [{ node: start, edges: [...(graph.get(start) ?? [])] }];
    color.set(start, GRAY);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const next = frame.edges.pop();
      if (next === undefined) {
        color.set(frame.node, BLACK);
        stack.pop();
        continue;
      }
      const nextColor = color.get(next) ?? WHITE;
      if (nextColor === WHITE) {
        color.set(next, GRAY);
        parent.set(next, frame.node);
        stack.push({ node: next, edges: [...(graph.get(next) ?? [])] });
      } else if (nextColor === GRAY) {
        // 沿 parent 链回溯到 next，重建环。
        const path = [next, frame.node];
        let cursor = frame.node;
        while (cursor !== next) {
          cursor = parent.get(cursor);
          if (cursor === undefined) break;
          path.push(cursor);
        }
        return path.reverse();
      }
    }
  }
  return null;
}

/**
 * 在已有边集上试加一条边，报告是否成环；用于候选关系逐条校验。
 * 返回成环路径或 null。
 */
export function cycleIfAdded(edges, candidate) {
  const graph = buildAdjacency(edges);
  const set = graph.get(candidate.from) ?? new Set();
  set.add(candidate.to);
  graph.set(candidate.from, set);
  if (!graph.has(candidate.to)) graph.set(candidate.to, new Set());
  return findCycle(graph);
}
