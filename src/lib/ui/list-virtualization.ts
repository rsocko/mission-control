export const VIRTUALIZATION_THRESHOLD = 50;

export function shouldVirtualizeList(itemCount: number): boolean {
  return itemCount > VIRTUALIZATION_THRESHOLD;
}
