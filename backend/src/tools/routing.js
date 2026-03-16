/**
 * AEGIS Routing Tool
 * ─────────────────────────────────────────────────────────────────────────────
 * Dijkstra shortest-path on the live Delhi city graph.
 * Graph is rebuilt fresh on every call — road blocks take effect immediately.
 */

import Graph   from 'graphology';
import dijkstra from 'graphology-shortest-path/dijkstra.js';
import { worldState } from '../core/worldState.js';
import { logger } from '../utils/logger.js';

function buildLiveGraph() {
  const cityGraph = worldState.getCityGraph();
  const graph     = new Graph({ type: 'undirected', multi: false });

  cityGraph.nodes.forEach(node => {
    graph.addNode(node.id, { ...node });
  });

  cityGraph.edges.forEach(edge => {
    if (!edge.blocked && edge.weight < 999999) {
      try {
        graph.addEdge(edge.from, edge.to, {
          id:     edge.id,
          weight: edge.weight,
          name:   edge.name,
        });
      } catch {
        // Undirected graph — duplicate edge silently ignored
      }
    }
  });

  return { graph, cityGraph };
}

/**
 * Tool: getRoute
 * Returns the fastest driving route between two Delhi zones.
 * Automatically avoids blocked roads (bridge collapses, road closures).
 */
export async function getRoute({ origin, destination }) {
  logger.tool('getRoute', { origin, destination });

  try {
    const { graph, cityGraph } = buildLiveGraph();
    const nodeMap = Object.fromEntries(cityGraph.nodes.map(n => [n.id, n]));

    if (!graph.hasNode(origin)) {
      return { success: false, error: `Zone '${origin}' not found. Valid zones: ${Object.keys(nodeMap).join(', ')}` };
    }
    if (!graph.hasNode(destination)) {
      return { success: false, error: `Zone '${destination}' not found. Valid zones: ${Object.keys(nodeMap).join(', ')}` };
    }

    if (origin === destination) {
      return {
        success: true, origin, destination,
        path: [origin], pathNames: [nodeMap[origin]?.name],
        segments: [], totalTimeMinutes: 0,
        note: 'Unit already at destination zone',
      };
    }

    const path = dijkstra.bidirectional(graph, origin, destination, 'weight');

    if (!path || path.length === 0) {
      const blocked = worldState.getBlockedEdges();
      return {
        success: false,
        error:   `No route available from ${origin} to ${destination}. All paths are blocked.`,
        blockedEdges: blocked,
        suggestion:  'Wait for road restoration or reposition units to an adjacent zone.',
      };
    }

    // Build rich segment breakdown
    let totalTime = 0;
    const segments = [];

    for (let i = 0; i < path.length - 1; i++) {
      const edgeKey = graph.edge(path[i], path[i + 1]);
      const attrs   = edgeKey ? graph.getEdgeAttributes(edgeKey) : { weight: 10, name: 'local roads' };
      totalTime += attrs.weight;
      segments.push({
        from:     path[i],
        fromName: nodeMap[path[i]]?.name  || path[i],
        to:       path[i + 1],
        toName:   nodeMap[path[i + 1]]?.name || path[i + 1],
        road:     attrs.name,
        timeMin:  attrs.weight,
      });
    }

    return {
      success: true,
      origin,  destination,
      originName:      nodeMap[origin]?.name,
      destinationName: nodeMap[destination]?.name,
      path, pathNames: path.map(id => nodeMap[id]?.name || id),
      segments, totalTimeMinutes: totalTime,
      hops: path.length - 1,
    };

  } catch (err) {
    logger.error('getRoute error:', err.message);
    return { success: false, error: `Routing failed: ${err.message}` };
  }
}

/**
 * Tool: blockRoad
 * Marks a road edge as impassable. All future routing avoids it.
 * Triggers automatic replan for active incidents.
 */
export async function blockRoad({ edgeId, reason }) {
  logger.tool('blockRoad', { edgeId, reason });

  const result = worldState.blockEdge(edgeId);
  const graph  = worldState.getCityGraph();
  const edge   = graph?.edges.find(e => e.id === edgeId);

  return {
    success:        true,
    blocked:        edgeId,
    edgeName:       edge?.name    || edgeId,
    from:           edge?.from,
    to:             edge?.to,
    reason,
    alreadyBlocked: result.alreadyBlocked || false,
    replanTriggered: !result.alreadyBlocked,
    message: result.alreadyBlocked
      ? `${edge?.name || edgeId} was already blocked.`
      : `${edge?.name || edgeId} is now CLOSED. All routing reroutes around it. Active units will be recalled and rerouted.`,
  };
}

// ─── Groq Function Schemas ────────────────────────────────────────────────────

const ZONE_ENUM = ['CP','RP','KB','LN','DW','RH','SD','NP','IGI','OKH'];

export const getRouteSchema = {
  type: 'function',
  function: {
    name: 'getRoute',
    description: 'Calculate the fastest driving route between two Delhi city zones using Dijkstra shortest path. Automatically avoids blocked roads and collapsed bridges. Always call this before dispatching a unit to confirm travel time.',
    parameters: {
      type: 'object',
      properties: {
        origin:      { type: 'string', description: 'Origin zone ID.',      enum: ZONE_ENUM },
        destination: { type: 'string', description: 'Destination zone ID.', enum: ZONE_ENUM },
      },
      required: ['origin', 'destination'],
    },
  },
};

export const blockRoadSchema = {
  type: 'function',
  function: {
    name: 'blockRoad',
    description: 'Block a road or bridge due to structural collapse, flooding, or major incident. All routing immediately reroutes. Triggers system replan for active incidents. Key bridge: e5 = Yamuna Bridge (CP↔SD).',
    parameters: {
      type: 'object',
      properties: {
        edgeId: {
          type: 'string',
          description: 'Edge ID to block. e5 = Yamuna Bridge (CP↔SD). Use exact edge ID from city graph.',
          enum: ['e1','e2','e3','e4','e5','e6','e7','e8','e9','e10','e11','e12','e13','e14','e15','e16','e17','e18'],
        },
        reason: { type: 'string', description: 'Reason for blocking (e.g. "Structural collapse")' },
      },
      required: ['edgeId', 'reason'],
    },
  },
};