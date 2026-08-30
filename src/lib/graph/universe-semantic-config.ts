export function isUniverseSemanticNeighborsEnabled(): boolean {
  const configured = process.env.MC_UNIVERSE_SEMANTIC_NEIGHBORS_ENABLED?.trim();
  return configured === undefined || !/^(0|false|no|off)$/i.test(configured);
}

export function isUniverseClustersEnabled(): boolean {
  const configured = process.env.MC_UNIVERSE_CLUSTERS_ENABLED?.trim();
  return configured === undefined || !/^(0|false|no|off)$/i.test(configured);
}
