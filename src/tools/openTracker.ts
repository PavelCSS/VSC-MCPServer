const seen = new Set<string>();
const fresh = new Set<string>();

export function noteOpened(uri: string, byTool: boolean): void {
    if (seen.has(uri)) {
        return;
    }
    seen.add(uri);
    if (byTool) {
        fresh.add(uri);
    }
}

export function takeFreshlyOpened(uri: string): boolean {
    return fresh.delete(uri);
}

export function resetOpenTracker(): void {
    seen.clear();
    fresh.clear();
}
