/*
 * Why changed: normalize route output into lat/lng points so websocket consumers can draw reroutes without guessing payload shape.
 * Security rationale: coordinator broadcasts now carry explicit route geometry, reducing hidden coupling between backend routing and frontend map rendering.
 */
import Graph from 'graphology';
import dijkstra from 'graphology-shortest-path/dijkstra.js';
import { worldState } from '../core/worldState.js';
import { logger } from '../utils/logger.js';

function buildLiveGraph() {
  const cityGraph = worldState.getCityGraph();
  const graph = new Graph({ type: 'undirected', multi: false });

  cityGraph.nodes.forEach(node => {
    graph.addNode(node.id, { ...node });
  });

  cityGraph.edges.forEach(edge => {
    if (!edge.blocked && edge.weight < 999999) {
      try {
        graph.addEdge(edge.from, edge.to, {
          id: edge.id,
          weight: edge.weight,
          name: edge.name,
        });
      } catch {
        // Duplicate edge ignored in undirected graph.
      }
    }
  });

  return { graph, cityGraph };
}

function haversineMeters(a, b) {
  const toRad = value => (value * Math.PI) / 180;
  const earthRadius = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const term =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * earthRadius * Math.atan2(Math.sqrt(term), Math.sqrt(1 - term));
}

export function normalizePath(rawPath) {
  if (!rawPath) {
    return [];
  }

  if (rawPath.type === 'LineString' && Array.isArray(rawPath.coordinates)) {
    return rawPath.coordinates.map(point => ({ lat: point[1], lng: point[0] }));
  }

  if (Array.isArray(rawPath) && rawPath.length > 0) {
    if (typeof rawPath[0] === 'string') {
      return rawPath
        .map(zoneId => worldState.getCityGraph()?.nodes.find(node => node.id === zoneId))
        .filter(Boolean)
        .map(node => ({ lat: node.lat, lng: node.lng, zone: node.id, name: node.name }));
    }

    return rawPath.map(point => {
      if (Array.isArray(point)) {
        const [first, second] = point;
        const looksLikeLngLat = Math.abs(first) > 60 && Math.abs(second) < 60;
        return looksLikeLngLat
          ? { lat: second, lng: first }
          : { lat: first, lng: second };
      }

      return {
        lat: point.lat ?? point.latitude ?? point[1],
        lng: point.lng ?? point.longitude ?? point[0],
        ...(point.zone ? { zone: point.zone } : {}),
        ...(point.name ? { name: point.name } : {}),
      };
    });
  }

  return [];
}

function calculateDistanceMeters(pathCoordinates) {
  let distanceMeters = 0;
  for (let i = 0; i < pathCoordinates.length - 1; i++) {
    distanceMeters += haversineMeters(pathCoordinates[i], pathCoordinates[i + 1]);
  }
  return Math.round(distanceMeters);
}

export async function getRoute({ origin, destination }) {
  logger.tool('getRoute', { origin, destination });

  try {
    const { graph, cityGraph } = buildLiveGraph();
    const nodeMap = Object.fromEntries(cityGraph.nodes.map(node => [node.id, node]));

    if (!graph.hasNode(origin)) {
      return { success: false, error: `Zone '${origin}' not found. Valid zones: ${Object.keys(nodeMap).join(', ')}` };
    }
    if (!graph.hasNode(destination)) {
      return { success: false, error: `Zone '${destination}' not found. Valid zones: ${Object.keys(nodeMap).join(', ')}` };
    }

    if (origin === destination) {
      const path = normalizePath([origin]);
      return {
        success: true,
        origin,
        destination,
        zonePath: [origin],
        path,
        geometry_type: 'latlng_array',
        pathNames: [nodeMap[origin]?.name],
        segments: [],
        totalTimeMinutes: 0,
        distanceMeters: 0,
        etaSeconds: 0,
        note: 'Unit already at destination zone',
      };
    }

    const zonePath = dijkstra.bidirectional(graph, origin, destination, 'weight');

    if (!zonePath || zonePath.length === 0) {
      const blocked = worldState.getBlockedEdges();
      return {
        success: false,
        error: `No route available from ${origin} to ${destination}. All paths are blocked.`,
        blockedEdges: blocked,
        suggestion: 'Wait for road restoration or reposition units to an adjacent zone.',
      };
    }

    let totalTime = 0;
    const segments = [];

    for (let i = 0; i < zonePath.length - 1; i++) {
      const edgeKey = graph.edge(zonePath[i], zonePath[i + 1]);
      const attrs = edgeKey ? graph.getEdgeAttributes(edgeKey) : { weight: 10, name: 'local roads' };
      totalTime += attrs.weight;
      segments.push({
        from: zonePath[i],
        fromName: nodeMap[zonePath[i]]?.name || zonePath[i],
        to: zonePath[i + 1],
        toName: nodeMap[zonePath[i + 1]]?.name || zonePath[i + 1],
        road: attrs.name,
        timeMin: attrs.weight,
      });
    }

    const path = normalizePath(zonePath);
    const distanceMeters = calculateDistanceMeters(path);
    const etaSeconds = totalTime * 60;

    logger.info(`[ROUTE] origin=${origin} destination=${destination} distance=${distanceMeters} eta=${etaSeconds} pathLen=${path.length}`);

    return {
      success: true,
      origin,
      destination,
      originName: nodeMap[origin]?.name,
      destinationName: nodeMap[destination]?.name,
      zonePath,
      path,
      geometry_type: 'latlng_array',
      pathNames: zonePath.map(id => nodeMap[id]?.name || id),
      segments,
      totalTimeMinutes: totalTime,
      distanceMeters,
      etaSeconds,
      hops: zonePath.length - 1,
    };
  } catch (err) {
    logger.error('getRoute error:', err.message);
    return { success: false, error: `Routing failed: ${err.message}` };
  }
}

export async function blockRoad({ edgeId, reason }) {
  logger.tool('blockRoad', { edgeId, reason });

  const result = worldState.blockEdge(edgeId);
  const graph = worldState.getCityGraph();
  const edge = graph?.edges.find(candidate => candidate.id === edgeId);

  return {
    success: true,
    blocked: edgeId,
    edgeName: edge?.name || edgeId,
    from: edge?.from,
    to: edge?.to,
    reason,
    alreadyBlocked: result.alreadyBlocked || false,
    replanTriggered: !result.alreadyBlocked,
    message: result.alreadyBlocked
      ? `${edge?.name || edgeId} was already blocked.`
      : `${edge?.name || edgeId} is now CLOSED. All routing reroutes around it. Active units will be recalled and rerouted.`,
  };
}

const ZONE_ENUM = ['CP', 'RP', 'KB', 'LN', 'DW', 'RH', 'SD', 'NP', 'IGI', 'OKH'];

export const getRouteSchema = {
  type: 'function',
  function: {
    name: 'getRoute',
    description: 'Calculate the fastest driving route between two Delhi city zones using Dijkstra shortest path. Automatically avoids blocked roads and collapsed bridges. Always call this before dispatching a unit to confirm travel time.',
    parameters: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'Origin zone ID.', enum: ZONE_ENUM },
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
    description: 'Block a road or bridge due to structural collapse, flooding, or major incident. All routing immediately reroutes. Triggers system replan for active incidents. Key bridge: e5 = Yamuna Bridge (CP<->SD).',
    parameters: {
      type: 'object',
      properties: {
        edgeId: {
          type: 'string',
          description: 'Edge ID to block. e5 = Yamuna Bridge (CP<->SD). Use exact edge ID from city graph.',
          enum: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9', 'e10', 'e11', 'e12', 'e13', 'e14', 'e15', 'e16', 'e17', 'e18'],
        },
        reason: { type: 'string', description: 'Reason for blocking (for example "Structural collapse")' },
      },
      required: ['edgeId', 'reason'],
    },
  },
};
