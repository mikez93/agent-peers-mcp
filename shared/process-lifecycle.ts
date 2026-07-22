export function parentProcessWasLost(initialParentPid: number, currentParentPid: number): boolean {
  return initialParentPid > 1 && currentParentPid === 1;
}
