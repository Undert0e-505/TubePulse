export function updatePillAnimationDecision({
  hasUpdate,
  visitId,
  handledVisitId,
  preferenceReady,
  reduceMotion,
}) {
  if (!hasUpdate || visitId <= 0 || handledVisitId === visitId) return 'none';
  if (!preferenceReady) return 'wait';
  return reduceMotion ? 'settle' : 'animate';
}
